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
// header. This container never sees a token — it just reads X-User-Id. The
// header is trustworthy: the only route in is through the gateway, and a
// cross-project pod can't reach this container (egress NetworkPolicy). Scope
// any data by X-User-Id; per-user isolation is the default (CV_SHARED opts in
// to a shared view, for parity with the database capability).
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
// Each tool receives the trusted caller id; scope any data access by it.
const tools = {
  whoami: {
    description: 'Return the identity of the caller as seen by this project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler(userId) {
      return { user_id: userId, shared: SHARED };
    },
  },
  // Add your tools here. For example:
  // echo: {
  //   description: 'Echo back a message.',
  //   inputSchema: { type: 'object', required: ['message'],
  //     properties: { message: { type: 'string' } }, additionalProperties: false },
  //   handler(userId, args) { return { said: String(args.message ?? '') }; },
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
      res.json(rpcResult(msg.id, {
        tools: Object.entries(tools).map(([name, t]) => ({
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
      try {
        const result = await tool.handler(userId, params.arguments || {});
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
