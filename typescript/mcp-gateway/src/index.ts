// Corpo Valley MCP Gateway.
//
// A standalone reverse-proxy auth gateway in front of every project's per-project
// MCP endpoint (`https://<slug>.projects.corpo-valley.com/mcp`). It owns the MCP
// OAuth flow so that MCP clients (Claude, Cursor, …) can connect, then forwards
// authenticated requests to the project's own mcp container.
//
// Why a separate service (not folded into the portal): blast-radius isolation —
// an MCP-proxy crash or overload must not take down the dashboard, project
// provisioning, or the platform MCP. It scales independently too.
//
// Flow:
//   client → <slug>.projects.corpo-valley.com/mcp → (ingress, no cookie gate)
//          → this gateway
//              ├─ no/invalid bearer → 401 + WWW-Authenticate, and serve
//              │                       /.well-known/* to drive the Hydra OAuth dance
//              └─ valid bearer → introspect (Hydra) → reverse-proxy the whole
//                                request to <slug>-mcp.<slug>.svc with X-User-Id
//
// The project's mcp container therefore only ever sees gateway-authenticated
// requests carrying a trusted X-User-Id, and needs no OAuth of its own.

import express from 'express';
import * as http from 'http';

const PORT = Number(process.env.PORT || 3000);
// Public OAuth issuer the clients drive (browser-facing).
const HYDRA_PUBLIC_URL = process.env.HYDRA_PUBLIC_URL || 'https://oauth.corpo-valley.com';
// In-cluster Hydra endpoints.
const HYDRA_ADMIN_URL = process.env.HYDRA_ADMIN_URL || 'http://ory-hydra-admin.cv-ory.svc.cluster.local:4445';
const HYDRA_PUBLIC_INTERNAL = process.env.HYDRA_PUBLIC_URL_INTERNAL || 'http://ory-hydra-public.cv-ory.svc.cluster.local:4444';
// The suffix that identifies a project host; the label in front is the slug.
const PROJECTS_DOMAIN = process.env.PROJECTS_DOMAIN || 'projects.corpo-valley.com';
const PROJECT_MCP_PORT = Number(process.env.PROJECT_MCP_PORT || 80);
// How often to re-introspect the token (and re-check ownership) on long-lived
// proxied streams, so revocation is enforced mid-stream. Kept under typical
// proxy idle timeouts (~60s).
const STREAM_REVALIDATE_MS = Number(process.env.MCP_STREAM_REVALIDATE_MS || 15000);
// First-party OIDC clients that must NOT be able to drive MCP (their tokens
// carry the user's sub and skip consent). Set MCP_DENY_CLIENT_IDS explicitly
// in deployment (the chart wires `mcp.denyClientIds` to this gateway AND the
// portal MCP, so the two enforce identically); the fallback chain here only
// covers non-chart deploys and CAN drift from the portal's — notably, a
// TRUSTED_CLIENT_IDS that includes an MCP-driver client (claude-code-mcp)
// must not be used as the deny list.
const DENY_CLIENT_IDS = (process.env.MCP_DENY_CLIENT_IDS || process.env.TRUSTED_CLIENT_IDS || 'argocd,gitea')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Allowlist of inbound headers safe to forward to a tenant-controlled MCP
// container. Anything not here (Cookie, Authorization, all x-user-*/x-forwarded-*
// identity headers, etc.) is dropped; trusted identity headers are re-added from
// introspection in handleMcp. Lowercase — req.headers keys are already lowercased.
const ALLOWED_FORWARD_HEADERS = new Set<string>([
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
  'cache-control',
  // MCP streamable-HTTP transport headers.
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

// Allowlist of headers safe to copy from the tenant-controlled upstream response
// back to the client. Everything else (Set-Cookie, Access-Control-Allow-*,
// WWW-Authenticate, etc.) is dropped so the tenant can't set auth-relevant
// headers on the shared `<slug>.projects.corpo-valley.com` origin.
const ALLOWED_RESPONSE_HEADERS = new Set<string>([
  'content-type',
  'content-length',
  'cache-control',
  'content-encoding',
  'content-disposition',
  'date',
  'etag',
  'vary',
  'mcp-session-id',
  'mcp-protocol-version',
]);

const app = express();
app.disable('x-powered-by');

// Extract and validate the slug from the request Host. The project Ingress sets
// upstream-vhost to the real project host, so Host is `<slug>.projects…`.
function slugFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const h = host.split(':')[0].toLowerCase();
  const suffix = '.' + PROJECTS_DOMAIN;
  if (!h.endsWith(suffix)) return null;
  const slug = h.slice(0, -suffix.length);
  // DNS-label; never let a crafted Host escape the `<slug>-mcp.<slug>.svc` target.
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(slug)) return null;
  return slug;
}

