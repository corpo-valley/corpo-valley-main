// HTTP routes for the Corpo Valley MCP server. Mounted under /mcp.
// Distinct from the dashboard: no session cookies, no CSRF — auth is a
// Hydra-issued bearer token introspected against Hydra's admin endpoint.
//
// External hostname is `mcp.corpo-valley.com`. The well-known endpoint at
// /.well-known/oauth-protected-resource lets MCP clients discover the
// authorization server (Hydra) from just the MCP URL.

import { Router, Request, Response } from 'express';
import { introspectToken } from '../services/hydra-introspect';
import { dispatchJsonRpc, type McpContext } from '../services/mcp';
import { getIdentity } from '../services/kratos-admin';

const router = Router();

const PUBLIC_MCP_URL = process.env.PUBLIC_MCP_URL || 'https://mcp.corpo-valley.com';
const HYDRA_PUBLIC_URL = process.env.HYDRA_PUBLIC_URL || 'https://oauth.corpo-valley.com';
const PORTAL_BASE_URL = process.env.BASE_URL || 'https://portal.corpo-valley.com';

// RFC 9728 — Protected Resource Metadata. MCP clients hit this from the
// `WWW-Authenticate` Bearer realm header (or by appending the well-known
// path to the MCP base URL) to learn which authorization server to drive.
router.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').json({
    resource: PUBLIC_MCP_URL,
    authorization_servers: [HYDRA_PUBLIC_URL],
    scopes_supported: ['openid', 'offline', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${PORTAL_BASE_URL}/docs/mcp`,
    resource_name: 'Corpo Valley MCP',
  });
});

// Also expose the metadata at /mcp/.well-known/oauth-protected-resource —
// some MCP clients look there by appending to the MCP endpoint path.
router.get('/mcp/.well-known/oauth-protected-resource', (req, res) => {
  // Reuse the handler.
  (req as any).url = '/.well-known/oauth-protected-resource';
  (router as any).handle(req, res, () => {});
});

router.get('/healthz', (_req, res) => res.json({ ok: true, server: 'corpo-valley-mcp' }));

// RFC 8414 — OAuth 2.0 Authorization Server Metadata. Hydra v2.3 doesn't
// serve this path itself and doesn't advertise `registration_endpoint` in
// its OIDC discovery doc, so MCP clients (claude.ai, others) can't
// auto-discover Dynamic Client Registration.
//
// We fetch Hydra's openid-configuration server-side, augment it with the
// missing `registration_endpoint`, and return it at the RFC-8414 path.
// Same content is served at the OIDC path so clients that only follow the
// OIDC discovery chain see registration_endpoint too.
const HYDRA_PUBLIC_URL_INTERNAL = process.env.HYDRA_PUBLIC_URL_INTERNAL
  || 'http://ory-hydra-public.cv-ory.svc.cluster.local:4444';

let cachedMetadata: { fetched_at: number; body: any } | null = null;
const METADATA_TTL_MS = 5 * 60 * 1000;

async function fetchAndAugmentMetadata(): Promise<any> {
  const now = Date.now();
  if (cachedMetadata && now - cachedMetadata.fetched_at < METADATA_TTL_MS) {
    return cachedMetadata.body;
  }
  const res = await fetch(`${HYDRA_PUBLIC_URL_INTERNAL}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`hydra discovery returned ${res.status}`);
  const oidc = await res.json() as Record<string, unknown>;
  const registrationEndpoint = `${HYDRA_PUBLIC_URL}/oauth2/register`;
  const merged = {
    ...oidc,
    registration_endpoint: registrationEndpoint,
    // RFC 8414 explicitly enumerates these; restate so clients that only
    // parse RFC 8414 fields see what they expect.
    grant_types_supported: oidc.grant_types_supported || ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: oidc.code_challenge_methods_supported || ['S256'],
  };
  cachedMetadata = { fetched_at: now, body: merged };
  return merged;
}

