/**
 * Canonical MCP resource identifiers (RFC 8707 resource indicators / RFC 9728).
 *
 * MIRRORED FILE — this module exists byte-for-byte in BOTH
 *   typescript/portal/src/shared/mcp-resources.ts
 *   typescript/mcp-gateway/src/shared/mcp-resources.ts
 * because the two packages have separate build contexts and cannot import
 * across each other. CI (scripts/check-shared-sync.sh) fails if they differ.
 * Edit one, copy to the other. Three independent copies of this grammar
 * drifting apart is the root cause of the 0.11.0 project-MCP outage.
 *
 * A deployment exposes N+1 MCP resources:
 *   platform : https://mcp.<domain>                  (origin only, NO path)
 *   project  : https://<slug>.<projects-domain>/mcp  (origin + /mcp)
 *
 * The asymmetry is load-bearing: audiences are compared by EXACT STRING at the
 * enforcement sites (portal /mcp and the project gateway), so every producer
 * must agree on canonical form.
 */

export class InvalidTargetError extends Error {
  constructor(public readonly resource: string, public readonly reason: 'malformed' | 'multiple' = 'malformed') {
    super('invalid_target');
    this.name = 'InvalidTargetError';
  }
}

/** One DNS label: what a project slug must be. Shared so no caller re-types it. */
export const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** The canonical per-project MCP resource for a slug. */
export function resourceForSlug(slug: string, projectsDomain: string): string {
  return `https://${slug}.${projectsDomain}/mcp`;
}

/**
 * Lenient CLASSIFIER — "is this audience a project MCP resource, and whose?".
 * Used at consent to decide drop-or-keep. Hostname-only by design: it must
 * classify audiences that are already minted, not validate new input.
 */
export function projectSlugFromResource(resource: string, projectsDomain: string): string | null {
  let u: URL;
  try { u = new URL(resource); } catch { return null; }
  const suffix = '.' + projectsDomain;
  if (!u.hostname.endsWith(suffix)) return null;
  const slug = u.hostname.slice(0, -suffix.length);
  return DNS_LABEL.test(slug) ? slug : null;
}

/** True if the audience is any MCP resource of this deployment (platform or project). */
export function isMcpAudience(resource: string, opts: { projectsDomain: string; platformAudience: string }): boolean {
  return resource === opts.platformAudience || projectSlugFromResource(resource, opts.projectsDomain) !== null;
}

/**
 * Strict VALIDATOR for a client-supplied resource indicator.
 *
 * Unlike the classifier above this rejects anything non-canonical, and it
 * REBUILDS the returned string — the caller's input is never echoed. Without
 * that, a client sending `.../mcp/`, a bare origin, an explicit `:443`, or an
 * uppercase host would pass validation, complete an interactive login, and only
 * then get a 403 from the gateway's exact-string comparison. The final guard is
 * simply `input === rebuilt`: a resource is canonical iff it round-trips.
 *
 * One deliberate alias: the PLATFORM resource with a trailing slash. The MCP
 * TypeScript SDK (Claude Code, Cursor, …) parses the advertised resource with
 * `new URL()` and sends `.href`, and WHATWG serialises a bare origin as
 * `https://mcp.example.com/`. The MCP spec says servers SHOULD accept both
 * spellings; we accept it and still emit the canonical no-slash form.
 *
 * Throws InvalidTargetError; callers MUST surface 400 invalid_target and must
 * NOT fall back to the platform audience (that would silently escalate a
 * malformed project resource into platform-wide authority).
 */
export function canonicalMcpAudience(
  resource: string,
  opts: { projectsDomain: string; platformAudience: string },
): string {
  if (resource === opts.platformAudience || resource === opts.platformAudience + '/') {
    return opts.platformAudience;
  }

  let u: URL;
  try { u = new URL(resource); } catch { throw new InvalidTargetError(resource); }

  if (u.protocol !== 'https:') throw new InvalidTargetError(resource);
  if (u.username || u.password) throw new InvalidTargetError(resource);
  if (u.port) throw new InvalidTargetError(resource);
  if (u.search || u.hash) throw new InvalidTargetError(resource);
  if (u.pathname !== '/mcp') throw new InvalidTargetError(resource);

  const slug = projectSlugFromResource(u.href, opts.projectsDomain);
  if (!slug) throw new InvalidTargetError(resource);

  const rebuilt = resourceForSlug(slug, opts.projectsDomain);
  // Catches everything the URL parser normalises away (explicit :443,
  // uppercase host, trailing `?`/`#`, etc.): only the canonical spelling passes.
  if (rebuilt !== resource) throw new InvalidTargetError(resource);
  return rebuilt;
}

/**
 * The facade's audience selection, as a pure function of the client's
 * `resource` parameters (RFC 8707 §2 allows the parameter to repeat).
 *
 *   none     → the platform audience (pre-RFC 8707 clients)
 *   exactly 1 → its canonical form (throws InvalidTargetError if malformed)
 *   2 or more → InvalidTargetError('multiple'): exactly ONE audience per token.
 *               Both enforcement sites use `aud.includes`, so a token naming
 *               the platform AND a project would satisfy both at once.
 */
export function selectMcpAudience(
  resources: string[],
  opts: { projectsDomain: string; platformAudience: string },
): string {
  if (resources.length === 0) return opts.platformAudience;
  if (resources.length > 1) throw new InvalidTargetError(resources.join(' '), 'multiple');
  return canonicalMcpAudience(resources[0], opts);
}
