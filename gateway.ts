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

  // ✅ Restrict access to ElevenLabs only
  const clientHeader = req.headers['x-client'];
  if (clientHeader !== 'elevenlabs') {
    console.warn('🚫 Unauthorized client attempted access:', clientHeader);
    return res.status(403).json({ error: 'Access denied. Unauthorized client.' });
  }

  // ✅ Step 1: Block MCP (JSON-RPC) requests
  if (isJsonRpc(body)) {
    console.log('🛑 JSON-RPC (MCP) request received — rejecting');
    console.log('📦 Rejected Payload:', JSON.stringify(body, null, 2));
    console.log('📡 Headers:', JSON.stringify(req.headers, null, 2));
    return res.status(400).json({
      error: "JSON-RPC (MCP) request cannot be sent to chat endpoint. Route it to an MCP handler."
    });
  }

  // ✅ Step 2: Validate Chat Payload
  if (!isChatPayload(body)) {
    return res.status(400).json({
      error: "Invalid chat request. 'messages' array is required."
    });
  }

  // ✅ Step 3: Inject model and stream safely
  maybeInjectDefaultModel(body);

  // ✅ Step 4: Forward to Venice
  const isStreaming = body.stream === true;
  console.log(isStreaming
    ? "📤 (stream) Sending request to Venice:"
    : "📤 Sending modified request to Venice:",
  { model: body.model, stream: body.stream });

  try {
    if (isStreaming) {
      return streamFromVenice(body, req, res);
    } else {
      const response = await fetch(VENICE_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await safeReadText(response);
        console.error('⬆️ Upstream non-OK (JSON path):', response.status, text);
        return res.status(response.status).json(mapUpstreamErrorToChatMessage({ message: text, status: response.status }));
      }

      const data = await response.json();
      return res.status(response.status).json(data);
    }
  } catch (err) {
    console.error("❌ Proxy error:", err);
    return res.status(502).json(mapUpstreamErrorToChatMessage(err));
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
  if (typeof b.stream === 'undefined') {
    b.stream = false;
  }
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
        message: {
          role: 'assistant',
          content: `Error: ${msg}`,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

async function safeReadText(response: any): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** SSE pass-through for stream=true */
async function streamFromVenice(body: any, req: Request, res: Response) {
  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
  });

  const upstream = await fetch(VENICE_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream"
    },
    body: JSON.stringify(body),
    signal: controller.signal
  });

  if (!upstream.ok) {
    const text = await safeReadText(upstream);
    console.error('⬆️ Upstream non-OK (stream path):', upstream.status, text);
    return res.status(upstream.status).json(mapUpstreamErrorToChatMessage({ message: text, status: upstream.status }));
  }

  // Prepare SSE response to client
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  // @ts-ignore (not in Express types)
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  // Keep-alive comment (some clients like to see initial bytes)
  try {
    res.write(": connected\n\n");
  } catch {}

  const readable = upstream.body; // Node Readable stream
  if (!readable) {
    console.error("❌ Upstream body missing on stream path");
    res.end();
    return;
  }

  readable.on('error', (e: any) => {
    console.error('❌ Upstream stream error:', e);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'upstream stream error' })}\n\n`);
    } catch {}
    res.end();
  });

  readable.on('end', () => {
    try {
      res.write("event: end\ndata: [DONE]\n\n");
    } catch {}
    res.end();
  });

  // Pipe upstream SSE to client as-is
  readable.pipe(res);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