function resourceMetadataUrl(host: string): string {
  return `https://${host}/.well-known/oauth-protected-resource`;
}

function challenge(res: express.Response, host: string): void {
  res.status(401)
    .set('WWW-Authenticate', `Bearer realm="https://${host}/mcp", resource_metadata="${resourceMetadataUrl(host)}"`)
    .json({ error: 'missing_bearer', resource_metadata: resourceMetadataUrl(host) });
}

interface Introspection { active: boolean; sub?: string; client_id?: string; aud?: string[]; token_use?: string; ext?: any; }

// RFC 8707 audience binding. By default the gateway requires the token's `aud`
// to include this project's MCP resource (`https://<slug>.<PROJECTS_DOMAIN>/mcp`)
// so a token minted for project A can't be replayed against project B's gateway.
// Set MCP_ENFORCE_AUDIENCE=false only as a transitional escape hatch while
// clients are migrated to send resource indicators.
const ENFORCE_AUDIENCE = process.env.MCP_ENFORCE_AUDIENCE !== 'false';

function resourceForSlug(slug: string): string {
  return `https://${slug}.${PROJECTS_DOMAIN}/mcp`;
}

// Portal internal endpoint used to verify project ownership per request. This is
// the authoritative authorization check: audience binding only stops cross-
// project REPLAY (token for A used against B), but Hydra grants whatever resource
// a client requests, so a user can mint a token whose aud names a project they
// don't own. We therefore confirm the authenticated `sub` owns the host slug.
const PORTAL_INTERNAL_URL = process.env.PORTAL_INTERNAL_URL || 'http://portal.cv-portal.svc.cluster.local:3000';
const INTERNAL_WEBHOOK_SECRET = (process.env.INTERNAL_WEBHOOK_SECRET || '').trim();

type SitePerm = 'none' | 'read' | 'write' | 'admin';
const PERM_RANK: Record<SitePerm, number> = { none: 0, read: 1, write: 2, admin: 3 };

// Minimum effective SITE permission required to CONNECT to a project's MCP
// endpoint. MCP is the project's app over a different protocol, so access mirrors
// the site gate exactly: the floor is READ — anyone who may use the project's
// site (owner, direct grant, group grant, or site default >= read) may connect.
// Per-tool authorization is the MCP developer's responsibility: the gateway
// forwards X-CV-Perm (see the proxy below), and the project's MCP server gates
// which tools a read vs write vs admin caller may invoke — the same contract as
// the site's X-CV-Perm standard (read = view, write = mutate own, admin =
// moderate). The owner is always admin, so owner access is preserved.
const MIN_SITE_PERM: SitePerm = 'read';

// The caller's effective site permission for `slug`, from the portal grants
// engine. Fails CLOSED ('none') on any error, missing secret, or non-200 — a
// verification failure must never grant cross-tenant access.
async function sitePermission(slug: string, sub: string): Promise<SitePerm> {
  if (!INTERNAL_WEBHOOK_SECRET) {
    console.error('[gateway] INTERNAL_WEBHOOK_SECRET not set — cannot verify project access (fail closed).');
    return 'none';
  }
  try {
    const r = await fetch(`${PORTAL_INTERNAL_URL}/internal/projects/${encodeURIComponent(slug)}/access/${encodeURIComponent(sub)}`, {
      headers: { 'X-Internal-Secret': INTERNAL_WEBHOOK_SECRET },
    });
    if (!r.ok) return 'none';
    const body = await r.json() as { site_perm?: string };
    const p = body.site_perm;
    return (p === 'read' || p === 'write' || p === 'admin') ? p : 'none';
  } catch (e) {
    console.error('[gateway] access check failed:', (e as Error).message);
    return 'none';
  }
}

function permits(perm: SitePerm): boolean {
  return PERM_RANK[perm] >= PERM_RANK[MIN_SITE_PERM];
}

