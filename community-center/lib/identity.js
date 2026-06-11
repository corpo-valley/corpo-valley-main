// Shared identity helper for the database and mcp capabilities.
//
// Every request that reaches a capability container has already passed the
// platform's edge auth check (the Ingress gates on a valid Kratos session),
// and the browser's `ory_kratos_session` cookie — scoped to the platform's
// parent domain — is forwarded through to this container. We re-validate that same cookie
// against Kratos here to obtain the caller's stable identity id. A workload in
// this namespace can't forge it: producing a valid identity requires a real
// Kratos session, which only the signed-in user has.
//
// resolveUser(req) returns { id, email } for an authenticated caller, or null.
// Results are cached briefly per cookie so we don't call Kratos on every
// request to a chatty endpoint.

const KRATOS_URL = (process.env.KRATOS_PUBLIC_URL
  || '{{CV_KRATOS_PUBLIC_URL}}').replace(/\/+$/, '');

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
        val = { id: s.identity.id, email: s.identity.traits && s.identity.traits.email };
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

module.exports = { resolveUser };
