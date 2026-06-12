// Converges a project's Gitea repo onto its portal-side access state:
//
//   - repo visibility:   ALWAYS private. Project repos are owned by the owner's
//                        personal Gitea account, which has no org-internal tier,
//                        so a non-private repo is anonymously cloneable from the
//                        internet (finding F1). Member access is never granted
//                        by flipping the repo public — only via collaborators.
//   - collaborators:     explicit repo grants (direct + group-expanded) at
//                        their level, plus — when the repo default is `read` or
//                        `write` — every provisioned member at that level (the
//                        default is materialised as a collaborator fan-out,
//                        since there is no "all members may read/push" switch).
//
// THE PORTAL IS THE SOURCE OF TRUTH: collaborators added by hand in Gitea's
// UI are removed on the next reconcile (uniform state over side-channels).
// The repo owner and the cvportal admin account are never touched.
//
// Every Gitea op is individually best-effort: one missing Gitea account (a
// member who was never provisioned) must not abort the rest of the converge.
// Callers treat the returned error list as a log-and-continue signal, matching
// the platform's provisioning conventions. A revocation (collaborator removal)
// that fails transiently is retried here and re-attempted by the periodic
// reconcile sweep (reconcileAllProjects), so stale write access self-heals.

import {
  Project, GrantLevel, DefaultAccess, repoDefaultAccess,
  listProjectsWithSharedRepoDefault, listAllProjects,
} from './projects';
import { listProjectGrants, listGroupMembers, listProjectsGrantedToGroup } from './access';
import {
  giteaEnabled, listCollaborators, setCollaborator, removeCollaborator,
  setRepoVisibility, GiteaRepoPermission,
} from './gitea';
import { listAllHumanIdentities } from './kratos-admin';
import { isReservedUsername, isValidUsername } from './reserved-names';

const PERM_RANK: Record<GiteaRepoPermission, number> = { read: 1, write: 2, admin: 3 };

// Gitea login for an identity, mirroring the provisioning convention:
// preferred_username, else the email local part (Google signups have no
// username trait). Null when neither yields a usable name.
export function giteaUsernameForIdentity(identity: { traits?: any }): string | null {
  const traits = (identity.traits ?? {}) as Record<string, any>;
  const candidate = traits.preferred_username
    || (typeof traits.email === 'string' && traits.email.includes('@') ? traits.email.split('@')[0] : null);
  if (!candidate || !isValidUsername(candidate) || isReservedUsername(candidate)) return null;
  return candidate;
}

export interface RepoAccessSyncResult {
  skipped: boolean;
  added: string[];
  removed: string[];
  errors: string[];
}

// Compute the desired collaborator map for a project: username → level.
async function desiredCollaborators(project: Project): Promise<Map<string, GiteaRepoPermission>> {
  const desired = new Map<string, GiteaRepoPermission>();
  const bump = (username: string | null | undefined, perm: GrantLevel) => {
    if (!username || !isValidUsername(username) || isReservedUsername(username)) return;
    const prev = desired.get(username);
    if (!prev || PERM_RANK[perm] > PERM_RANK[prev]) desired.set(username, perm);
  };

  for (const grant of await listProjectGrants(project.id)) {
    if (!grant.repo_perm) continue;
    if (grant.subject_type === 'user') {
      bump(grant.gitea_username, grant.repo_perm);
    } else {
      for (const member of await listGroupMembers(grant.subject_id)) {
        bump(member.username, grant.repo_perm);
      }
    }
  }

  // Default `read`/`write` → every provisioned member gets that level (repos
  // are always private, so even `read` sharing must be a collaborator). O(members)
  // Gitea calls on first converge; subsequent reconciles only touch the delta.
  const repoDefault = repoDefaultAccess(project);
  if (repoDefault === 'read' || repoDefault === 'write') {
    const identities = await listAllHumanIdentities();
    for (const identity of identities) {
      if (identity.id === project.owner_id) continue;
      bump(giteaUsernameForIdentity(identity), repoDefault);
    }
  }

  return desired;
}

