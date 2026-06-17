// Repo-access management for the Community Center template repo
// (corpo-valley/community-center) — the single Gitea template every project is
// generated from.
//
// Access model:
//   - `cvportal` (the platform site-admin) owns the repo and is the only
//     account allowed to push directly to `main`; it seeds the template on
//     startup. Branch protection forces everyone else through a PR.
//   - Every platform ADMIN is auto-added as a `write` collaborator, kept in
//     sync by role changes (promote → add, demote → remove) and a startup
//     add-only reconcile.
//   - An admin may additionally grant a non-admin human `write` access by hand
//     (the "manual" list). That list is DERIVED, never stored:
//        manual = collaborators − admins − cvportal/reserved/bots.
//
// `write` in Gitea = create branches + merge PRs (but NOT direct push to main,
// which branch protection restricts to the whitelist). So write collaborators
// can push feature branches and merge PRs; only cvportal can push main.
//
// Everything that runs in the background (startup reconcile, role-change hook,
// branch protection) is best-effort and never throws — a Gitea hiccup must not
// block startup or a role change. The interactive add/remove paths DO surface
// errors to the admin so a failed grant isn't silently dropped.

import {
  giteaEnabled, giteaAdminUsername,
  listCollaborators, setCollaborator, removeCollaborator,
  setBranchProtection, getBranchProtection, GiteaRepoPermission,
} from './gitea';
import { TEMPLATE_GITEA_OWNER, TEMPLATE_GITEA_REPO } from './templates';
import { giteaUsernameForIdentity } from './repo-access';
import { listAdminUserIds } from './keto';
import {
  getIdentity, findIdentityByEmail, findIdentityByUsername,
} from './kratos-admin';
import { isReservedUsername, isValidUsername } from './reserved-names';

const OWNER = TEMPLATE_GITEA_OWNER;
const REPO = TEMPLATE_GITEA_REPO;

// True for the cvportal/reserved accounts and `*.bot` companions — never a
// valid manual-grant target and always filtered out of the manual list.
function isReservedTarget(username: string): boolean {
  return !isValidUsername(username) || isReservedUsername(username);
}

// The Gitea usernames of all current platform admins. Best-effort per identity:
// an admin whose identity is missing or has no derivable Gitea username is just
// skipped (they simply won't be auto-managed), never aborting the whole set.
async function adminGiteaUsernames(): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = await listAdminUserIds();
  for (const id of ids) {
    let username: string | null = null;
    try {
      const identity = await getIdentity(id);
      username = giteaUsernameForIdentity(identity);
    } catch (err: any) {
      console.warn('[community-center] could not resolve admin identity', id, err?.message);
    }
    if (username) out.add(username.toLowerCase());
  }
  return out;
}

export interface ManualCollaborator {
  username: string;
  permission: GiteaRepoPermission;
}

// The manually-added, non-admin collaborators on community-center. Derived:
//   manual = listCollaborators − admins − cvportal/reserved/bots.
export async function listManualCollaborators(): Promise<ManualCollaborator[]> {
  if (!giteaEnabled()) return [];
  const [collaborators, admins] = await Promise.all([
    listCollaborators({ owner: OWNER, repo: REPO }),
    adminGiteaUsernames(),
  ]);
  const adminUser = giteaAdminUsername().toLowerCase();
  return collaborators.filter((c) => {
    const u = c.username.toLowerCase();
    if (u === adminUser) return false;
    if (isReservedTarget(c.username)) return false;
    if (admins.has(u)) return false;
    return true;
  });
}

export interface GrantResult {
  ok: boolean;
  username?: string;
  message: string;
}

