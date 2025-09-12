import type { Request, Response, NextFunction } from 'express';

const VENICE_CHAT_URL = process.env.VENICE_CHAT_URL!;
const MCP_HTTP_URL = process.env.MCP_HTTP_URL; // if you support HTTP-based MCP

type JsonRpcRequest = {
  jsonrpc: string;
  method: string;
  params?: unknown;
  id?: string | number | null;
};

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown };
type ChatPayload = { model?: string; messages: ChatMessage[]; stream?: boolean };

export async function gateway(req: Request, res: Response, _next: NextFunction) {
  const body = req.body;

  if (isJsonRpc(body)) {
    console.log('🛣️ Detected MCP/JSON‑RPC — routing to MCP server (NOT to Venice).');
    return proxyToMcpJsonRpc(body, req, res);
  }

  if (!isChatPayload(body)) {
    return res.status(400).json({
      error: "Invalid payload: expected 'messages' array for chat, or 'jsonrpc' for MCP.",
    });
  }

  maybeInjectDefaultModel(body); // ✅ Only inject if it's a chat payload

  console.log('📤 Sending modified request to Venice:', {
    model: body.model,
    stream: body.stream ?? false,
  });

  try {
    const response = await fetch(VENICE_CHAT_URL, {
      method: 'POST',
      headers: { ...forwardAuthHeaders(req), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (err) {
    console.error('🧨 Error talking to Venice:', err);
    return res.status(502).json(mapUpstreamErrorToChatMessage(err)); // ✅ Improved
  }
}

/** Helpers */

function isJsonRpc(b: any): b is JsonRpcRequest {
  return b && typeof b === 'object' && b.jsonrpc === '2.0' && 'method' in b;
}

function isChatPayload(b: any): b is ChatPayload {
  return b && typeof b === 'object' && Array.isArray(b.messages);
}

// ✅ Updated: only inject model/stream if this is a valid chat payload
function maybeInjectDefaultModel(b: any) {
  if (!Array.isArray(b?.messages)) {
    return; // ❌ Don't inject into non-chat (e.g. MCP)
  }

  const DEFAULT_MODEL = process.env.DEFAULT_CHAT_MODEL || 'venice-uncensored';
  if (!b.model) {
    console.warn(`⚠️ No model found — injecting default model: ${DEFAULT_MODEL}`);
    b.model = DEFAULT_MODEL;
  }
  if (typeof b.stream === 'undefined') {
    b.stream = false;
  }
}

async function proxyToMcpJsonRpc(body: JsonRpcRequest, req: Request, res: Response) {
  if (!MCP_HTTP_URL) {
    return res.status(400).json({
      error: 'MCP/JSON-RPC not supported here. Route it to a separate MCP endpoint.',
    });
  }

  const r = await fetch(MCP_HTTP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await r.json();
  return res.status(r.status).json(json);
}

// ✅ Improved: return error message in assistant.content to avoid blank replies
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

function forwardAuthHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['authorization', 'x-api-key']) {
    const v = req.header(k);
    if (v) out[k] = v;
  }
  return out;
}