// Converge Gitea (visibility + collaborator set) onto the project's access
// state. Idempotent; safe to call after any grant/default/membership change.
export async function syncRepoAccess(project: Project): Promise<RepoAccessSyncResult> {
  const result: RepoAccessSyncResult = { skipped: false, added: [], removed: [], errors: [] };
  if (!giteaEnabled() || !project.gitea_repo) {
    return { ...result, skipped: true };
  }
  const [owner, repo] = project.gitea_repo.split('/');
  if (!owner || !repo) return { ...result, skipped: true };

  // Re-assert private on every converge — the repo must never be world-readable,
  // and this also re-privatises a repo a tenant flipped public by hand.
  try {
    await setRepoVisibility({ owner, repo, private: true });
  } catch (e: any) {
    result.errors.push(`visibility: ${e?.message}`);
  }

  let desired: Map<string, GiteaRepoPermission>;
  try {
    desired = await desiredCollaborators(project);
  } catch (e: any) {
    result.errors.push(`compute desired set: ${e?.message}`);
    return result;
  }
  desired.delete(owner); // repo owner has implicit admin

  let current: Array<{ username: string; permission: GiteaRepoPermission }>;
  try {
    current = await listCollaborators({ owner, repo });
  } catch (e: any) {
    result.errors.push(`list collaborators: ${e?.message}`);
    return result;
  }
  const currentByName = new Map(current.map((c) => [c.username, c.permission]));

  for (const [username, permission] of desired) {
    if (currentByName.get(username) === permission) continue;
    try {
      await setCollaborator({ owner, repo, username, permission });
      result.added.push(`${username}:${permission}`);
    } catch (e: any) {
      // Most common: the member has no Gitea account yet (never provisioned).
      result.errors.push(`${username}: ${e?.message}`);
    }
  }

  for (const { username } of current) {
    if (desired.has(username)) continue;
    if (username === owner || isReservedUsername(username)) continue;
    // Revocation is a security property: a collaborator who lost their grant
    // MUST be removed. Retry a transient failure before giving up; whatever
    // still fails is surfaced in errors and re-attempted by the periodic
    // reconcile sweep, so stale write access can't persist silently.
    let removed = false;
    for (let attempt = 0; attempt < 3 && !removed; attempt++) {
      try {
        await removeCollaborator({ owner, repo, username });
        removed = true;
      } catch (e: any) {
        if (attempt === 2) result.errors.push(`remove ${username}: ${e?.message}`);
      }
    }
    if (removed) result.removed.push(username);
  }

  if (result.errors.length) {
    console.warn(`[repo-access] partial converge for ${project.slug}:`, result.errors.join('; '));
  }
  return result;
}

// Re-converge every project that grants this group repo access. Called on
// group membership changes; best-effort per project.
export async function syncProjectsForGroup(groupId: string): Promise<void> {
  const projects = await listProjectsGrantedToGroup(groupId);
  for (const project of projects) {
    try { await syncRepoAccess(project); }
    catch (e: any) { console.error(`[repo-access] group converge failed for ${project.slug}:`, e?.message); }
  }
}

// Give a newly provisioned member collaborator access to every repo whose
// default is `read` or `write`, at that default's level. Called from identity
// provisioning; best-effort.
export async function addMemberToDefaultAccessRepos(username: string, userId: string): Promise<void> {
  if (!giteaEnabled()) return;
  if (!isValidUsername(username) || isReservedUsername(username)) return;
  let projects: Project[];
  try { projects = await listProjectsWithSharedRepoDefault(); }
  catch (e: any) { console.error('[repo-access] shared-default listing failed:', e?.message); return; }
  for (const project of projects) {
    if (!project.gitea_repo || project.owner_id === userId) continue;
    const level: DefaultAccess = repoDefaultAccess(project);
    if (level !== 'read' && level !== 'write') continue;
    const [owner, repo] = project.gitea_repo.split('/');
    try { await setCollaborator({ owner, repo, username, permission: level }); }
    catch (e: any) { console.warn(`[repo-access] default-${level} add ${username} → ${project.slug} failed:`, e?.message); }
  }
}

// Periodic full reconcile of every project's repo access. Triggered changes
// (grant/default/membership edits) are the fast path; this sweep is the
// self-heal for any converge step that failed transiently — most importantly a
// collaborator removal (revocation) that a Gitea blip left stale. Best-effort
// and serial to keep Gitea load gentle.
export async function reconcileAllProjects(): Promise<void> {
  if (!giteaEnabled()) return;
  let projects: Project[];
  try { projects = await listAllProjects(); }
  catch (e: any) { console.error('[repo-access] periodic reconcile listing failed:', e?.message); return; }
  for (const project of projects) {
    if (!project.gitea_repo) continue;
    try { await syncRepoAccess(project); }
    catch (e: any) { console.error(`[repo-access] periodic reconcile failed for ${project.slug}:`, e?.message); }
  }
}
