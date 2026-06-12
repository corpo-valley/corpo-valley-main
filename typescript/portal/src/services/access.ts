// Groups + per-project access grants.
//
// A project has two independent areas a member can be granted access to:
//   - site: the deployed website at <slug>.<PROJECTS_DOMAIN>. Levels read/
//     write/admin are the developer-facing X-CV-Perm classes; `read` is the
//     floor required to reach the site at all (enforced at the ingress edge
//     via routes/site-access.ts).
//   - repo: the project's Gitea repository. Levels map 1:1 onto Gitea
//     collaborator permissions (services/repo-access.ts reconciles them).
//
// Effective permission = max(per-project default dial, direct user grants,
// grants to groups the user belongs to); the project owner is always admin.
// Groups are member-created and org-visible (any project owner can grant
// them); the creator and platform admins manage membership. These are portal
// constructs in portal Postgres — unrelated to the Keto `groups` namespace,
// which only carries the platform ADMIN role.

import {
  pool, Project, GrantLevel, EffectivePerm, maxPerm,
  siteDefaultAccess, repoDefaultAccess,
} from './projects';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Group names share a page with project/user names in pickers; keep them
// slug-ish so they render and compare predictably. Reserved names that imply
// platform authority are refused.
const GROUP_NAME_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const RESERVED_GROUP_NAMES = new Set(['admin', 'admins', 'administrators', 'everyone', 'all', 'owner', 'owners', 'cvportal', 'corpo-valley', 'system']);

export function isValidGroupName(name: string): boolean {
  return GROUP_NAME_RE.test(name) && !RESERVED_GROUP_NAMES.has(name);
}

export interface Group {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
}

export interface GroupMember {
  group_id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  added_at: string;
}

export interface ProjectGrant {
  id: string;
  project_id: string;
  subject_type: 'user' | 'group';
  subject_id: string;
  // Display name: the user's email/username, or the group name.
  subject_name: string | null;
  // Gitea login for user grants (denormalized at grant time); null for groups.
  gitea_username: string | null;
  site_perm: GrantLevel | null;
  repo_perm: GrantLevel | null;
  created_at: string;
}

// ── Groups ─────────────────────────────────────────────────────────────────

export async function createGroup(name: string, ownerId: string): Promise<Group> {
  const { rows } = await pool.query<Group>(
    'INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING *',
    [name, ownerId]
  );
  return rows[0];
}

export async function getGroupById(id: string): Promise<Group | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query<Group>('SELECT * FROM groups WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getGroupByName(name: string): Promise<Group | null> {
  const { rows } = await pool.query<Group>('SELECT * FROM groups WHERE name = $1', [name]);
  return rows[0] ?? null;
}

// Org-wide listing with owner + member count, so a grantor can judge a group
// before granting it ("All Engineering (3 members)" created by anyone is
// visibly not org-official).
export async function listGroups(): Promise<Array<Group & { member_count: number }>> {
  const { rows } = await pool.query<Group & { member_count: string }>(
    `SELECT g.*, count(m.user_id) AS member_count
     FROM groups g LEFT JOIN group_members m ON m.group_id = g.id
     GROUP BY g.id ORDER BY g.name`
  );
  return rows.map((r) => ({ ...r, member_count: parseInt(String(r.member_count), 10) || 0 }));
}

export async function deleteGroup(id: string): Promise<void> {
  // Grants pointing at the group go with it — a dangling group grant would
  // read as a permission nobody can inspect.
  await pool.query(`DELETE FROM project_grants WHERE subject_type = 'group' AND subject_id = $1`, [id]);
  await pool.query('DELETE FROM groups WHERE id = $1', [id]);
}

export async function listGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { rows } = await pool.query<GroupMember>(
    'SELECT * FROM group_members WHERE group_id = $1 ORDER BY added_at',
    [groupId]
  );
  return rows;
}