async function introspect(token: string): Promise<Introspection> {
  try {
    const r = await fetch(`${HYDRA_ADMIN_URL}/admin/oauth2/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // Hint Hydra we expect an access token; the response's `token_use`
      // discriminator lets us reject a refresh token presented as a bearer.
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
    });
    if (!r.ok) return { active: false };
    return await r.json() as Introspection;
  } catch (e) {
    console.error('[gateway] introspect failed:', (e as Error).message);
    return { active: false };
  }
}

// ── OAuth discovery (served unauthenticated so clients can bootstrap) ──────────
function protectedResource(req: express.Request, res: express.Response) {
  const host = req.headers.host || '';
  // Validate the Host before reflecting it into the metadata. Without this an
  // attacker-supplied Host (e.g. via a crafted request) would be echoed into
  // the `resource` field served to clients. Only a valid `<slug>.<domain>` Host
  // is honoured.
  const slug = slugFromHost(host);
  if (!slug) { res.status(400).json({ error: 'unknown project host' }); return; }
  res.set('Cache-Control', 'public, max-age=3600').json({
    resource: resourceForSlug(slug),
    authorization_servers: [HYDRA_PUBLIC_URL],
    scopes_supported: ['openid', 'offline', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_name: 'Corpo Valley project MCP',
  });
}
app.get('/.well-known/oauth-protected-resource', protectedResource);
app.get('/mcp/.well-known/oauth-protected-resource', protectedResource);

let metaCache: { at: number; body: any } | null = null;
async function authServerMetadata(_req: express.Request, res: express.Response) {
  try {
    if (!metaCache || Date.now() - metaCache.at > 300_000) {
      const r = await fetch(`${HYDRA_PUBLIC_INTERNAL}/.well-known/openid-configuration`);
      if (!r.ok) throw new Error(`hydra discovery ${r.status}`);
      const oidc = await r.json() as Record<string, unknown>;
      metaCache = { at: Date.now(), body: { ...oidc, registration_endpoint: `${HYDRA_PUBLIC_URL}/oauth2/register` } };
    }
    res.set('Cache-Control', 'public, max-age=300').set('Access-Control-Allow-Origin', '*').json(metaCache.body);
  } catch (e) {
    console.error('[gateway] metadata fetch failed:', (e as Error).message);
    res.status(502).json({ error: 'metadata_unavailable' });
  }
}
app.get('/.well-known/oauth-authorization-server', authServerMetadata);
app.get('/.well-known/openid-configuration', authServerMetadata);

// Humans who paste an MCP URL into a browser land here — give them a
// pointer instead of a bare 404. Agents never see this (they speak to /mcp).
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Corpo Valley MCP</title></head>
<body style="font-family:ui-monospace,Menlo,monospace;background:#2b2118;color:#f3ead9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="max-width:34rem;padding:2rem">
<h1 style="color:#e8b94a">🌱 Corpo Valley MCP</h1>
<p>This host serves a <a href="https://modelcontextprotocol.io" style="color:#84a25a">Model Context Protocol</a> endpoint at <code>/mcp</code> — it's meant for agents, not browsers.</p>
<p>Connect: <code>claude mcp add &lt;name&gt; --transport http --url https://&lt;this-host&gt;/mcp</code></p>
<p>Source &amp; issues: <a href="https://github.com/corpo-valley/corpo-valley-main" style="color:#84a25a">github.com/corpo-valley/corpo-valley-main</a></p>
</div></body></html>`);
});

app.get('/healthz', (_req, res) => res.json({ ok: true, server: 'cv-mcp-gateway' }));
app.get('/readyz', (_req, res) => res.json({ ok: true }));

