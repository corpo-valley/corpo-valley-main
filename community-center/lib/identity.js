// Shared identity + permission helper for the database and mcp capabilities.
//
// ── The standard (see ACCESS.md) ─────────────────────────────────────────
// Every request that reaches a capability container has already passed the
// platform's edge access check: the Ingress asks the portal whether the
// visitor may see this project. Anonymous visitors are bounced to login and
// signed-in members without `read` are blocked with 403 — your code never
// sees either. Allowed requests arrive carrying three TRUSTED headers, which
// nginx overwrites from the portal's answer (a client-supplied copy never
// survives the edge):
//
//   X-CV-User-Id      stable identity id of the visitor
//   X-CV-User-Email   visitor email
//   X-CV-Perm         read | write | admin
//
// The three permission classes are yours to interpret: a typical app lets
// `read` view, `write` create/update their own data, and `admin` moderate
// everything. The project owner is always `admin`.
//
// resolveUser(req) returns { id, email, perm } or null. The MCP capability
// receives X-User-Id from the MCP gateway instead (no perm — MCP access is
// owner-only at the gateway), so it keeps using resolveUser's fallbacks.
//
// Fallback: when the edge headers are absent (running the container locally),
// we re-validate the forwarded Kratos session cookie against Kratos and report
// perm `write`. This is DISABLED by default and only enabled when
// CV_DEV_COOKIE_FALLBACK is set — inside the cluster the trusted edge headers
// are always present, so a deployed container that somehow loses its auth-url
// must fail closed (deny) rather than silently granting `write` to any
// signed-in session.

const KRATOS_URL = (process.env.KRATOS_PUBLIC_URL
  || '{{CV_KRATOS_PUBLIC_URL}}').replace(/\/+$/, '');

const PERMS = new Set(['read', 'write', 'admin']);

const DEV_COOKIE_FALLBACK = process.env.CV_DEV_COOKIE_FALLBACK === '1'
  || process.env.CV_DEV_COOKIE_FALLBACK === 'true';

const TTL_MS = 30_000;
const NEG_TTL_MS = 3_000;
const cache = new Map(); // ory_kratos_session value -> { val, exp }

// Pull just the ory_kratos_session value out of the Cookie header. Keying the
// cache on this (not the whole header) means a real browser carrying many
// unrelated cookies still gets cache hits, and a fresh login — which mints a
// new session value — is never shadowed by a previous negative entry.
function sessionToken(cookieHeader) {
  const m = /(?:^|;\s*)ory_kratos_session=([^;]+)/.exec(cookieHeader || '');
  return m ? m[1] : null;
}

async function resolveUser(req) {
  // Primary path: the trusted edge headers. The edge ALWAYS co-sends a valid
  // X-CV-Perm with the id (nginx overwrites both from the portal's answer), so a
  // present id with an absent/garbage perm means the request did NOT come
  // through the platform edge — default-deny rather than inventing a permission.
  const headerId = req.headers['x-cv-user-id'];
  if (headerId) {
    const rawPerm = String(req.headers['x-cv-perm'] || '');
    if (!PERMS.has(rawPerm)) return null;
    return {
      id: String(headerId),
      email: req.headers['x-cv-user-email'] ? String(req.headers['x-cv-user-email']) : undefined,
      perm: rawPerm,
    };
  }

  // Fallback (LOCAL DEV ONLY, off unless CV_DEV_COOKIE_FALLBACK is set): validate
  // the forwarded Kratos session cookie directly. In-cluster this never runs.
  if (!DEV_COOKIE_FALLBACK) return null;
  const cookieHeader = req.headers.cookie || '';
  const token = sessionToken(cookieHeader);
  if (!token) return null;

  const now = Date.now();
  const hit = cache.get(token);
  if (hit && hit.exp > now) return hit.val;

  let val = null;
  try {
    const r = await fetch(`${KRATOS_URL}/sessions/whoami`, { headers: { cookie: cookieHeader } });
    if (r.ok) {
      const s = await r.json();
      if (s && s.active !== false && s.identity && s.identity.id) {
        // Legacy posture: any valid session could use the app fully.
        val = { id: s.identity.id, email: s.identity.traits && s.identity.traits.email, perm: 'write' };
      }
    }
  } catch {
    // Kratos unreachable — treat as unauthenticated, cache negatively (short
    // TTL) so a blip doesn't hammer it but a recovery is picked up quickly.
    val = null;
  }

  // Keep the cache bounded; a flush is fine since entries are cheap to refill.
  if (cache.size > 1000) cache.clear();
  cache.set(token, { val, exp: now + (val ? TTL_MS : NEG_TTL_MS) });
  return val;
}

// Express-style middleware factory: requirePerm('write') 403s callers whose
// X-CV-Perm ranks below the floor. Use it to gate mutating routes.
const RANK = { read: 1, write: 2, admin: 3 };
function requirePerm(min) {
  return async function (req, res, next) {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if ((RANK[user.perm] || 0) < (RANK[min] || 0)) {
      res.status(403).json({ error: `requires ${min} access` });
      return;
    }
    req.user = user;
    req.userId = user.id;
    req.userEmail = user.email;
    req.userPerm = user.perm;
    next();
  };
}

module.exports = { resolveUser, requirePerm };
