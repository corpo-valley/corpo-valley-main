// The MCP authorization facade's decision logic, as a pure function of the
// authorize request's query string — so it can be unit-tested without Express,
// Hydra, or the database. routes/mcp.ts owns the HTTP shell.
import { InvalidTargetError, projectSlugFromResource, selectMcpAudience } from '../shared/mcp-resources';

export interface FacadeDeps {
  projectsDomain: string;
  platformAudience: string;
  hydraPublicUrl: string;
  /** Does a project with this slug exist? (Existence only — access is decided at consent.) */
  projectExists(slug: string): Promise<boolean>;
  ensureClientAudience(clientId: string, audience: string): Promise<void>;
  log?: { warn(msg: string, ctx: Record<string, unknown>): void; error(msg: string, ctx: Record<string, unknown>): void };
}

export type FacadePlan =
  | { kind: 'redirect'; location: string; audience: string }
  | { kind: 'error'; status: number; body: { error: string; error_description: string } };

export const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;

export async function planMcpAuthorize(queryString: string, deps: FacadeDeps): Promise<FacadePlan> {
  const log = deps.log ?? console;
  const params = new URLSearchParams(queryString);

  const clientId = params.get('client_id');
  if (!clientId || !CLIENT_ID_RE.test(clientId)) {
    return { kind: 'error', status: 400, body: { error: 'invalid_request', error_description: 'client_id is required' } };
  }

  // RFC 8707 `resource` selects the audience: absent → platform, exactly one
  // → its canonical form, several → hard error (exactly one audience per
  // token, never a merge). Deliberately NO fallback to the platform audience
  // on malformed input: a typo'd project resource must not yield a token
  // carrying platform-wide authority (RFC 8707 §2.2).
  let audience: string;
  try {
    audience = selectMcpAudience(params.getAll('resource'), deps);
  } catch (err) {
    if (!(err instanceof InvalidTargetError)) throw err;
    log.warn('[mcp] facade: rejected resource indicator', { clientId, reason: err.reason, resource: err.resource });
    return {
      kind: 'error', status: 400,
      body: { error: 'invalid_target', error_description: err.reason === 'multiple' ? 'exactly one resource may be requested' : 'unrecognized MCP resource' },
    };
  }

  // A canonical project resource is only a grammar match. This endpoint is
  // unauthenticated and the next step writes to the client's Hydra allowlist,
  // so require the project to EXIST before touching Hydra — otherwise anyone
  // could fill any public client id's allowlist with garbage. Access to the
  // project is decided later, at consent, by the authenticated subject.
  const slug = projectSlugFromResource(audience, deps.projectsDomain);
  if (slug !== null && !(await deps.projectExists(slug))) {
    log.warn('[mcp] facade: resource names an unknown project', { clientId, slug });
    return { kind: 'error', status: 400, body: { error: 'invalid_target', error_description: 'unrecognized MCP resource' } };
  }

  // Server-controlled: never honour a client-supplied `audience`.
  params.delete('audience');
  params.set('audience', audience);

  // Defensive: force the consent screen for project audiences. Hydra's
  // remembered-consent match keys on client+subject+scope and ignores
  // audience, so a consent provider that honours `skip` could reuse a grant
  // made for a different resource. This portal renders consent every time
  // today (it never reads `skip`), so this is belt-and-braces — kept so the
  // invariant survives a future change. A client's own `prompt=login` is
  // preserved (RFC 6749 §3.1 / OIDC allow a space-separated list).
  if (slug !== null) {
    const wantsLogin = (params.get('prompt') || '').split(/\s+/).includes('login');
    params.set('prompt', wantsLogin ? 'login consent' : 'consent');
  }

  try {
    await deps.ensureClientAudience(clientId, audience);
  } catch (err) {
    // Fail closed: without the allowlist entry Hydra would reject the audience
    // request anyway. Surface a retryable error rather than dropping the binding.
    log.error('[mcp] facade: ensureClientAudience failed', { clientId, audience, msg: (err as Error)?.message });
    return { kind: 'error', status: 502, body: { error: 'temporarily_unavailable', error_description: 'could not prepare client for MCP authorization' } };
  }

  return { kind: 'redirect', location: `${deps.hydraPublicUrl}/oauth2/auth?${params.toString()}`, audience };
}