// ── Authenticated reverse proxy ───────────────────────────────────────────────
async function handleMcp(req: express.Request, res: express.Response) {
  const host = req.headers.host || '';
  const slug = slugFromHost(host);
  if (!slug) { res.status(400).json({ error: 'unknown project host' }); return; }

  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) { challenge(res, host); return; }

  const intro = await introspect(m[1]);
  if (!intro.active || !intro.sub) { challenge(res, host); return; }
  // Reject non-access tokens (e.g. a refresh token) presented as a bearer.
  // Hydra reports `token_use` for OAuth2 tokens; when present it must say
  // access_token. Absent (older Hydra) → fall through, as before.
  if (intro.token_use && intro.token_use !== 'access_token') {
    console.warn('[gateway] rejecting non-access token', { slug, token_use: intro.token_use, client_id: intro.client_id });
    challenge(res, host);
    return;
  }
  const sub = intro.sub;
  if (intro.client_id && DENY_CLIENT_IDS.includes(intro.client_id)) {
    res.status(403).json({ error: 'unauthorized_client' });
    return;
  }
  // Audience binding: reject a token whose `aud` doesn't name THIS project's
  // resource, so one project's token can't be replayed against another's MCP.
  // Parity with the platform MCP (portal/src/routes/mcp.ts): a token that NAMES
  // a different resource is rejected even when enforcement is toggled off — the
  // MCP_ENFORCE_AUDIENCE escape hatch only relaxes the empty-aud legacy case and
  // can never promote a foreign-resource token to this project's gateway.
  {
    const aud = Array.isArray(intro.aud) ? intro.aud : [];
    const audMissingThis = !aud.includes(resourceForSlug(slug));
    const audNamesOtherResource = aud.length > 0 && audMissingThis;
    if ((ENFORCE_AUDIENCE && audMissingThis) || audNamesOtherResource) {
      console.warn('[gateway] audience mismatch', { slug, aud, client_id: intro.client_id, enforce: ENFORCE_AUDIENCE });
      res.status(403).json({ error: 'invalid_audience', resource_metadata: resourceMetadataUrl(host) });
      return;
    }
  }

  // Site-access check — the authoritative per-request authorization. Unlike the
  // audience check this can't be disabled by a single flag, so even with
  // MCP_ENFORCE_AUDIENCE=false an attacker can't reach a project they lack
  // access to. Mirrors the site gate (see MIN_SITE_PERM).
  const perm = await sitePermission(slug, sub);
  if (!permits(perm)) {
    console.warn('[gateway] access denied', { slug, sub, perm, client_id: intro.client_id });
    res.status(403).json({ error: 'forbidden_project' });
    return;
  }

  // Forward the request to the project's mcp container. Build the outbound
  // header set from a strict ALLOWLIST rather than cloning req.headers and
  // deleting a few keys — clone-and-delete leaks the browser `Cookie` (incl.
  // the Kratos session) and lets a client spoof identity headers (x-user-*,
  // x-forwarded-user, …) straight through to the tenant-controlled container.
  // Identity headers below are the ONLY ones we trust, and we set them from
  // introspection — never from the inbound request.
  const target = `${slug}-mcp.${slug}.svc.cluster.local`;
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (ALLOWED_FORWARD_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['x-user-id'] = sub;
  const email = intro.ext?.identity?.traits?.email;
  if (typeof email === 'string') headers['x-user-email'] = email;
  // Forward the effective site permission so a project MCP can apply the same
  // permission classes per tool (mirrors the site's X-CV-Perm contract). Set
  // from our computed perm, never from the inbound request.
  headers['x-cv-perm'] = perm;

  const preq = http.request({ host: target, port: PROJECT_MCP_PORT, method: req.method, path: req.url, headers }, (pres) => {
    // The upstream is a tenant-controlled container, so its response headers are
    // hostile: blindly copying them lets the tenant set Set-Cookie (on the
    // shared corpo-valley.com parent domain), CORS, or other auth-relevant
    // headers on a response the gateway emits. Forward only a safe allowlist.
    const safe: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(pres.headers)) {
      if (ALLOWED_RESPONSE_HEADERS.has(k.toLowerCase())) safe[k] = v;
    }
    res.writeHead(pres.statusCode || 502, safe);
    pres.pipe(res);
  });
  preq.on('error', (e) => {
    console.error(`[gateway] upstream ${target} error:`, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'project mcp unavailable' });
  });

  // Revocation enforcement on long-lived streams. The MCP streamable-HTTP
  // transport keeps a GET /mcp channel open indefinitely; without this, a token
  // revoked or expired AFTER connect would keep its proxied channel to the
  // tenant container alive for the life of the stream. Re-introspect (and
  // re-check ownership) on a tight cadence and tear the proxy down when the
  // token goes inactive, its sub changes, or ownership no longer holds. Short
  // request/response calls clear this on close before it ever fires.
  const token = m[1];
  const revalidate = setInterval(async () => {
    try {
      const re = await introspect(token);
      const stillValid = re.active && re.sub === sub && permits(await sitePermission(slug, sub));
      if (!stillValid) {
        console.warn('[gateway] tearing down stream: token/access no longer valid', { slug, sub });
        clearInterval(revalidate);
        try { preq.destroy(); } catch { /* already gone */ }
        try { res.end(); } catch { /* already gone */ }
      }
    } catch (e) {
      console.error('[gateway] revalidation error:', (e as Error).message);
    }
  }, STREAM_REVALIDATE_MS);
  const stopRevalidate = () => clearInterval(revalidate);
  res.on('close', stopRevalidate);
  preq.on('close', stopRevalidate);

  // Handle errors on the inbound request stream (client abort / reset mid-body).
  // Without a listener an 'error' on req would surface as an unhandled exception;
  // tear down the upstream and timer instead.
  req.on('error', (e) => {
    console.error('[gateway] inbound request stream error:', e.message);
    stopRevalidate();
    try { preq.destroy(); } catch { /* already gone */ }
  });

  req.pipe(preq);
}
app.all('/mcp', handleMcp);

app.listen(PORT, () => console.log(`cv-mcp-gateway listening on :${PORT}`));
