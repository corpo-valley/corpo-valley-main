// OAuth2 token introspection against Hydra's admin endpoint, with a short
// in-process cache so the MCP server doesn't introspect on every tool call
// for the same active session.

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';

// Cap the cache window so a revoked token isn't accepted longer than this
// after consent revocation. 5 min was too lax; 60 s is the sweet spot
// between revocation latency and introspection load. Long-lived SSE
// channels re-introspect periodically on top of this (see routes/mcp.ts).
const CACHE_TTL_MS = 60 * 1000;

export interface IntrospectionResult {
  active: boolean;
  sub?: string;            // Kratos identity id when the upstream is OIDC
  aud?: string[];
  scope?: string;
  client_id?: string;
  exp?: number;
  iss?: string;
  username?: string;       // Kratos preferred_username if exposed
  // ext is Hydra's session.access_token bag; we don't rely on it.
}

const cache = new Map<string, { result: IntrospectionResult; cachedAt: number }>();

// Introspect a bearer token. Returns the introspection result regardless of
// validity — callers must check `.active`. On a network error returns a
// result with `active: false` so downstream code denies the request rather
// than crashing.
export async function introspectToken(token: string): Promise<IntrospectionResult> {
  if (!token) return { active: false };
  const now = Date.now();
  const cached = cache.get(token);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS && cached.result.active) {
    // If the token's introspection-reported `exp` is past, treat it as
    // inactive even if our cache says otherwise.
    if (!cached.result.exp || cached.result.exp * 1000 > now) return cached.result;
  }
  try {
    const body = new URLSearchParams({ token }).toString();
    const res = await fetch(`${hydraAdminUrl}/admin/oauth2/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      return { active: false };
    }
    const json = await res.json() as IntrospectionResult;
    if (json.active) cache.set(token, { result: json, cachedAt: now });
    return json;
  } catch (err) {
    console.error('[mcp] hydra introspect failed:', (err as Error)?.message);
    return { active: false };
  }
}