// Manually grant `write` to a non-admin human, resolved from an email or
// username. Rejects bots, the cvportal/reserved accounts, and admins (those are
// auto-managed by role changes — granting them here would be a no-op the
// reconcile owns). Surfaces a clear message either way; the caller renders it.
export async function grantManualAccess(identifier: string): Promise<GrantResult> {
  if (!giteaEnabled()) {
    return { ok: false, message: 'Gitea integration is not configured on this deployment.' };
  }
  const id = (identifier || '').trim();
  if (!id) return { ok: false, message: 'Enter an email address or username.' };

  // Resolve email → identity, else treat as a username.
  let identity;
  try {
    identity = id.includes('@')
      ? await findIdentityByEmail(id)
      : await findIdentityByUsername(id);
  } catch (err: any) {
    console.error('[community-center] identity lookup failed for', id, err?.message);
    return { ok: false, message: 'Could not look up that user — see portal logs.' };
  }
  if (!identity) {
    return { ok: false, message: `No user found matching "${id}".` };
  }

  // Bots are machine identities — never a manual collaborator.
  const meta = (identity.metadata_public ?? {}) as Record<string, any>;
  if (meta.type === 'bot') {
    return { ok: false, message: 'Bot identities cannot be granted template access.' };
  }

  const username = giteaUsernameForIdentity(identity);
  if (!username) {
    return { ok: false, message: 'That user has no usable Gitea username (no preferred_username or email-derivable name).' };
  }
  if (isReservedTarget(username)) {
    return { ok: false, message: `"${username}" is a reserved platform account and cannot be a collaborator.` };
  }

  // Admins are auto-managed: their write access follows their role, so a manual
  // grant would be redundant and confusing (a later demote would remove it).
  let isAdmin = false;
  try {
    isAdmin = (await adminGiteaUsernames()).has(username.toLowerCase());
  } catch (err: any) {
    console.error('[community-center] admin check failed during grant for', username, err?.message);
    return { ok: false, message: 'Could not verify the user\'s role — see portal logs.' };
  }
  if (isAdmin) {
    return {
      ok: false,
      username,
      message: `${username} is a platform admin and already has template write access automatically — manage it via their role, not here.`,
    };
  }

  try {
    await setCollaborator({ owner: OWNER, repo: REPO, username, permission: 'write' });
  } catch (err: any) {
    console.error('[community-center] setCollaborator failed for', username, err?.message);
    return { ok: false, username, message: `Failed to grant access to ${username} — see portal logs.` };
  }
  return { ok: true, username, message: `Granted ${username} write access to the template repo.` };
}

// Manually revoke a non-admin collaborator. Only the manual list offers this,
// but we re-guard: never remove cvportal/reserved or an admin (their access is
// owned by the role reconcile, not this control).
export async function revokeManualAccess(username: string): Promise<GrantResult> {
  if (!giteaEnabled()) {
    return { ok: false, message: 'Gitea integration is not configured on this deployment.' };
  }
  const u = (username || '').trim();
  if (!u) return { ok: false, message: 'Missing username.' };
  if (u.toLowerCase() === giteaAdminUsername().toLowerCase() || isReservedTarget(u)) {
    return { ok: false, message: `Refusing to remove reserved account "${u}".` };
  }
  try {
    if ((await adminGiteaUsernames()).has(u.toLowerCase())) {
      return {
        ok: false,
        username: u,
        message: `${u} is a platform admin — their access is managed by their role. Demote them to remove template access.`,
      };
    }
  } catch (err: any) {
    console.error('[community-center] admin check failed during revoke for', u, err?.message);
    return { ok: false, message: 'Could not verify the user\'s role — see portal logs.' };
  }
  try {
    await removeCollaborator({ owner: OWNER, repo: REPO, username: u });
  } catch (err: any) {
    console.error('[community-center] removeCollaborator failed for', u, err?.message);
    return { ok: false, username: u, message: `Failed to remove ${u} — see portal logs.` };
  }
  return { ok: true, username: u, message: `Removed ${u} from the template repo.` };
}

// Drive repo access from an admin role change. Promote → add write; demote →
// remove. Best-effort: logs on failure and never throws, so it can't fail the
// role-change request it's hooked into. No-op when the identity has no usable
// Gitea username.
export async function applyAdminRoleToRepo(userId: string, isAdmin: boolean): Promise<void> {
  if (!giteaEnabled()) return;
  let username: string | null = null;
  try {
    const identity = await getIdentity(userId);
    username = giteaUsernameForIdentity(identity);
  } catch (err: any) {
    console.error('[community-center] applyAdminRoleToRepo: identity lookup failed for', userId, err?.message);
    return;
  }
  if (!username || isReservedTarget(username)) return;
  try {
    if (isAdmin) {
      await setCollaborator({ owner: OWNER, repo: REPO, username, permission: 'write' });
      console.log(`[community-center] added admin ${username} as template write collaborator`);
    } else {
      await removeCollaborator({ owner: OWNER, repo: REPO, username });
      console.log(`[community-center] removed demoted user ${username} from template collaborators`);
    }
  } catch (err: any) {
    console.error('[community-center] applyAdminRoleToRepo failed for', username, err?.message);
  }
}