async function serveAuthServerMetadata(_req: Request, res: Response) {
  try {
    const body = await fetchAndAugmentMetadata();
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    res.json(body);
  } catch (err) {
    console.error('[mcp] auth-server metadata fetch failed:', (err as Error)?.message);
    res.status(502).json({ error: 'metadata_unavailable' });
  }
}

// Two entry points, same content:
//   /.well-known/oauth-authorization-server  — RFC 8414, the canonical
//      path MCP clients try first.
//   /.well-known/openid-configuration         — OIDC discovery, served
//      with `registration_endpoint` injected for clients that only follow
//      this path.
router.get('/.well-known/oauth-authorization-server', serveAuthServerMetadata);
router.get('/.well-known/openid-configuration', serveAuthServerMetadata);

// ── Dynamic Client Registration proxy (RFC 7591/7592) ─────────────────────────
// The chart's `portal-oauth-dcr-shim` Ingress routes the oauth host's
// /oauth2/register* to the portal (path overrides beat the Hydra catch-all),
// the same way it already routes the two discovery docs above. So the
// `registration_endpoint` we advertise — `${HYDRA_PUBLIC_URL}/oauth2/register`
// — lands here, not on raw Hydra.
//
// Why: Hydra (≤ v2.3) serializes ABSENT optional client metadata in DCR
// responses as `""`/`null` (`client_uri: ""`, `contacts: null`, …). RFC 7591
// says optional fields should simply be omitted, and strict MCP clients
// (Claude Code / the MCP TypeScript SDK's Zod schema) hard-fail on those
// values — local `claude mcp add` dies with "client_uri — Invalid URL" while
// lenient clients (claude.ai web) succeed. Hydra has no setting to suppress
// the fields, so we forward to Hydra and strip top-level `""`/`null` members
// from successful responses. `0`/`false` are kept (`client_secret_expires_at:
// 0` means "never expires"). The /:id management routes (RFC 7592) get the
// same treatment — Hydra's `registration_client_uri` points back at this same
// public path, and its GET/PUT responses carry the same empty fields.

const DCR_PROXY_TIMEOUT_MS = 10_000;

function sanitizeDcrResponse(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== '' && v !== null));
}

