// Root-cause defense for the MCP confused-deputy: a client can request ANY
// resource indicator, so before Hydra stamps a per-project MCP resource into a
// token's `aud`, drop any such audience the consenting subject has no effective
// SITE access to. The keep/drop decision mirrors the per-project MCP gateway's
// authorization model exactly (mcp-gateway sitePermission() with
// MIN_SITE_PERM='read', backed by GET /internal/projects/:slug/access/:sub →
// effectiveSitePerm): owner, direct user grants, group grants, and the
// org-wide `everyone` grant (internal projects) all count — not just
// ownership. Non-project audiences (the platform MCP, OIDC clients) pass
// through untouched. Fails CLOSED: an unknown project or a failed lookup drops
// the audience. The gateway re-checks access per request; this stops the token
// issuing at all.
import { projectSlugFromResource } from '../shared/mcp-resources';

export type SitePerm = 'none' | 'read' | 'write' | 'admin';

export interface AudienceFilterDeps<P> {
  projectsDomain: string;
  getProjectBySlug(slug: string): Promise<P | null | undefined>;
  effectiveSitePerm(project: P, subject: string): Promise<SitePerm>;
  warn?: (msg: string, ctx: Record<string, unknown>) => void;
}

export function createAudienceFilter<P>(deps: AudienceFilterDeps<P>) {
  const warn = deps.warn ?? ((msg, ctx) => console.warn(msg, ctx));
  return async function filterAccessibleAudiences(requested: string[], subject: string): Promise<string[]> {
    const out: string[] = [];
    for (const aud of requested) {
      const slug = projectSlugFromResource(aud, deps.projectsDomain);
      if (!slug) { out.push(aud); continue; }
      let allowed = false;
      try {
        const project = await deps.getProjectBySlug(slug);
        // Effective site permission >= read (i.e. anything above 'none') is the
        // same floor the gateway enforces (MIN_SITE_PERM = 'read').
        allowed = !!project && (await deps.effectiveSitePerm(project, subject)) !== 'none';
      } catch (err: any) {
        warn('[consent] audience access lookup failed — dropping audience (fail closed)', { aud, subject, error: err?.message });
        continue;
      }
      if (allowed) {
        out.push(aud);
      } else {
        warn('[consent] dropping audience for project the subject has no site access to', { aud, subject });
      }
    }
    return out;
  };
}

/** True when any granted audience is a per-project MCP resource. */
export function hasProjectAudience(audiences: string[], projectsDomain: string): boolean {
  return audiences.some((a) => projectSlugFromResource(a, projectsDomain) !== null);
}
