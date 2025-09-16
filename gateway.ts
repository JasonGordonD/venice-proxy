// gateway.ts (v3)
require("dotenv").config();

import type { Request, Response, NextFunction } from "express";
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VENICE_CHAT_URL =
  process.env.VENICE_CHAT_URL ||
  "https://api.venice.ai/api/v1/chat/completions";

type JsonRpcRequest = {
  jsonrpc: string;
  method: string;
  params?: unknown;
  id?: string | number | null;
};
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};
type ChatPayload = { model?: string; messages: ChatMessage[]; stream?: boolean };

/** -----------------------------
 * Request sanitizer (whitelist)
 * ------------------------------
 */
function sanitizeChatBody(b: any) {
  if (!b || typeof b !== "object") return {};

  const { model, messages } = b;

  return {
    model: model || process.env.DEFAULT_CHAT_MODEL || "venice-uncensored",
    messages: Array.isArray(messages) ? messages : [],
    stream: false, // hard disable streaming
  };
}

/** -----------------------------
 * Response sanitizer (deep)
 * Return a strict OpenAI-style response
 * ------------------------------
 */
function sanitizeChoice(choice: any) {
  const idx = typeof choice.index === "number" ? choice.index : 0;
  const finish_reason = choice.finish_reason ?? choice.stop_reason ?? "stop";

  // message may be under choice.message or choice.delta for streaming (we expect message)
  const msg = choice.message ?? choice.delta ?? {};
  const role = msg.role ?? "assistant";
  const content =
    typeof msg.content === "string"
      ? msg.content
      : // sometimes content may be an object/array — stringify safely
        (msg.content ? JSON.stringify(msg.content) : "");

  return {
    index: idx,
    message: {
      role,
      content,
    },
    finish_reason,
  };
}

function sanitizeResponse(data: any) {
  // defensive defaults
  const id = data?.id ?? `chatcmpl-${Date.now()}`;
  const object = data?.object ?? "chat.completion";
  const created = data?.created ?? Math.floor(Date.now() / 1000);
  const model = data?.model ?? process.env.DEFAULT_CHAT_MODEL ?? "venice-uncensored";
  const usage = data?.usage ?? null;

  // ensure choices is an array and deep-clean each choice/message
  const rawChoices = Array.isArray(data?.choices) ? data.choices : [];
  const choices = rawChoices.map(sanitizeChoice);

  return {
    id,
    object,
    created,
    model,
    choices,
    usage,
  };
}

/** -----------------------------
 * Route: /chat/completions
 * ------------------------------
 */
app.post(
  "/chat/completions",
  async (req: Request, res: Response, _next: NextFunction) => {
    const body = req.body;

    // Restrict access to ElevenLabs only
    const clientHeader = req.headers["x-client"];
    if (clientHeader !== "elevenlabs") {
      console.warn("🚫 Unauthorized client attempted access:", clientHeader);
      return res
        .status(403)
        .json({ error: "Access denied. Unauthorized client." });
    }

    // Block MCP/JSON-RPC on chat route
    if (isJsonRpc(body)) {
      console.log("🛑 JSON-RPC (MCP) request received — rejecting");
      console.log("📦 Rejected Payload:", JSON.stringify(body, null, 2));
      console.log("📡 Headers:", JSON.stringify(req.headers, null, 2));
      return res.status(400).json({
        error:
          "JSON-RPC (MCP) request cannot be sent to chat endpoint. Route it to an MCP handler.",
      });
    }

    // Validate chat payload
    if (!isChatPayload(body)) {
      return res.status(400).json({
        error: "Invalid chat request. 'messages' array is required.",
      });
    }

    // Sanitize body before forwarding
    const sanitizedBody = sanitizeChatBody(body);

    console.log("📤 Sending sanitized request to Venice:", {
      model: sanitizedBody.model,
      stream: sanitizedBody.stream,
      messages_count: sanitizedBody.messages.length,
    });

    try {
      const response = await fetch(VENICE_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sanitizedBody),
      });

      const rawText = await safeReadText(response);
      // try parse raw JSON if possible
      let rawData: any = null;
      try {
        rawData = JSON.parse(rawText);
      } catch {
        rawData = { text: rawText };
      }

      // Log raw Venice response (useful for debugging — can be verbose)
      console.debug("⬇️ Raw Venice response:", JSON.stringify(rawData, null, 2));

      if (!response.ok) {
        console.error("⬆️ Upstream non-OK:", response.status, rawText);
        return res
          .status(response.status)
          .json(
            mapUpstreamErrorToChatMessage({
              message: rawText,
              status: response.status,
            })
          );
      }

      // Sanitize and return a strict OpenAI-style response
      const clean = sanitizeResponse(rawData);
      console.debug("🔧 Sanitized response (to client):", JSON.stringify(clean, null, 2));
      return res.status(200).json(clean);
    } catch (err) {
      console.error("❌ Proxy error:", err);
      if (!res.headersSent) {
        return res.status(502).json(mapUpstreamErrorToChatMessage(err));
      }
    }
  }
);

/** -----------------------------
 * Helpers
 * ------------------------------
 */
function isJsonRpc(b: any): b is JsonRpcRequest {
  return b && typeof b === "object" && b.jsonrpc === "2.0" && "method" in b;
}

function isChatPayload(b: any): b is ChatPayload {
  return b && typeof b === "object" && Array.isArray(b.messages);
}

function mapUpstreamErrorToChatMessage(err: unknown) {
  const msg =
    (err as any)?.issues?.[0]?.message ||
    (err as any)?.details?._errors?.[0] ||
    (err as any)?.message ||
    "Unknown error from upstream";

  return {
    error: "Upstream error",
    details: err,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `Error: ${msg}` },
        finish_reason: "stop",
      },
    ],
  };
}

async function safeReadText(response: any): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