// DCR is driven by third-party MCP clients, some browser-based — same
// cross-origin posture as the discovery docs above.
function dcrCors(res: Response): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function proxyRegister(req: Request, res: Response): Promise<void> {
  dcrCors(res);
  const id = req.params.id;
  if (id !== undefined && !/^[A-Za-z0-9._~-]{1,128}$/.test(id)) {
    res.status(400).json({ error: 'invalid_client_id' });
    return;
  }
  const url = `${HYDRA_PUBLIC_URL_INTERNAL}/oauth2/register${id ? `/${encodeURIComponent(id)}` : ''}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  // RFC 7592 management auth (Bearer registration_access_token) — forwarded
  // verbatim; Hydra is the one that validates it.
  const auth = req.header('authorization');
  if (auth) headers['Authorization'] = auth;
  const hasBody = req.method === 'POST' || req.method === 'PUT';
  if (hasBody) headers['Content-Type'] = 'application/json';
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(DCR_PROXY_TIMEOUT_MS),
    });
    // Registration responses carry secrets (client_secret,
    // registration_access_token) — never cacheable.
    res.status(upstream.status).set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
    const text = await upstream.text();
    if (!text) {
      res.end(); // e.g. 204 from DELETE
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      res.type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    }
    // Error bodies pass through untouched so clients see Hydra's
    // error/error_description verbatim.
    res.json(upstream.ok ? sanitizeDcrResponse(parsed) : parsed);
  } catch (err) {
    console.error('[mcp] DCR proxy failed:', (err as Error)?.message);
    res.status(502).json({ error: 'registration_unavailable' });
  }
}

router.options(['/oauth2/register', '/oauth2/register/:id'], (_req, res) => {
  dcrCors(res);
  res.status(204).end();
});
router.post('/oauth2/register', proxyRegister);
router.get('/oauth2/register/:id', proxyRegister);
router.put('/oauth2/register/:id', proxyRegister);
router.delete('/oauth2/register/:id', proxyRegister);

// Bearer token extraction + introspection → McpContext or 401.
async function authenticate(req: Request, res: Response): Promise<McpContext | null> {
  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${PUBLIC_MCP_URL}", error="invalid_request"`)
      .json({ error: 'missing_bearer', resource_metadata: `${PUBLIC_MCP_URL}/.well-known/oauth-protected-resource` });
    return null;
  }
  const introspection = await introspectToken(m[1]);
  if (!introspection.active || !introspection.sub) {
    res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${PUBLIC_MCP_URL}", error="invalid_token"`)
      .json({ error: 'invalid_token', resource_metadata: `${PUBLIC_MCP_URL}/.well-known/oauth-protected-resource` });
    return null;
  }
  // Reject a non-access token (e.g. a refresh token) presented as a bearer.
  // Hydra reports `token_use`; when present it must say access_token. Absent
  // (older Hydra) → fall through, preserving existing behaviour.
  if (introspection.token_use && introspection.token_use !== 'access_token') {
    console.warn('[mcp] rejected non-access token', { token_use: introspection.token_use, client_id: introspection.client_id });
    res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${PUBLIC_MCP_URL}", error="invalid_token"`)
      .json({ error: 'invalid_token', resource_metadata: `${PUBLIC_MCP_URL}/.well-known/oauth-protected-resource` });
    return null;
  }

  // Confused-deputy defence. A valid Hydra token for the user is NOT enough —
  // it must come from a client meant to drive MCP. Otherwise a token issued to
  // a first-party OIDC client (e.g. `gitea`), which carries the user's Kratos
  // `sub`, could be replayed here to gain full project-management authority.
  //
  // We can't bind on audience: real MCP-client tokens arrive with empty `aud`
  // (the clients don't send RFC 8707 resource indicators). And we can't
  // allow-list client_ids, because legitimate MCP clients register dynamically
  // (DCR) with random ids. So we DENY the first-party clients that the consent
  // flow auto-trusts — those are exactly the confused-deputy risk (their tokens
  // carry the user's sub and skip consent). The denylist defaults to the SAME
  // value as the consent allow-list (TRUSTED_CLIENT_IDS) so the two can't drift:
  // onboarding a new SSO client (e.g. argocd) auto-denies it here too. The
  // static `claude-code-mcp` client and DCR clients aren't trusted-for-consent,
  // so they pass.
  const DENY_CLIENT_IDS = (process.env.MCP_DENY_CLIENT_IDS || process.env.TRUSTED_CLIENT_IDS || 'argocd,gitea')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (introspection.client_id && DENY_CLIENT_IDS.includes(introspection.client_id)) {
    console.warn('[mcp] rejected token from non-MCP client', { client_id: introspection.client_id });
    res.status(403)
      .set('WWW-Authenticate', `Bearer realm="${PUBLIC_MCP_URL}", error="invalid_token", error_description="this client is not authorized for the MCP resource"`)
      .json({ error: 'unauthorized_client', resource_metadata: `${PUBLIC_MCP_URL}/.well-known/oauth-protected-resource` });
    return null;
  }
  // Audience binding (RFC 8707). Per the MCP authorization spec, clients send a
  // `resource` indicator so Hydra stamps the resource into `aud`; we require it
  // here so a token minted for another resource (or with no audience) can't be
  // replayed against this broad platform MCP surface. Enforced by default — set
  // MCP_ENFORCE_AUDIENCE=false only as a transitional escape hatch.
  const requiredAud = process.env.MCP_RESOURCE_AUDIENCE || PUBLIC_MCP_URL;
  const enforceAud = process.env.MCP_ENFORCE_AUDIENCE !== 'false';
  const aud = Array.isArray(introspection.aud) ? introspection.aud : [];
  // Non-bypassable backstop: a token that NAMES some other resource (e.g. a
  // per-project gateway `aud`) must never be accepted at the platform MCP, even
  // when enforcement is toggled off. The escape hatch only relaxes the
  // empty-aud legacy case — it can't promote a project-scoped token to platform
  // authority. (The per-project gateway has its own ownsProject() backstop.)
  const audMissingPlatform = !aud.includes(requiredAud);
  const audNamesOtherResource = aud.length > 0 && audMissingPlatform;
  if ((enforceAud && audMissingPlatform) || audNamesOtherResource) {
    console.warn('[mcp] rejected token: audience mismatch', { client_id: introspection.client_id, aud, required: requiredAud, enforceAud });
    res.status(403)
      .set('WWW-Authenticate', `Bearer realm="${PUBLIC_MCP_URL}", error="invalid_token", error_description="token audience does not include this MCP resource"`)
      .json({ error: 'invalid_audience', resource_metadata: `${PUBLIC_MCP_URL}/.well-known/oauth-protected-resource` });
    return null;
  }

  // Fetch Kratos identity for the preferred_username and email — needed
  // to mint Gitea PATs and ensureUser on project create. Failure here
  // doesn't abort: tools that need them will surface their own error.
  let email: string | undefined;
  let preferredUsername: string | undefined;
  let emailVerified = false;
  try {
    const id = await getIdentity(introspection.sub);
    const t = id?.traits as Record<string, any> | undefined;
    email = t?.email;
    preferredUsername = t?.preferred_username;
    const verifiable = id?.verifiable_addresses || [];
    emailVerified = verifiable.some(
      (v: any) => v.value?.toLowerCase() === (email || '').toLowerCase() && v.verified,
    );
  } catch (err) {
    console.error('[mcp] kratos getIdentity failed:', (err as Error)?.message);
  }

  return { userId: introspection.sub, email, preferredUsername, emailVerified };
}

