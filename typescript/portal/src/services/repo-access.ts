// Converges a project's Gitea repo onto its portal-side access state:
//
//   - repo visibility:   repo default `none` → private repo;
//                        `read`/`write`      → org-visible repo
//   - collaborators:     explicit repo grants (direct + group-expanded) at
//                        their level, plus — when the repo default is `write`
//                        — every provisioned member at `write` (Gitea has no
//                        "all authenticated users may push" switch, so the
//                        default is materialized as a collaborator fan-out)
//
// THE PORTAL IS THE SOURCE OF TRUTH: collaborators added by hand in Gitea's
// UI are removed on the next reconcile (uniform state over side-channels).
// The repo owner and the cvportal admin account are never touched.
//
// Every Gitea op is individually best-effort: one missing Gitea account (a
// member who was never provisioned) must not abort the rest of the converge.
// Callers treat the returned error list as a log-and-continue signal, matching
// the platform's provisioning conventions.

import {
  Project, GrantLevel, repoDefaultAccess, listProjectsWithRepoDefaultWrite,
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

  // Default `write` → every provisioned member can push. O(members) Gitea
  // calls on first converge; subsequent reconciles only touch the delta.
  if (repoDefaultAccess(project) === 'write') {
    const identities = await listAllHumanIdentities();
    for (const identity of identities) {
      if (identity.id === project.owner_id) continue;
      bump(giteaUsernameForIdentity(identity), 'write');
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

  const repoDefault = repoDefaultAccess(project);
  try {
    await setRepoVisibility({ owner, repo, private: repoDefault === 'none' });
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
    try {
      await removeCollaborator({ owner, repo, username });
      result.removed.push(username);
    } catch (e: any) {
      result.errors.push(`remove ${username}: ${e?.message}`);
    }
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

// Give a newly provisioned member push access to every default-`write` repo.
// Called from identity provisioning; best-effort.
export async function addMemberToDefaultWriteRepos(username: string, userId: string): Promise<void> {
  if (!giteaEnabled()) return;
  if (!isValidUsername(username) || isReservedUsername(username)) return;
  let projects: Project[];
  try { projects = await listProjectsWithRepoDefaultWrite(); }
  catch (e: any) { console.error('[repo-access] default-write listing failed:', e?.message); return; }
  for (const project of projects) {
    if (!project.gitea_repo || project.owner_id === userId) continue;
    const [owner, repo] = project.gitea_repo.split('/');
    try { await setCollaborator({ owner, repo, username, permission: 'write' }); }
    catch (e: any) { console.warn(`[repo-access] default-write add ${username} → ${project.slug} failed:`, e?.message); }
  }
}
