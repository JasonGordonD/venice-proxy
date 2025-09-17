// gateway.ts (v3.3+) – Venice Proxy Gateway for ElevenLabs

require("dotenv").config();

import type { Request, Response, NextFunction } from "express";
import express from "express";
import fetch from "node-fetch";

const app = express();

// Allow larger payloads (fixes PayloadTooLargeError)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Constants
const VENICE_CHAT_URL =
  process.env.VENICE_CHAT_URL || "https://api.venice.ai/api/v1/chat/completions";

const PORT = process.env.PORT || 10000;

// Types
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

type ChatPayload = {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
};

// --- Body & Response Sanitizers ---

function sanitizeChatBody(b: any): ChatPayload {
  if (!b || typeof b !== "object") {
    return {
      model: process.env.DEFAULT_CHAT_MODEL || "venice-uncensored",
      messages: [],
      stream: false,
    };
  }

  const { model, messages } = b;

  return {
    model: model || process.env.DEFAULT_CHAT_MODEL || "venice-uncensored",
    messages: Array.isArray(messages) ? messages : [],
    stream: false, // streaming disabled for safety
  };
}

function sanitizeResponse(data: any) {
  const id = data?.id ?? `chatcmpl-${Date.now()}`;
  const object = "chat.completion";
  const created = data?.created ?? Math.floor(Date.now() / 1000);
  const model = data?.model ?? process.env.DEFAULT_CHAT_MODEL ?? "venice-uncensored";

  const rawChoices = Array.isArray(data?.choices) ? data.choices : [];
  const choices = rawChoices.map((choice: any) => {
    const msg = choice.message ?? choice.delta ?? {};
    return {
      index: typeof choice.index === "number" ? choice.index : 0,
      message: {
        role: msg.role ?? "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
      },
      finish_reason: choice.finish_reason ?? choice.stop_reason ?? "stop",
    };
  });

  return { id, object, created, model, choices };
}

// --- Main Chat Proxy Route ---

app.post("/chat/completions", async (req: Request, res: Response) => {
  const body = req.body;

  // Allowlist check
  const clientHeader = req.headers["x-client"];
  if (clientHeader !== "elevenlabs") {
    console.warn("🚫 Unauthorized client:", clientHeader);
    return res.status(403).json({ error: "Access denied. Unauthorized client." });
  }

  // Reject JSON-RPC payloads
  if (isJsonRpc(body)) {
    return res.status(400).json({
      error: "JSON-RPC (MCP) requests are not allowed here. Route to the MCP handler.",
    });
  }

  // Validate chat structure
  if (!isChatPayload(body)) {
    return res.status(400).json({
      error: "Invalid chat request. 'messages' array is required.",
    });
  }

  const sanitizedBody = sanitizeChatBody(body);

  console.log("📤 Proxying to Venice:", {
    model: sanitizedBody.model,
    messages_count: sanitizedBody.messages.length,
    stream: sanitizedBody.stream,
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(VENICE_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sanitizedBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const rawText = await safeReadText(response);
    let parsedData: any = {};

    try {
      parsedData = JSON.parse(rawText);
    } catch {
      parsedData = { text: rawText };
    }

    if (!response.ok) {
      console.error("⬆️ Upstream error:", response.status, rawText);
      return res
        .status(response.status)
        .json(mapUpstreamErrorToChatMessage({ message: rawText, status: response.status }));
    }

    const clean = sanitizeResponse(parsedData);
    console.debug("✅ Sanitized response:", JSON.stringify(clean, null, 2));
    return res.status(200).json(clean);
  } catch (err) {
    console.error("❌ Proxy error:", err);
    if (!res.headersSent) {
      return res.status(502).json(mapUpstreamErrorToChatMessage(err));
    }
  }
});

// --- Helpers ---

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

// --- Optional Global Error Handler ---

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Payload too large",
      message: "Request exceeds size limit. Please reduce payload size.",
    });
  }
  return res.status(500).json({
    error: "Internal server error",
    message: err.message || "Unexpected error occurred.",
  });
});

// --- Server Start ---

app.listen(PORT, () => {
  console.log(`🚀 Venice Proxy running on port ${PORT}`);
});
