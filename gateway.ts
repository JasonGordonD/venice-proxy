require("dotenv").config();

import type { Request, Response, NextFunction } from 'express';
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VENICE_CHAT_URL = process.env.VENICE_CHAT_URL || "https://api.venice.ai/api/v1/chat/completions";
const MCP_HTTP_URL = process.env.MCP_HTTP_URL || null; // Optional

type JsonRpcRequest = {
  jsonrpc: string;
  method: string;
  params?: unknown;
  id?: string | number | null;
};
type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown };
type ChatPayload = { model?: string; messages: ChatMessage[]; stream?: boolean };

app.post("/chat/completions", async (req: Request, res: Response, _next: NextFunction) => {
  const body = req.body;

  // Restrict access to ElevenLabs only
  const clientHeader = req.headers['x-client'];
  if (clientHeader !== 'elevenlabs') {
    console.warn('🚫 Unauthorized client attempted access:', clientHeader);
    return res.status(403).json({ error: 'Access denied. Unauthorized client.' });
  }

  // Block MCP/JSON-RPC on chat route
  if (isJsonRpc(body)) {
    console.log('🛑 JSON-RPC (MCP) request received — rejecting');
    console.log('📦 Rejected Payload:', JSON.stringify(body, null, 2));
    console.log('📡 Headers:', JSON.stringify(req.headers, null, 2));
    return res.status(400).json({
      error: "JSON-RPC (MCP) request cannot be sent to chat endpoint. Route it to an MCP handler."
    });
  }

  // Validate chat payload
  if (!isChatPayload(body)) {
    return res.status(400).json({
      error: "Invalid chat request. 'messages' array is required."
    });
  }

  // Inject defaults (and ensure streaming is OFF)
  maybeInjectDefaultModel(body);

  // Hard-disable streaming regardless of client request
  if (body.stream === true) {
    console.warn("⚠️ Incoming request requested stream=true — forcing stream=false (streaming disabled)");
    body.stream = false;
  }

  console.log("📤 Sending modified request to Venice:", {
    model: body.model,
    stream: body.stream
  });

  try {
    const response = await fetch(VENICE_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    // Non-stream JSON path only
    if (!response.ok) {
      const text = await safeReadText(response);
      console.error('⬆️ Upstream non-OK:', response.status, text);
      return res
        .status(response.status)
        .json(mapUpstreamErrorToChatMessage({ message: text, status: response.status }));
    }

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    console.error("❌ Proxy error:", err);
    if (!res.headersSent) {
      return res.status(502).json(mapUpstreamErrorToChatMessage(err));
    }
  }
});

/** Helpers */

function isJsonRpc(b: any): b is JsonRpcRequest {
  return b && typeof b === 'object' && b.jsonrpc === '2.0' && 'method' in b;
}

function isChatPayload(b: any): b is ChatPayload {
  return b && typeof b === 'object' && Array.isArray(b.messages);
}

function maybeInjectDefaultModel(b: any) {
  if (!Array.isArray(b?.messages)) return;

  const DEFAULT_MODEL = process.env.DEFAULT_CHAT_MODEL || 'venice-uncensored';
  if (!b.model) {
    console.warn(`⚠️ No model found — injecting default model: ${DEFAULT_MODEL}`);
    b.model = DEFAULT_MODEL;
  }
  // Force streaming off by default
  b.stream = false;
}

function mapUpstreamErrorToChatMessage(err: unknown) {
  const msg =
    (err as any)?.issues?.[0]?.message ||
    (err as any)?.details?._errors?.[0] ||
    (err as any)?.message ||
    'Unknown error from upstream';

  return {
    error: 'Upstream error',
    details: err,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: `Error: ${msg}` },
        finish_reason: 'stop',
      },
    ],
  };
}

async function safeReadText(response: any): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
