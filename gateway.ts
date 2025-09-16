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

/**
 * Sanitize request body for Venice API
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

/**
 * Sanitize Venice response into pure OpenAI format
 */
function sanitizeResponse(data: any) {
  return {
    id: data.id,
    object: data.object,
    created: data.created,
    model: data.model,
    choices: data.choices,
    usage: data.usage,
  };
}

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

      if (!response.ok) {
        const text = await safeReadText(response);
        console.error("⬆️ Upstream non-OK:", response.status, text);
        return res
          .status(response.status)
          .json(
            mapUpstreamErrorToChatMessage({
              message: text,
              status: response.status,
            })
          );
      }

      const data = await response.json();
      const clean = sanitizeResponse(data);
      return res.status(response.status).json(clean);
    } catch (err) {
      console.error("❌ Proxy error:", err);
      if (!res.headersSent) {
        return res.status(502).json(mapUpstreamErrorToChatMessage(err));
      }
    }
  }
);

/** Helpers */

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