export async function addGroupMember(member: {
  groupId: string; userId: string; username?: string | null; email?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, username, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id, user_id) DO UPDATE SET username = EXCLUDED.username, email = EXCLUDED.email`,
    [member.groupId, member.userId, member.username ?? null, member.email ?? null]
  );
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
}

// Projects that carry a grant for this group — the set the Gitea reconciler
// must re-converge when the group's membership changes.
export async function listProjectsGrantedToGroup(groupId: string): Promise<Project[]> {
  const { rows } = await pool.query<Project>(
    `SELECT p.* FROM projects p
     JOIN project_grants g ON g.project_id = p.id
     WHERE g.subject_type = 'group' AND g.subject_id = $1 AND g.repo_perm IS NOT NULL`,
    [groupId]
  );
  return rows;
}

// ── Grants ─────────────────────────────────────────────────────────────────

export async function listProjectGrants(projectId: string): Promise<ProjectGrant[]> {
  const { rows } = await pool.query<ProjectGrant>(
    'SELECT * FROM project_grants WHERE project_id = $1 ORDER BY created_at',
    [projectId]
  );
  return rows;
}

export async function getGrantById(id: string): Promise<ProjectGrant | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query<ProjectGrant>('SELECT * FROM project_grants WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// Upsert: granting the same subject again replaces its levels rather than
// erroring, which is what an owner adjusting access expects.
export async function upsertProjectGrant(grant: {
  projectId: string;
  subjectType: 'user' | 'group';
  subjectId: string;
  subjectName?: string | null;
  giteaUsername?: string | null;
  sitePerm: GrantLevel | null;
  repoPerm: GrantLevel | null;
}): Promise<ProjectGrant> {
  const { rows } = await pool.query<ProjectGrant>(
    `INSERT INTO project_grants (project_id, subject_type, subject_id, subject_name, gitea_username, site_perm, repo_perm)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, subject_type, subject_id)
     DO UPDATE SET subject_name = EXCLUDED.subject_name, gitea_username = EXCLUDED.gitea_username,
                   site_perm = EXCLUDED.site_perm, repo_perm = EXCLUDED.repo_perm
     RETURNING *`,
    [grant.projectId, grant.subjectType, grant.subjectId, grant.subjectName ?? null,
     grant.giteaUsername ?? null, grant.sitePerm, grant.repoPerm]
  );
  return rows[0];
}

export async function deleteGrant(id: string): Promise<void> {
  await pool.query('DELETE FROM project_grants WHERE id = $1', [id]);
}

// Projects shared with a user via a direct or group grant (any area) — the
// dashboard's "Shared with you" section.
export async function listProjectsSharedWith(userId: string): Promise<Array<Project & { site_perm: EffectivePerm; repo_perm: EffectivePerm }>> {
  const { rows } = await pool.query<Project & { g_site: GrantLevel | null; g_repo: GrantLevel | null }>(
    `SELECT p.*, g.site_perm AS g_site, g.repo_perm AS g_repo
     FROM projects p
     JOIN project_grants g ON g.project_id = p.id
     LEFT JOIN group_members m ON g.subject_type = 'group' AND m.group_id::text = g.subject_id
     WHERE p.owner_id <> $1
       AND ((g.subject_type = 'user' AND g.subject_id = $1)
         OR (g.subject_type = 'group' AND m.user_id = $1))`,
    [userId]
  );
  // A user can match several grants (direct + groups); collapse to max per project.
  const byId = new Map<string, Project & { site_perm: EffectivePerm; repo_perm: EffectivePerm }>();
  for (const r of rows) {
    const prev = byId.get(r.id);
    const site = maxPerm(prev?.site_perm, r.g_site);
    const repo = maxPerm(prev?.repo_perm, r.g_repo);
    byId.set(r.id, { ...r, site_perm: site, repo_perm: repo });
  }
  return [...byId.values()];
}

// ── Effective permission resolution ────────────────────────────────────────

// All grant levels that apply to (project, user) in one query: direct user
// grants plus grants to any group the user belongs to.
async function grantLevelsFor(projectId: string, userId: string): Promise<Array<{ site_perm: GrantLevel | null; repo_perm: GrantLevel | null }>> {
  const { rows } = await pool.query<{ site_perm: GrantLevel | null; repo_perm: GrantLevel | null }>(
    `SELECT g.site_perm, g.repo_perm
     FROM project_grants g
     LEFT JOIN group_members m ON g.subject_type = 'group' AND m.group_id::text = g.subject_id
     WHERE g.project_id = $1
       AND ((g.subject_type = 'user' AND g.subject_id = $2)
         OR (g.subject_type = 'group' AND m.user_id = $2))`,
    [projectId, userId]
  );
  return rows;
}

// The caller's effective permission on the project's SITE area. Owner is
// always admin; otherwise max(default dial, applicable grants). This is what
// the ingress auth subrequest (routes/site-access.ts) stamps into X-CV-Perm.
export async function effectiveSitePerm(project: Project, userId: string): Promise<EffectivePerm> {
  if (project.owner_id === userId) return 'admin';
  const grants = await grantLevelsFor(project.id, userId);
  return maxPerm(siteDefaultAccess(project), ...grants.map((g) => g.site_perm));
}

// The caller's effective permission on the project's REPO area. Informational
// portal-side (Gitea enforces the real thing via collaborators).
export async function effectiveRepoPerm(project: Project, userId: string): Promise<EffectivePerm> {
  if (project.owner_id === userId) return 'admin';
  const grants = await grantLevelsFor(project.id, userId);
  return maxPerm(repoDefaultAccess(project), ...grants.map((g) => g.repo_perm));
}
