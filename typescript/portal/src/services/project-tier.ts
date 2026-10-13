import type { GrantLevel, EffectivePerm } from './projects';

// ── Dashboard project tier ───────────────────────────────────────────────────
// What a signed-in viewer may do with a project on the PORTAL (detail page,
// secrets, capabilities, sharing, delete). Pure functions so the policy is
// unit-testable without a database; services/access.ts wires the grant query.
//
// The ladder mirrors the MCP tools in services/mcp.ts:
//   read  → view the project page and status
//   write → sealed secrets, enable/disable Postgres and storage (keeping data)
//   admin → delete the project, destroy data volumes, manage sharing
// The owner and platform admins are always `admin`. Everyone else gets the
// highest level across BOTH facets of every applicable grant (direct, group,
// `everyone`) — a project admin on either facet administers the project.
// `everyone` grants can never carry admin (DB CHECK), so admin only ever comes
// from an explicit grant by the owner.

const TIER_RANK: Record<EffectivePerm, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function tierAtLeast(tier: EffectivePerm, min: GrantLevel): boolean {
  return TIER_RANK[tier] >= TIER_RANK[min];
}

export interface GrantLevels { site_perm: GrantLevel | null; repo_perm: GrantLevel | null; }

export function projectTierFromGrants(
  project: { owner_id: string },
  userId: string,
  platformAdmin: boolean,
  grants: GrantLevels[],
): EffectivePerm {
  if (platformAdmin || project.owner_id === userId) return 'admin';
  let best: EffectivePerm = 'none';
  for (const g of grants) {
    for (const p of [g.site_perm, g.repo_perm]) {
      if (p && TIER_RANK[p] > TIER_RANK[best]) best = p;
    }
  }
  return best;
}

// Human copy for a 403 when the viewer can see the project but lacks `min`.
export function tierRequiredMessage(min: GrantLevel): string {
  const what = min === 'admin'
    ? 'Only the project owner and project admins can do that.'
    : min === 'write'
      ? 'You need write access on this project to do that.'
      : 'You need access to this project to do that.';
  return what;
}