// MCP JSON-RPC endpoint. POST a JSON-RPC 2.0 request, get a JSON-RPC
// response back. Notifications (no `id`) return 202 with no body.
router.post('/mcp', async (req: Request, res: Response) => {
  const ctx = await authenticate(req, res);
  if (!ctx) return;
  try {
    const result = await dispatchJsonRpc(req.body, ctx);
    if (!result) {
      res.status(202).end();
      return;
    }
    res.json(result);
  } catch (err: any) {
    console.error('[mcp] dispatch error:', err?.message);
    res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
  }
});

// GET /mcp — server-initiated event stream. Streamable HTTP transport
// lets clients open an SSE channel to receive notifications outside of
// the request/response flow. We use it to push
// `notifications/tools/list_changed` on connection, so clients that hold
// this channel open across a portal upgrade refresh their cached tool
// list without an editor restart.
//
// Hardening:
//   - Per-user cap on concurrent open channels — one misbehaving client
//     can't exhaust portal sockets / FDs.
//   - Periodic re-introspection — a once-authed token that gets revoked
//     mid-session has its channel closed within REINTROSPECT_MS.

const MAX_SSE_PER_USER = 5;
// Hard ceiling on total concurrent SSE channels PER REPLICA, protecting this
// process's sockets/FDs regardless of how many distinct users connect. NOTE:
// both this and MAX_SSE_PER_USER are per-replica in-process guards — a
// horizontally-scaled Deployment multiplies the effective per-user cap by the
// replica count. A hard cross-replica guarantee needs a shared limiter (e.g. a
// Redis token bucket keyed on sub); these remain a soft local backstop.
const MAX_SSE_TOTAL = Number(process.env.MAX_SSE_TOTAL || 500);
// Re-introspect (and send a keepalive) on a tighter cadence than the proxy idle
// timeout (~60s) so a revoked token's held-open stream is closed within this
// window.
const REINTROSPECT_MS = 15_000;
const sseOpenPerUser = new Map<string, number>();
let sseOpenTotal = 0;

