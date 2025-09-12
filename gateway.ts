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

  // Inject defaults
  maybeInjectDefaultModel(body);

  const isStreaming = body.stream === true;
  console.log(
    isStreaming ? "📤 (stream) Sending request to Venice:" : "📤 Sending modified request to Venice:",
    { model: body.model, stream: body.stream }
  );

  try {
    if (isStreaming) {
      await streamFromVenice(body, req, res);
      return;
    }

    // Non-streaming JSON path
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
      return res
        .status(response.status)
        .json(mapUpstreamErrorToChatMessage({ message: text, status: response.status }));
    }

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    if ((err as any)?.name === 'AbortError' || (err as any)?.type === 'aborted') {
      console.warn('⛔ Client aborted; upstream fetch aborted safely.');
      try { if (!res.headersSent) res.end(); } catch {}
      return;
    }
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

/** SSE pass-through (flush headers first + heartbeat) */
async function streamFromVenice(body: any, req: Request, res: Response) {
  const controller = new AbortController();

  // 1) Immediately open SSE to the client (flush headers + prelude)
  try {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    // @ts-ignore
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }
    // Prelude so client sees bytes immediately
    res.write(": connected\n\n");
  } catch (e) {
    console.error('❌ Failed setting SSE headers/prelude:', e);
    return;
  }

  // 2) Heartbeat every 15s to keep intermediaries happy
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 15000);

  // 3) Abort upstream when client disconnects
  const onClientClose = () => {
    try { controller.abort(); } catch {}
    try { clearInterval(heartbeat); } catch {}
  };
  req.on('close', onClientClose);
  res.on('close', onClientClose);

  // 4) Now connect to upstream (Venice) and stream through
  let upstream: any;
  try {
    upstream = await fetch(VENICE_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.type === 'aborted') {
      console.warn('⛔ Upstream fetch aborted because client disconnected.');
      return;
    }
    console.error('❌ Upstream fetch error (stream path):', e);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e?.message || 'upstream fetch error' })}\n\n`);
    } catch {}
    return;
  }

  if (!upstream.ok) {
    const text = await safeReadText(upstream);
    console.error('⬆️ Upstream non-OK (stream path):', upstream.status, text);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status, message: text })}\n\n`);
      res.write("event: end\ndata: [DONE]\n\n");
      res.end();
    } catch {}
    return;
  }

  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    console.error("❌ Upstream body missing on stream path");
    try { res.write("event: error\ndata: {\"message\":\"no upstream body\"}\n\n"); } catch {}
    try { res.end(); } catch {}
    return;
  }

  upstreamBody.on('error', (e: any) => {
    console.error('❌ Upstream stream error:', e);
    try { res.write(`event: error\ndata: ${JSON.stringify({ message: 'upstream stream error' })}\n\n`); } catch {}
    try { res.end(); } catch {}
  });

  upstreamBody.on('end', () => {
    try { res.write("event: end\ndata: [DONE]\n\n"); } catch {}
    try { res.end(); } catch {}
    try { clearInterval(heartbeat); } catch {}
  });

  try {
    upstreamBody.pipe(res);
  } catch (e) {
    console.error('❌ Pipe error:', e);
    try { clearInterval(heartbeat); } catch {}
    try { res.end(); } catch {}
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
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

  // Inject defaults
  maybeInjectDefaultModel(body);

  const isStreaming = body.stream === true;
  console.log(
    isStreaming ? "📤 (stream) Sending request to Venice:" : "📤 Sending modified request to Venice:",
    { model: body.model, stream: body.stream }
  );

  try {
    if (isStreaming) {
      await streamFromVenice(body, req, res);
      return;
    }

    // Non-streaming JSON path
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
      return res
        .status(response.status)
        .json(mapUpstreamErrorToChatMessage({ message: text, status: response.status }));
    }

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    if ((err as any)?.name === 'AbortError' || (err as any)?.type === 'aborted') {
      console.warn('⛔ Client aborted; upstream fetch aborted safely.');
      try { if (!res.headersSent) res.end(); } catch {}
      return;
    }
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

/** SSE pass-through (flush headers first + heartbeat) */
async function streamFromVenice(body: any, req: Request, res: Response) {
  const controller = new AbortController();

  // 1) Immediately open SSE to the client (flush headers + prelude)
  try {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    // @ts-ignore
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }
    // Prelude so client sees bytes immediately
    res.write(": connected\n\n");
  } catch (e) {
    console.error('❌ Failed setting SSE headers/prelude:', e);
    return;
  }

  // 2) Heartbeat every 15s to keep intermediaries happy
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 15000);

  // 3) Abort upstream when client disconnects
  const onClientClose = () => {
    try { controller.abort(); } catch {}
    try { clearInterval(heartbeat); } catch {}
  };
  req.on('close', onClientClose);
  res.on('close', onClientClose);

  // 4) Now connect to upstream (Venice) and stream through
  let upstream: any;
  try {
    upstream = await fetch(VENICE_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.type === 'aborted') {
      console.warn('⛔ Upstream fetch aborted because client disconnected.');
      return;
    }
    console.error('❌ Upstream fetch error (stream path):', e);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e?.message || 'upstream fetch error' })}\n\n`);
    } catch {}
    return;
  }

  if (!upstream.ok) {
    const text = await safeReadText(upstream);
    console.error('⬆️ Upstream non-OK (stream path):', upstream.status, text);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status, message: text })}\n\n`);
      res.write("event: end\ndata: [DONE]\n\n");
      res.end();
    } catch {}
    return;
  }

  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    console.error("❌ Upstream body missing on stream path");
    try { res.write("event: error\ndata: {\"message\":\"no upstream body\"}\n\n"); } catch {}
    try { res.end(); } catch {}
    return;
  }

  upstreamBody.on('error', (e: any) => {
    console.error('❌ Upstream stream error:', e);
    try { res.write(`event: error\ndata: ${JSON.stringify({ message: 'upstream stream error' })}\n\n`); } catch {}
    try { res.end(); } catch {}
  });

  upstreamBody.on('end', () => {
    try { res.write("event: end\ndata: [DONE]\n\n"); } catch {}
    try { res.end(); } catch {}
    try { clearInterval(heartbeat); } catch {}
  });

  try {
    upstreamBody.pipe(res);
  } catch (e) {
    console.error('❌ Pipe error:', e);
    try { clearInterval(heartbeat); } catch {}
    try { res.end(); } catch {}
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