// Startup reconcile: ensure every current admin is a write collaborator.
// ADD-ONLY — we never remove anyone here, so manual non-admin grants and any
// admin demoted while the portal was down are not clobbered (removal only
// happens on an explicit demote via applyAdminRoleToRepo). Best-effort.
export async function syncCommunityCenterAdmins(): Promise<void> {
  if (!giteaEnabled()) return;
  let adminIds: string[];
  try {
    adminIds = await listAdminUserIds();
  } catch (err: any) {
    console.error('[community-center] admin reconcile: listAdminUserIds failed:', err?.message);
    return;
  }
  let added = 0;
  for (const id of adminIds) {
    let username: string | null = null;
    try {
      const identity = await getIdentity(id);
      username = giteaUsernameForIdentity(identity);
    } catch (err: any) {
      console.warn('[community-center] admin reconcile: identity lookup failed for', id, err?.message);
      continue;
    }
    if (!username || isReservedTarget(username)) continue;
    try {
      await setCollaborator({ owner: OWNER, repo: REPO, username, permission: 'write' });
      added++;
    } catch (err: any) {
      console.warn('[community-center] admin reconcile: setCollaborator failed for', username, err?.message);
    }
  }
  console.log(`[community-center] admin reconcile: ensured ${added}/${adminIds.length} admin(s) as write collaborators`);
}

// Apply branch protection on community-center `main`: only cvportal may push
// directly (so startup seeding still works); everyone else is forced to PR.
// Status checks are NOT enabled (the template repo runs no scans), so merges
// aren't blocked on checks/approvals. Idempotent; best-effort.
export async function ensureCommunityCenterBranchProtection(): Promise<void> {
  if (!giteaEnabled()) return;
  try {
    await setBranchProtection({
      owner: OWNER,
      repo: REPO,
      branch: 'main',
      pushWhitelistUsernames: [giteaAdminUsername()],
      enableStatusCheck: false,
    });
    console.log(`[community-center] branch protection applied on ${OWNER}/${REPO}@main (force-PR; only ${giteaAdminUsername()} may push directly)`);
  } catch (err: any) {
    console.error('[community-center] branch protection failed:', err?.message);
  }
}

export interface BranchProtectionStatus {
  configured: boolean;
  forcesPr: boolean;            // direct push restricted to a whitelist
  pushWhitelist: string[];
  statusChecksEnabled: boolean;
}

export interface CommunityCenterAccessOverview {
  giteaEnabled: boolean;
  repo: string;
  adminCount: number;          // admins with a derivable Gitea username
  manual: ManualCollaborator[];
  branchProtection: BranchProtectionStatus;
  error?: string;              // set when a read failed; UI shows it instead of crashing
}

// Everything the admin "Repo access" panel needs in one call. Degrades
// gracefully: when Gitea is off it returns a disabled overview; when a read
// throws it returns what it has plus an `error` string rather than crashing the
// page.
export async function communityCenterAccessOverview(): Promise<CommunityCenterAccessOverview> {
  const repo = `${OWNER}/${REPO}`;
  const base: CommunityCenterAccessOverview = {
    giteaEnabled: giteaEnabled(),
    repo,
    adminCount: 0,
    manual: [],
    branchProtection: { configured: false, forcesPr: false, pushWhitelist: [], statusChecksEnabled: false },
  };
  if (!giteaEnabled()) return base;

  try {
    const admins = await adminGiteaUsernames();
    base.adminCount = admins.size;

    const collaborators = await listCollaborators({ owner: OWNER, repo: REPO });
    const adminUser = giteaAdminUsername().toLowerCase();
    base.manual = collaborators.filter((c) => {
      const u = c.username.toLowerCase();
      if (u === adminUser) return false;
      if (isReservedTarget(c.username)) return false;
      if (admins.has(u)) return false;
      return true;
    });

    const bp = await getBranchProtection({ owner: OWNER, repo: REPO, branch: 'main' });
    if (bp) {
      base.branchProtection = {
        configured: true,
        forcesPr: bp.enablePush && bp.enablePushWhitelist,
        pushWhitelist: bp.pushWhitelistUsernames,
        statusChecksEnabled: bp.enableStatusCheck,
      };
    }
  } catch (err: any) {
    console.error('[community-center] access overview read failed:', err?.message);
    base.error = 'Could not read template repo access from Gitea — see portal logs.';
  }
  return base;
}