// Coalesce re-introspection across all channels sharing the same token, so N
// open channels for one token cost ~1 Hydra-admin introspect per window instead
// of N. Without this, a single tenant fanning out many channels drives
// introspection load proportional to channel count.
const REINTROSPECT_COALESCE_MS = 10_000;
const tokenLiveness = new Map<string, { at: number; active: boolean; sub?: string }>();
const TOKEN_LIVENESS_MAX = 5000;
async function coalescedIntrospect(token: string): Promise<{ active: boolean; sub?: string }> {
  const now = Date.now();
  const cached = tokenLiveness.get(token);
  if (cached && now - cached.at < REINTROSPECT_COALESCE_MS) {
    return { active: cached.active, sub: cached.sub };
  }
  const r = await introspectToken(token);
  // Bound the map (FIFO eviction) so a churn of distinct tokens can't grow it
  // without limit.
  if (tokenLiveness.size >= TOKEN_LIVENESS_MAX && !tokenLiveness.has(token)) {
    const oldest = tokenLiveness.keys().next().value;
    if (oldest !== undefined) tokenLiveness.delete(oldest);
  }
  tokenLiveness.set(token, { at: now, active: !!r.active, sub: r.sub });
  return { active: !!r.active, sub: r.sub };
}

router.get('/mcp', async (req: Request, res: Response) => {
  const ctx = await authenticate(req, res);
  if (!ctx) return;

  if (sseOpenTotal >= MAX_SSE_TOTAL) {
    res.status(429).json({ error: 'too_many_sse_channels_total', limit: MAX_SSE_TOTAL });
    return;
  }
  const open = sseOpenPerUser.get(ctx.userId) || 0;
  if (open >= MAX_SSE_PER_USER) {
    res.status(429).json({ error: 'too_many_sse_channels', limit: MAX_SSE_PER_USER });
    return;
  }
  sseOpenPerUser.set(ctx.userId, open + 1);
  sseOpenTotal++;

  // Register the slot-release BEFORE any flushHeaders/write that can throw.
  // Otherwise a header-flush/write failure (e.g. client already gone) would
  // skip the close handler and leak a per-user + total slot for the life of the
  // process, eventually wedging the cap. `release` is idempotent and also clears
  // the heartbeat (armed below).
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    if (sseOpenTotal > 0) sseOpenTotal--;
    const n = (sseOpenPerUser.get(ctx.userId) || 1) - 1;
    if (n <= 0) sseOpenPerUser.delete(ctx.userId);
    else sseOpenPerUser.set(ctx.userId, n);
  };
  req.on('close', release);

  try {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      // Disable nginx/proxy response buffering — SSE needs each chunk to
      // reach the client immediately, not after the proxy decides it has
      // accumulated enough.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Push a list_changed notification right away. Cheap: any tool added
    // since the client last looked will get picked up on the very next
    // tools/list call.
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    res.write(`data: ${notification}\n\n`);
  } catch (err) {
    console.error('[mcp] SSE channel setup failed:', (err as Error)?.message);
    release();
    try { res.end(); } catch { /* already gone */ }
    return;
  }

  // Re-extract the bearer once so the reintrospection loop doesn't have
  // to walk express's req.headers every tick.
  const tokenMatch = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const token = tokenMatch ? tokenMatch[1] : '';

  // Proxies (nginx, Cloudflare) drop idle streams after ~60s. Send a
  // comment heartbeat well within that window. While we're here, re-
  // introspect the token so a revoked session is closed mid-channel.
  heartbeat = setInterval(async () => {
    try {
      if (token) {
        const r = await coalescedIntrospect(token);
        if (!r.active || !r.sub || r.sub !== ctx.userId) {
          // Token revoked or rebound — drop the stream.
          try { res.end(); } catch { /* already gone */ }
          return;
        }
      }
      res.write(': keepalive\n\n');
    } catch {
      try { res.end(); } catch { /* already gone */ }
    }
  }, REINTROSPECT_MS);
});

export default router;
