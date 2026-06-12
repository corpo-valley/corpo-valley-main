// MCP capability — a Model Context Protocol server, mounted at `/mcp`.
//
// This is the "users can connect to this project via MCP" capability. It
// exposes your project's tools to MCP-aware agents (Claude, Cursor, Codex…)
// over the streamable-HTTP transport. It ships one example tool (`whoami`)
// so the endpoint works the moment you enable it; add your own tools below.
//
// ── Authorization is baked in ────────────────────────────────────────────
// Unlike the website/database (which are gated by a browser Kratos session),
// /mcp is fronted by the platform's MCP gateway: it runs the OAuth flow with
// MCP clients (Claude, Cursor, …), validates the bearer token, and only then
// forwards the request here with the caller's id in the trusted `X-User-Id`
// header — plus `X-User-Email` and `X-CV-Perm`. This container never sees a
// token. The headers are trustworthy: the only route in is through the gateway,
// and a cross-project pod can't reach this container (egress NetworkPolicy).
// Scope any data by X-User-Id; per-user isolation is the default (CV_SHARED opts
// in to a shared view, for parity with the database capability).
//
// MCP access MIRRORS the site gate: the gateway admits anyone with `read` or
// above on this project (owner, a grant, or the site default). So a `read`
// caller CAN reach this server — PER-TOOL authorization is YOUR job, exactly
// like gating mutating website routes with requirePerm('write'). Each tool
// below declares a `minPerm` (read | write | admin, default read); the
// dispatcher hides tools above the caller's level from tools/list and refuses
// them on tools/call. `X-CV-Perm` carries the caller's level.
//
// We keep this transport-thin and dependency-light: a single
// JSON-RPC-over-HTTP endpoint, no session store, no extra dependencies. The
// MCP wire protocol is just JSON-RPC 2.0, so plain Express is enough. If you
// later need server-initiated notifications you can pull in
// `@modelcontextprotocol/sdk` and swap in its Streamable HTTP transport — the
// tool registry below won't change.

const express = require('express');

// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage -- CSRF is handled by csrfGuard below (Sec-Fetch-Site same-origin check); the csurf package the rule looks for is deprecated.
const app = express();
const PORT = process.env.PORT || 9000;
const SHARED = process.env.CV_SHARED === 'true';

app.use(express.json({ limit: '256kb' }));

// Permission ordering for the X-CV-Perm classes (see the header note). A caller
// may invoke a tool iff their level is >= the tool's minPerm.
const PERM_RANK = { read: 1, write: 2, admin: 3 };
// The caller's level from the trusted X-CV-Perm header. Missing/garbage → the
// lowest level (`read`), so an unexpected request can only reach read tools.
function callerPerm(req) {
  const p = String(req.get('X-CV-Perm') || '');
  return PERM_RANK[p] ? p : 'read';
}
function permits(perm, minPerm) {
  return PERM_RANK[perm] >= PERM_RANK[minPerm || 'read'];
}

// CSRF protection. The edge authenticates via an ambient Kratos session
// cookie; reject any unsafe request whose Sec-Fetch-Site marks it cross-site
// so a malicious page can't drive tool calls with the victim's cookie. The
// JSON-only body parser blocks simple cross-site form posts as a second layer.
function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const site = req.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'cross-site request blocked' } });
    return;
  }
  next();
}
app.use(csrfGuard);

// Build the set of tools this project exposes. Kept as a plain registry so
// the HTTP layer below stays tiny and the tools are easy to unit-test.
//
// Each tool receives (userId, args, perm) — the trusted caller id, the call
// arguments, and the caller's X-CV-Perm level. Scope data by userId. Declare a
// `minPerm` (read | write | admin) on any tool that mutates or exposes
// privileged data; it defaults to `read`. The dispatcher enforces it, so your
// handler can assume the caller cleared the bar — but still scope writes to
// THEIR OWN rows by userId unless they're `admin`.
const tools = {
  whoami: {
    description: 'Return the identity of the caller as seen by this project.',
    // No minPerm → defaults to `read`: any caller who can reach MCP may call it.
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler(userId, _args, perm) {
      return { user_id: userId, perm, shared: SHARED };
    },
  },

  // Example WRITE-gated tool. A `read` caller won't see it in tools/list and is
  // refused on tools/call; `write` and `admin` may invoke it.
  set_note: {
    description: 'Save a short note (requires write access).',
    minPerm: 'write',
    inputSchema: {
      type: 'object', required: ['text'],
      properties: { text: { type: 'string', maxLength: 500 } },
      additionalProperties: false,
    },
    handler(userId, args /*, perm */) {
      // Persist scoped to the caller (see the database capability for a real
      // store). Take owner_id from userId, NEVER from args.
      return { saved: true, owner_id: userId, text: String(args.text ?? '') };
    },
  },

  // Example ADMIN-gated tool — moderation across everyone's data.
  // purge_all: {
  //   description: 'Delete every note in the project (admin only).',
  //   minPerm: 'admin',
  //   inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  //   handler(userId, args, perm) { /* ... */ return { purged: true }; },
  // },
};

const SERVER_INFO = { name: 'corpo-valley-project-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-03-26';

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

app.post('/mcp', async (req, res) => {
  // The platform MCP gateway already authenticated the OAuth bearer and injected
  // the caller's id as X-User-Id. No header → the request didn't come through the
  // gateway, so refuse.
  const userId = req.get('X-User-Id');
  if (!userId) {
    res.status(401).json(rpcError(null, -32001, 'unauthenticated'));
    return;
  }
  const perm = callerPerm(req);

  const msg = req.body;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    res.json(rpcError(msg?.id, -32600, 'invalid JSON-RPC request'));
    return;
  }
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case 'initialize':
      res.json(rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }));
      return;
    case 'notifications/initialized':
    case 'initialized':
      res.status(202).end();
      return;
    case 'ping':
      res.json(rpcResult(msg.id, {}));
      return;
    case 'tools/list':
      // Only advertise tools the caller is allowed to invoke, so an agent never
      // sees a tool it would be refused on.
      res.json(rpcResult(msg.id, {
        tools: Object.entries(tools)
          .filter(([, t]) => permits(perm, t.minPerm))
          .map(([name, t]) => ({
            name, description: t.description, inputSchema: t.inputSchema,
          })),
      }));
      return;
    case 'tools/call': {
      const params = msg.params || {};
      const tool = params.name ? tools[params.name] : undefined;
      if (!tool) {
        res.json(rpcError(msg.id, -32601, `unknown tool: ${params.name}`));
        return;
      }
      // Per-tool authorization: refuse a caller below the tool's minPerm.
      if (!permits(perm, tool.minPerm)) {
        res.json(rpcError(msg.id, -32003, `tool "${params.name}" requires ${tool.minPerm} access`));
        return;
      }
      try {
        const result = await tool.handler(userId, params.arguments || {}, perm);
        res.json(rpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        }));
      } catch (err) {
        res.json(rpcResult(msg.id, {
          content: [{ type: 'text', text: String(err.message || err) }],
          isError: true,
        }));
      }
      return;
    }
    default:
      if (isNotification) { res.status(202).end(); return; }
      res.json(rpcError(msg.id, -32601, `method not implemented: ${msg.method}`));
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`mcp server listening on :${PORT} (shared=${SHARED})`));
