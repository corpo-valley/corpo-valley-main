// OAuth2 token introspection against Hydra's admin endpoint, with a short
// in-process cache so the MCP server doesn't introspect on every tool call
// for the same active session.

import * as crypto from 'crypto';

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';

// Cache keyed by sha256(token) rather than the raw bearer so a heap dump, map
// enumeration, or accidental log of the cache can't expose live tokens. NOTE:
// never log the request `body` below — it carries the raw token.
function cacheKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Cap the cache window so a revoked token isn't accepted longer than this
// after consent revocation. Hydra admin is in-cluster and cheap to hit, so we
// keep this very short: the cache exists only to collapse bursts of tool calls
// on the same token, not to meaningfully extend a token's life past revocation.
const CACHE_TTL_MS = 5 * 1000;

// Hard cap on cached entries so a flood of distinct tokens can't grow the Map
// unbounded. On overflow we evict the oldest insertion (Map preserves order).
const CACHE_MAX_ENTRIES = 5000;

export interface IntrospectionResult {
  active: boolean;
  sub?: string;            // Kratos identity id when the upstream is OIDC
  aud?: string[];
  scope?: string;
  client_id?: string;
  exp?: number;
  iss?: string;
  username?: string;       // Kratos preferred_username if exposed
  token_use?: string;      // Hydra's access_token / refresh_token discriminator
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
  const key = cacheKey(token);
  const cached = cache.get(key);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS && cached.result.active) {
    // If the token's introspection-reported `exp` is past, treat it as
    // inactive even if our cache says otherwise.
    if (!cached.result.exp || cached.result.exp * 1000 > now) return cached.result;
  }
  try {
    // Hint Hydra we expect an access token; the response `token_use` lets
    // callers reject a refresh token presented as a bearer.
    const body = new URLSearchParams({ token, token_type_hint: 'access_token' }).toString();
    const res = await fetch(`${hydraAdminUrl}/admin/oauth2/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      return { active: false };
    }
    const json = await res.json() as IntrospectionResult;
    if (json.active) {
      // Bound the cache: evict the oldest entry once over the cap.
      if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { result: json, cachedAt: now });
    }
    return json;
  } catch (err) {
    console.error('[mcp] hydra introspect failed:', (err as Error)?.message);
    return { active: false };
  }
}
