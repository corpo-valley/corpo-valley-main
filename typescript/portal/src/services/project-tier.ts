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
// The owner and platform admins are always `admin`. For everyone else:
//   - only EXPLICIT grants count (direct user or group). The org-wide
//     `everyone` grant means "any member may use the deployed site / clone the
//     repo" and must never open the management page — otherwise an owner who
//     sets General access = write (a statement about the APP) would let every
//     signed-in user commit secrets to the repo.
//   - read / write come from the REPO facet, exactly like the MCP tools
//     (`resolveAccessibleProject` → effectiveRepoPerm). Site write means
//     "mutate your own data in the app", not "change the project".
//   - `admin` on EITHER facet makes a project admin: that is what an owner
//     means when they pick admin in the Share panel.

const TIER_RANK: Record<EffectivePerm, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function tierAtLeast(tier: EffectivePerm, min: GrantLevel): boolean {
  return TIER_RANK[tier] >= TIER_RANK[min];
}

export interface GrantLevels {
  site_perm: GrantLevel | null;
  repo_perm: GrantLevel | null;
  // 'user' | 'group' | 'everyone' — `everyone` rows are ignored here.
  subject_type?: string;
}

export function projectTierFromGrants(
  project: { owner_id: string },
  userId: string,
  platformAdmin: boolean,
  grants: GrantLevels[],
): EffectivePerm {
  if (platformAdmin || project.owner_id === userId) return 'admin';
  let best: EffectivePerm = 'none';
  const bump = (p: GrantLevel | null | undefined) => {
    if (p && TIER_RANK[p] > TIER_RANK[best]) best = p;
  };
  for (const g of grants) {
    if (g.subject_type === 'everyone') continue;
    bump(g.repo_perm);
    if (g.site_perm === 'admin') bump('admin');
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
