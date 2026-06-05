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
// First-party OIDC clients that must NOT be able to drive MCP (their tokens
// carry the user's sub and skip consent). Same denylist as the portal MCP.
const DENY_CLIENT_IDS = (process.env.MCP_DENY_CLIENT_IDS || process.env.TRUSTED_CLIENT_IDS || 'argocd,gitea')
  .split(',').map((s) => s.trim()).filter(Boolean);

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

interface Introspection { active: boolean; sub?: string; client_id?: string; ext?: any; }

async function introspect(token: string): Promise<Introspection> {
  try {
    const r = await fetch(`${HYDRA_ADMIN_URL}/admin/oauth2/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
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
  res.set('Cache-Control', 'public, max-age=3600').json({
    resource: `https://${host}/mcp`,
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
  if (intro.client_id && DENY_CLIENT_IDS.includes(intro.client_id)) {
    res.status(403).json({ error: 'unauthorized_client' });
    return;
  }

  // Forward the entire request to the project's mcp container, stripping the
  // bearer and injecting the resolved identity as trusted headers.
  const target = `${slug}-mcp.${slug}.svc.cluster.local`;
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers['authorization'];
  delete headers['host'];
  headers['x-user-id'] = intro.sub;
  const email = intro.ext?.identity?.traits?.email;
  if (typeof email === 'string') headers['x-user-email'] = email;

  const preq = http.request({ host: target, port: PROJECT_MCP_PORT, method: req.method, path: req.url, headers }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', (e) => {
    console.error(`[gateway] upstream ${target} error:`, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'project mcp unavailable' });
  });
  req.pipe(preq);
}
app.all('/mcp', handleMcp);

app.listen(PORT, () => console.log(`cv-mcp-gateway listening on :${PORT}`));
