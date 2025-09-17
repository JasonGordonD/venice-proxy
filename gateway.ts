// gateway.ts – Venice Proxy for ElevenLabs (AbortError-safe, 20s timeout)

require("dotenv").config();

import type { Request, Response, NextFunction } from "express";
import express from "express";

const app = express();

// Allow large payloads (10mb limit)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const VENICE_CHAT_URL =
  process.env.VENICE_CHAT_URL || "https://api.venice.ai/api/v1/chat/completions";

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
    stream: false,
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

// --- Main Route ---

app.post("/chat/completions", async (req: Request, res: Response) => {
  const body = req.body;

  const clientHeader = req.headers["x-client"];
  if (clientHeader !== "elevenlabs") {
    console.warn("🚫 Unauthorized client:", clientHeader);
    return res.status(403).json({ error: "Access denied. Unauthorized client." });
  }

  if (isJsonRpc(body)) {
    return res.status(400).json({
      error: "JSON-RPC (MCP) request cannot be sent to chat endpoint.",
    });
  }

  if (!isChatPayload(body)) {
    return res.status(400).json({
      error: "Invalid chat request. 'messages' array is required.",
    });
  }

  const sanitizedBody = sanitizeChatBody(body);

  console.log("📤 Proxying to Venice:", {
    model: sanitizedBody.model,
    stream: sanitizedBody.stream,
    messages_count: sanitizedBody.messages.length,
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout

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
    console.debug("✅ Clean response:", JSON.stringify(clean, null, 2));
    return res.status(200).json(clean);
  } catch (err: any) {
    clearTimeout(timeout);

    if (err.name === "AbortError") {
      console.warn("⚠️ Venice API timeout after 20s");
      return res.status(504).json({
        error: "Timeout",
        message: "Venice API did not respond in time",
      });
    }

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

// --- Optional Error Handler ---

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Payload too large",
      message: "Request exceeds limit. Try reducing input size.",
    });
  }

  return res.status(500).json({
    error: "Internal server error",
    message: err.message || "Unexpected failure.",
  });
});

// --- Server Start ---

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Venice Proxy is live on port ${PORT}`);
});
