// Thin Gitea API client for the Corpo Valley portal. We hit Gitea's REST API
// as an admin to lazy-provision user/bot accounts and per-project repos.
//
// Adapted from the plagueboxmobile `farm` service. Two important auth gotchas
// carried over from there:
//
//   1. Gitea's PAT-management endpoints (/api/v1/users/{name}/tokens) reject
//      `Authorization: token <X>` and only accept HTTP Basic auth. Other
//      endpoints accept either. So we send Basic auth (<admin-user>:<token>)
//      for EVERY call — it works everywhere.
//   2. OIDC ACCOUNT_LINKING=login links humans to their pre-created Gitea
//      account by username on first SSO login, so we create users ahead of
//      time via the admin API with a throwaway password.
//
// All operations are best-effort: callers wrap these in try/catch so that a
// Gitea outage never blocks user or project creation in the portal.

import { isReservedUsername, isValidUsername } from './reserved-names';

// Encode a repo-relative path for a Contents API URL: split on '/' and
// encodeURIComponent each segment, preserving real separators while ensuring a
// '?'/'#'/space inside a segment can't smuggle query params or otherwise alter
// the request. Mirrors the encoding already applied to owner/repo/ref so the
// helpers stay safe regardless of caller. (All current callers pass fixed or
// validated paths; this closes the latent asymmetry.)
function encodeRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

const giteaUrl = (process.env.GITEA_URL || 'http://localhost:3001').replace(/\/+$/, '');
const giteaAdminUser = process.env.GITEA_ADMIN_USER || 'cvportal';
const giteaAdminToken = process.env.GITEA_ADMIN_TOKEN || '';

// Default template that new project repos are generated from when the
// caller doesn't pass a specific one. The full set of available templates
// lives in services/templates.ts; this is just the fallback when
// generateFromTemplate is called without an explicit template repo.
const templateOwner = process.env.GITEA_TEMPLATE_OWNER || 'corpo-valley';
const templateRepo = process.env.GITEA_TEMPLATE_REPO || 'community-center';

const apiBase = `${giteaUrl}/api/v1`;

if (!giteaAdminToken) {
  console.warn(
    '[gitea] GITEA_ADMIN_TOKEN is not set — Gitea integration disabled (account/repo provisioning will be skipped).'
  );
}

// True iff Gitea integration is configured. Callers should short-circuit on
// this so the portal still runs without Gitea wired up (local dev, MVP).
export function giteaEnabled(): boolean {
  return giteaAdminToken.length > 0;
}

// The platform site-admin Gitea username (default `cvportal`). This account
// seeds the template repo, drives manifest/sealed-secret writes, and is the
// one account always whitelisted for direct push under branch protection.
// Exposed so callers (e.g. community-center access management) can name it
// explicitly rather than re-reading the env var.
export function giteaAdminUsername(): string {
  return giteaAdminUser;
}

export class GiteaApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`Gitea API ${status}: ${body?.message || JSON.stringify(body).slice(0, 200)}`);
    this.name = 'GiteaApiError';
  }
}

// Send Basic auth on every call (see gotcha #1 above). Base URL already
// includes /api/v1; pass paths relative to that (e.g. `/users/foo`).
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${apiBase}${path}`;
  const basic = Buffer.from(`${giteaAdminUser}:${giteaAdminToken}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${basic}`,
    Accept: 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok) throw new GiteaApiError(res.status, body);
  return body as T;
}

// One-shot inventory of every repo the platform admin token can see — all of
// them, public AND private (verified against live Gitea: repos/search with the
// cvportal admin token returns private repos too). Keyed by full_name
// (`owner/repo`) → ISO `updated_at`. Powers the Community Feed's "last updated"
// sort with a single call instead of one-per-project. Paginates because Gitea
// caps a page at 50; stops when a page comes back short.
export async function getRepoUpdatedAtMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!giteaEnabled()) return map;
  const limit = 50;
  for (let page = 1; ; page++) {
    const body = await call<{ data?: Array<{ full_name?: string; updated_at?: string }> }>(
      `/repos/search?limit=${limit}&page=${page}`
    );
    const repos = body.data ?? [];
    for (const r of repos) {
      if (r.full_name && r.updated_at) map.set(r.full_name, r.updated_at);
    }
    if (repos.length < limit) break;
  }
  return map;
}

export interface GiteaUser {
  id: number;
  login: string;
  email?: string;
}

// Resolve a username to a Gitea user record, or null if it doesn't exist yet.
// Exported as getGiteaUser for the canonical-username resolver
// (services/gitea-identity.ts), which uses the account's email to tell a
// genuine re-provision from a username collision with a DIFFERENT identity.
export async function getGiteaUser(username: string): Promise<GiteaUser | null> {
  try {
    return await call<GiteaUser>(`/users/${encodeURIComponent(username)}`);
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return null;
    throw err;
  }
}

// Idempotently ensure a Gitea user account exists. Creates via the admin API
// with a random throwaway password (humans link via OIDC on first login by
// username; bots authenticate only via PATs — neither uses this password).
// Returns quietly if the account already exists.
export async function ensureUser(opts: {
  username: string;
  email: string;
  fullName?: string;
}): Promise<void> {
  if (!giteaEnabled()) return;

  // Collision safety: a username already held by a Gitea account whose email is
  // NOT this caller's must never be treated as success — doing so maps two
  // Kratos identities onto one Gitea account, so a repo grant for one lands on
  // the other (privilege misassignment). Only a same-email match is an
  // idempotent re-provision. The canonical-username resolver normally hands us a
  // deduped name, so a foreign collision here is the rare TOCTOU/legacy case;
  // throw so the caller logs it rather than silently sharing the account.
  const sameEmail = (a?: string, b?: string) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const existing = await getGiteaUser(opts.username);
  if (existing) {
    if (sameEmail(existing.email, opts.email)) return;
    throw new GiteaApiError(409, {
      message: `username "${opts.username}" is held by a different Gitea account — refusing to reuse it`,
    });
  }

  const password = randomHex(32);
  try {
    await call('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: opts.username,
        email: opts.email,
        password,
        full_name: opts.fullName ?? '',
        must_change_password: false,
        send_notify: false,
        // source_id omitted on purpose: OIDC ACCOUNT_LINKING=login links the
        // human to this local account by username on first SSO login.
      }),
    });
  } catch (err) {
    // Race: another caller created it concurrently. Re-fetch and accept ONLY if
    // it's the same person (same email); otherwise it's a collision — surface it.
    if (err instanceof GiteaApiError && (err.status === 409 || alreadyExists(err))) {
      const after = await getGiteaUser(opts.username);
      if (after && sameEmail(after.email, opts.email)) return;
      throw new GiteaApiError(409, {
        message: `username "${opts.username}" collided with a different Gitea account during create`,
      });
    }
    throw err;
  }
}

// Delete a Gitea user account (and, with purge, its owned repos/org memberships).
// Idempotent — a 404 (already gone) is success. Used by the admin user-delete
// cascade. Platform-reserved accounts (cvportal, etc.) are refused outright so a
// bug can never reap the site-admin account; the cascade passes allowBot for the
// paired `<name>.bot` account, which IS meant to be reaped here (the `.bot`
// suffix is otherwise reserved only to stop humans impersonating bots).
export async function deleteGiteaUser(username: string, opts: { allowBot?: boolean } = {}): Promise<void> {
  if (!giteaEnabled()) return;
  const isBotName = typeof username === 'string' && username.toLowerCase().endsWith('.bot');
  const reserved = isReservedUsername(username) && !(opts.allowBot && isBotName);
  if (reserved || !isValidUsername(username)) {
    throw new GiteaApiError(0, { message: `refusing to delete reserved or invalid Gitea user "${username}"` });
  }
  try {
    await call(`/admin/users/${encodeURIComponent(username)}?purge=true`, { method: 'DELETE' });
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return;
    throw err;
  }
}

export interface CreateUserRepoOpts {
  ownerUsername: string;
  name: string;
  private?: boolean;
  description?: string;
}

// Create a repo owned by `ownerUsername` via the admin endpoint. Idempotent:
// a 409 / "already exists" is treated as success. Returns the repo full_name
// (`<owner>/<name>`).
export async function createUserRepo(opts: CreateUserRepoOpts): Promise<string> {
  if (!giteaEnabled()) {
    throw new GiteaApiError(0, { message: 'Gitea integration disabled' });
  }

  const fullName = `${opts.ownerUsername}/${opts.name}`;
  try {
    const repo = await call<{ full_name: string }>(
      `/admin/users/${encodeURIComponent(opts.ownerUsername)}/repos`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: opts.name,
          private: opts.private ?? true,
          auto_init: true,
          default_branch: 'main',
          description: opts.description ?? '',
        }),
      }
    );
    return repo.full_name || fullName;
  } catch (err) {
    if (err instanceof GiteaApiError && (err.status === 409 || alreadyExists(err))) {
      return fullName;
    }
    throw err;
  }
}

// Generate a new repo for a user from a template repo, so the project
// ships with the build pipeline + Claude config (not an empty repo).
// templateOwner/templateRepo default to the platform's Community Center
// template; callers pass overrides when the user picks a different
// template at project-create time.
export async function generateFromTemplate(opts: {
  ownerUsername: string;
  name: string;
  private?: boolean;
  description?: string;
  templateOwner?: string;
  templateRepo?: string;
}): Promise<string> {
  if (!giteaEnabled()) {
    throw new GiteaApiError(0, { message: 'Gitea integration disabled' });
  }
  const fullName = `${opts.ownerUsername}/${opts.name}`;
  const tOwner = opts.templateOwner || templateOwner;
  const tRepo = opts.templateRepo || templateRepo;
  try {
    const repo = await call<{ full_name: string }>(
      `/repos/${encodeURIComponent(tOwner)}/${encodeURIComponent(tRepo)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify({
          owner: opts.ownerUsername,
          name: opts.name,
          private: opts.private ?? true,
          description: opts.description ?? '',
          git_content: true,
          default_branch: 'main',
        }),
      }
    );
    return repo.full_name || fullName;
  } catch (err) {
    if (err instanceof GiteaApiError && (err.status === 409 || alreadyExists(err))) {
      return fullName;
    }
    throw err;
  }
}

// ── Template-repo provisioning (template-seed.ts) ────────────────────────

// Fetch a repo's metadata, or null if it doesn't exist.
export async function getRepo(opts: {
  owner: string; repo: string;
}): Promise<{ full_name: string; template: boolean; default_branch: string } | null> {
  if (!giteaEnabled()) return null;
  try {
    return await call<{ full_name: string; template: boolean; default_branch: string }>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`
    );
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return null;
    throw err;
  }
}

// Idempotently ensure an organization exists. Created orgs are public so
// tenants can browse the platform's template repo (AGENTS.md points them at
// it); the org is owned by the cvportal admin account.
export async function ensureOrg(org: string): Promise<void> {
  if (!giteaEnabled()) return;
  try {
    await call(`/orgs/${encodeURIComponent(org)}`);
    return;
  } catch (err) {
    if (!(err instanceof GiteaApiError && err.status === 404)) throw err;
  }
  try {
    await call('/orgs', {
      method: 'POST',
      body: JSON.stringify({ username: org, visibility: 'public' }),
    });
  } catch (err) {
    if (err instanceof GiteaApiError && (err.status === 409 || alreadyExists(err))) return;
    throw err;
  }
}

// Create a public template repo under an org. auto_init gives it a `main`
// branch immediately so the Contents API can sync files without special
// empty-repo handling. Idempotent: 409 / already-exists is success.
export async function createOrgRepo(opts: {
  org: string; name: string; description?: string;
}): Promise<void> {
  if (!giteaEnabled()) return;
  try {
    await call(`/orgs/${encodeURIComponent(opts.org)}/repos`, {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        private: false,
        auto_init: true,
        default_branch: 'main',
        template: true,
        description: opts.description ?? '',
      }),
    });
  } catch (err) {
    if (err instanceof GiteaApiError && (err.status === 409 || alreadyExists(err))) return;
    throw err;
  }
}

// Ensure a repo carries the template flag (generate-from-template refuses
// non-template sources). Idempotent PATCH.
export async function setRepoTemplate(opts: { owner: string; repo: string }): Promise<void> {
  if (!giteaEnabled()) return;
  await call(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`,
    { method: 'PATCH', body: JSON.stringify({ template: true }) }
  );
}

// All blobs in a repo at `ref` (default `main`), recursively. Returns [] for
// a missing ref / empty repo. Pages through Gitea's 1000-entry tree limit.
export async function getTreeFiles(opts: {
  owner: string; repo: string; ref?: string;
}): Promise<Array<{ path: string; sha: string }>> {
  if (!giteaEnabled()) return [];
  const ref = opts.ref || 'main';
  const out: Array<{ path: string; sha: string }> = [];
  for (let page = 1; page <= 10; page++) {
    let res: { tree?: Array<{ path: string; sha: string; type: string }>; truncated?: boolean };
    try {
      res = await call(
        `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true&page=${page}`
      );
    } catch (err) {
      if (err instanceof GiteaApiError && err.status === 404) return out;
      throw err;
    }
    for (const e of res.tree || []) {
      if (e.type === 'blob') out.push({ path: e.path, sha: e.sha });
    }
    if (!res.truncated) break;
  }
  return out;
}

// Fetch the head commit of a branch. Returns null if the branch doesn't
// exist (404). Used as the lookup step for `getCommitStatus(branch)`.
export async function getBranchHead(opts: {
  owner: string; repo: string; branch: string;
}): Promise<{ sha: string; message: string; author?: string; date?: string } | null> {
  if (!giteaEnabled()) return null;
  try {
    const r = await call<{ commit: { id: string; message: string; author?: { name?: string }; timestamp?: string } }>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/branches/${encodeURIComponent(opts.branch)}`
    );
    return {
      sha: r.commit?.id,
      message: r.commit?.message || '',
      author: r.commit?.author?.name,
      date: r.commit?.timestamp,
    };
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return null;
    throw err;
  }
}

// Combined commit status for a sha, including per-check breakdown. Gitea
// 1.22 doesn't expose /actions/runs but does expose commit statuses, which
// the Actions runner emits one-per-job: "Build / build (push)",
// "Scan / semgrep (push)", "Scan / osv-scanner (push)", etc.
export interface RefStatus {
  sha: string;
  state: 'success' | 'failure' | 'pending' | 'error' | 'warning';
  total_count: number;
  checks: Array<{
    context: string;
    state: 'success' | 'failure' | 'pending' | 'error' | 'warning';
    description?: string;
    target_url?: string;
    updated_at?: string;
  }>;
}

export async function getCommitStatus(opts: {
  owner: string; repo: string; sha: string;
}): Promise<RefStatus | null> {
  if (!giteaEnabled()) return null;
  try {
    const r = await call<{
      state: RefStatus['state'];
      sha: string;
      total_count: number;
      statuses: Array<{
        context: string;
        status: RefStatus['state'];
        description?: string;
        target_url?: string;
        updated_at?: string;
      }>;
    }>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/commits/${encodeURIComponent(opts.sha)}/status`
    );
    return {
      sha: r.sha,
      state: r.state,
      total_count: r.total_count,
      checks: (r.statuses || []).map((s) => ({
        context: s.context,
        state: s.status,
        description: s.description,
        target_url: s.target_url,
        updated_at: s.updated_at,
      })),
    };
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return null;
    throw err;
  }
}

// Delete a Gitea repository. Idempotent — a 404 (already gone) is success.
// Used by the project-cascade-delete path so deleting a project from the
// portal also reclaims its Gitea repo, not just the DB row.
export async function deleteRepo(opts: { owner: string; repo: string }): Promise<void> {
  if (!giteaEnabled()) return;
  try {
    await call(`/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return;
    throw err;
  }
}

// ── Collaborators & repo visibility (project access grants) ───────────────
//
// Repo-area grants (read/write/admin) map 1:1 onto Gitea collaborator
// permissions. Project repos are ALWAYS kept private: they are owned by the
// project owner's personal Gitea account, which has no org-internal visibility
// tier — a non-private user repo is world-readable (anonymously cloneable),
// which would expose tenant source. So member read/write access is materialised
// purely as collaborators (services/repo-access.ts converges the set);
// setRepoVisibility only ever re-asserts `private` as a backstop.

export type GiteaRepoPermission = 'read' | 'write' | 'admin';

// Current collaborators with their effective permission level. Gitea reports
// permissions as a {admin, push, pull} object; collapse to our three levels.
export async function listCollaborators(opts: {
  owner: string; repo: string;
}): Promise<Array<{ username: string; permission: GiteaRepoPermission }>> {
  if (!giteaEnabled()) return [];
  const out: Array<{ username: string; permission: GiteaRepoPermission }> = [];
  // Default-write fan-out can produce hundreds of collaborators; page through
  // (50/page, hard cap 40 pages = 2000) rather than truncating silently.
  for (let page = 1; page <= 40; page++) {
    let res: Array<{ login: string; permissions?: { admin?: boolean; push?: boolean; pull?: boolean } }>;
    try {
      res = await call(
        `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/collaborators?limit=50&page=${page}`
      );
    } catch (err) {
      if (err instanceof GiteaApiError && err.status === 404) return out;
      throw err;
    }
    if (!Array.isArray(res) || res.length === 0) break;
    for (const c of res) {
      out.push({
        username: c.login,
        permission: c.permissions?.admin ? 'admin' : c.permissions?.push ? 'write' : 'read',
      });
    }
    if (res.length < 50) break;
  }
  return out;
}

// Add or update a collaborator at a permission level. Idempotent — Gitea's
// PUT both creates and updates. Same reserved-name backstop as
// mintUserCliToken: never let a grant target a platform account.
export async function setCollaborator(opts: {
  owner: string; repo: string; username: string; permission: GiteaRepoPermission;
}): Promise<void> {
  if (!giteaEnabled()) return;
  if (isReservedUsername(opts.username) || !isValidUsername(opts.username)) {
    throw new GiteaApiError(0, { message: `refusing to add reserved or invalid collaborator "${opts.username}"` });
  }
  await call(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/collaborators/${encodeURIComponent(opts.username)}`,
    { method: 'PUT', body: JSON.stringify({ permission: opts.permission }) }
  );
}

// Remove a collaborator. Idempotent — 404 (not a collaborator / no such user)
// is success.
export async function removeCollaborator(opts: {
  owner: string; repo: string; username: string;
}): Promise<void> {
  if (!giteaEnabled()) return;
  try {
    await call(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/collaborators/${encodeURIComponent(opts.username)}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return;
    throw err;
  }
}

// Set a repo's private flag. Idempotent PATCH. Project repos are always kept
// private (see the section header) — callers pass `private: true`; the
// parameter is kept general only so the reconciler can re-assert it.
export async function setRepoVisibility(opts: {
  owner: string; repo: string; private: boolean;
}): Promise<void> {
  if (!giteaEnabled()) return;
  await call(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`,
    { method: 'PATCH', body: JSON.stringify({ private: opts.private }) }
  );
}

// ── Pull requests ──────────────────────────────────────────────────────────
//
// Used by the MCP `list_prs` / `create_pr` / `merge_pr` tools so an agent can
// drive the PR-promotion model (push a feature branch, open a PR against
// `main`, wait for scans, merge) without leaving the conversation.
//
// We hit Gitea as cvportal (the site-admin token). Comments on commits
// authored by the project owner stay attributed to the owner — these helpers
// only act on PR metadata, so the merge commit is attributed to cvportal
// when a merge happens through the MCP. That's the same attribution the
// portal already uses for placeholder substitution and sealed-secret writes.

export interface PullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string };
  html_url: string;
  created_at: string;
  updated_at: string;
}

export async function listPullRequests(opts: {
  owner: string; repo: string; state?: 'open' | 'closed' | 'all';
}): Promise<PullRequest[]> {
  if (!giteaEnabled()) return [];
  const state = opts.state || 'open';
  const res = await call<any[]>(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls?state=${encodeURIComponent(state)}&limit=50`
  );
  return (Array.isArray(res) ? res : []).map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: !!p.draft,
    merged: !!p.merged,
    mergeable: !!p.mergeable,
    head: { ref: p.head?.ref, sha: p.head?.sha },
    base: { ref: p.base?.ref },
    user: { login: p.user?.login },
    html_url: p.html_url,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
}

export async function createPullRequest(opts: {
  owner: string; repo: string; title: string; head: string; base?: string; body?: string;
}): Promise<PullRequest> {
  if (!giteaEnabled()) {
    throw new GiteaApiError(0, { message: 'Gitea integration disabled' });
  }
  const p = await call<any>(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: opts.title,
        head: opts.head,
        base: opts.base || 'main',
        body: opts.body || '',
      }),
    }
  );
  return {
    number: p.number, title: p.title, state: p.state,
    draft: !!p.draft, merged: !!p.merged, mergeable: !!p.mergeable,
    head: { ref: p.head?.ref, sha: p.head?.sha },
    base: { ref: p.base?.ref },
    user: { login: p.user?.login },
    html_url: p.html_url,
    created_at: p.created_at, updated_at: p.updated_at,
  };
}

export async function mergePullRequest(opts: {
  owner: string; repo: string; number: number;
  method?: 'merge' | 'rebase' | 'rebase-merge' | 'squash';
  title?: string; message?: string;
}): Promise<void> {
  if (!giteaEnabled()) {
    throw new GiteaApiError(0, { message: 'Gitea integration disabled' });
  }
  await call(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls/${opts.number}/merge`,
    {
      method: 'POST',
      body: JSON.stringify({
        Do: opts.method || 'squash',
        ...(opts.title ? { MergeTitleField: opts.title } : {}),
        ...(opts.message ? { MergeMessageField: opts.message } : {}),
      }),
    }
  );
}

// ── Actions workflow logs ──────────────────────────────────────────────────
//
// Powers the MCP `get_ci_logs` tool. The flow is:
//   1. Resolve the ref to a head sha (branch name → branch HEAD, or
//      treat hex run as sha directly).
//   2. List Actions runs filtered by head_sha to find the workflow runs
//      that ran on that commit (typically Build + Scan).
//   3. For each run, list jobs.
//   4. Fetch each job's logs from /actions/jobs/{id}/logs as text/plain.
//
// The cvportal admin token authenticates everywhere. We tail-cap each job's
// log so a noisy build doesn't blow the JSON-RPC response — scans report
// failures at the bottom anyway, and the per-job target_url in
// get_project_status is still the deep-link if the user wants the full
// stream in Gitea's UI.

export interface ActionsRunSummary {
  id: number;
  name: string;
  workflow_id: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  run_number: number;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface ActionsJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_id: number;
  started_at?: string;
  completed_at?: string;
  html_url?: string;
}

// Fetch the raw bytes of a Gitea response without JSON-parsing. Used for
// /actions/jobs/{id}/logs which returns text/plain log output.
async function callRawText(path: string): Promise<string> {
  const url = `${apiBase}${path}`;
  const basic = Buffer.from(`${giteaAdminUser}:${giteaAdminToken}`).toString('base64');
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'text/plain, */*',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* keep as text */ }
    throw new GiteaApiError(res.status, body);
  }
  return text;
}

export async function listActionsRuns(opts: {
  owner: string; repo: string; headSha?: string; branch?: string; limit?: number;
}): Promise<ActionsRunSummary[]> {
  if (!giteaEnabled()) return [];
  const qs = new URLSearchParams();
  if (opts.headSha) qs.set('head_sha', opts.headSha);
  if (opts.branch) qs.set('branch', opts.branch);
  qs.set('limit', String(opts.limit || 20));
  try {
    const res = await call<{ workflow_runs?: any[] } | any[]>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/actions/runs?${qs.toString()}`
    );
    // Gitea returns `{ workflow_runs: [...], total_count }`; some versions
    // return a bare array. Accept both.
    const arr = Array.isArray(res) ? res : (res?.workflow_runs || []);
    return arr.map((r: any) => ({
      id: r.id, name: r.name || r.display_title || '',
      workflow_id: String(r.workflow_id || r.workflow_name || ''),
      status: r.status, conclusion: r.conclusion ?? null,
      head_sha: r.head_sha, head_branch: r.head_branch,
      run_number: r.run_number,
      html_url: r.html_url || r.url || '',
      created_at: r.created_at, updated_at: r.updated_at,
    }));
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return [];
    throw err;
  }
}

export async function listActionsRunJobs(opts: {
  owner: string; repo: string; runId: number;
}): Promise<ActionsJobSummary[]> {
  if (!giteaEnabled()) return [];
  try {
    const res = await call<{ jobs?: any[] } | any[]>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/actions/runs/${opts.runId}/jobs`
    );
    const arr = Array.isArray(res) ? res : (res?.jobs || []);
    return arr.map((j: any) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion ?? null,
      run_id: j.run_id ?? opts.runId,
      started_at: j.started_at,
      completed_at: j.completed_at,
      html_url: j.html_url,
    }));
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return [];
    throw err;
  }
}

export async function getActionsJobLogs(opts: {
  owner: string; repo: string; jobId: number;
}): Promise<string> {
  if (!giteaEnabled()) {
    throw new GiteaApiError(0, { message: 'Gitea integration disabled' });
  }
  return callRawText(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/actions/jobs/${opts.jobId}/logs`
  );
}

// Upsert a Gitea Actions repo-level secret. Secret names are
// case-insensitive in Gitea and constrained to [A-Z0-9_]; the API
// normalises whatever we send. Body is plaintext; Gitea encrypts at
// rest using its master key. Idempotent — `PUT` overwrites an existing
// secret with the same name.
export async function setActionsSecret(opts: {
  owner: string; repo: string; name: string; data: string;
}): Promise<void> {
  if (!giteaEnabled()) return;
  await call(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/actions/secrets/${encodeURIComponent(opts.name)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ data: opts.data }),
    }
  );
}

// Mint a Personal Access Token on a Gitea user's account via the admin
// endpoint, so the portal can hand the project owner a CLI-friendly
// credential without sending them through Gitea's UI. PATs are user-wide
// (Gitea doesn't support repo-scoped PATs); `write:repository` covers
// `git clone` + `git push` on any repo the user can already access.
//
// Token names are unique per user in Gitea — callers pass a fresh `name`
// each time. The returned `token` is the only chance to read the secret;
// thereafter Gitea stores only its hash.
export async function mintUserCliToken(opts: {
  username: string;
  tokenName: string;
  scopes?: string[];
}): Promise<{ name: string; token: string }> {
  if (!giteaEnabled()) {
    throw new GiteaApiError(0, { message: 'Gitea integration disabled' });
  }
  // Hard backstop against username-squatting privilege escalation: this call
  // uses the cvportal *site-admin* Basic-auth, and Gitea's
  // /users/<name>/tokens endpoint mints the token on whatever <name> we pass.
  // If `username` were ever a reserved/admin name (e.g. a tenant who squatted
  // `preferred_username=cvportal`), this would hand the caller a site-admin
  // token. Refuse regardless of who reached here. See services/reserved-names.
  if (isReservedUsername(opts.username) || !isValidUsername(opts.username)) {
    throw new GiteaApiError(0, { message: `refusing to mint token for reserved or invalid username "${opts.username}"` });
  }
  // Gitea exposes user-token creation at /users/{name}/tokens (NOT under
  // /admin/...). When the caller is a site-admin (cvportal is), basic auth
  // is accepted on any user's path and the resulting token authenticates as
  // that target user.
  const res = await call<{ name: string; sha1: string; scopes?: string[] }>(
    `/users/${encodeURIComponent(opts.username)}/tokens`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: opts.tokenName,
        scopes: opts.scopes || ['write:repository'],
      }),
    }
  );
  return { name: res.name, token: res.sha1 };
}

// List files immediately under a directory in a repo. Returns an empty array
// if the directory doesn't exist (404 from contents API). Each entry carries
// the Gitea-side blob `sha`, which is required to update/delete that file.
export async function listRepoFiles(opts: {
  owner: string; repo: string; dir: string; ref?: string;
}): Promise<Array<{ name: string; path: string; sha: string }>> {
  if (!giteaEnabled()) return [];
  const ref = opts.ref || 'main';
  try {
    const res = await call<Array<{ name: string; path: string; sha: string; type: string }>>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/contents/${encodeRepoPath(opts.dir)}?ref=${encodeURIComponent(ref)}`
    );
    return Array.isArray(res) ? res.filter((e) => e.type === 'file') : [];
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return [];
    throw err;
  }
}

// Create or update a single file in a repo on `main`. `sha` is the previous
// blob sha when updating, omitted when creating.
export async function upsertRepoFile(opts: {
  owner: string; repo: string; path: string; content: string;
  message: string; sha?: string; branch?: string;
}): Promise<void> {
  if (!giteaEnabled()) return;
  const method = opts.sha ? 'PUT' : 'POST';
  await call(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/contents/${encodeRepoPath(opts.path)}`,
    {
      method,
      body: JSON.stringify({
        branch: opts.branch || 'main',
        message: opts.message,
        content: Buffer.from(opts.content, 'utf8').toString('base64'),
        ...(opts.sha ? { sha: opts.sha } : {}),
        author: { name: 'cvportal', email: 'cvportal@corpo-valley.com' },
        committer: { name: 'cvportal', email: 'cvportal@corpo-valley.com' },
      }),
    }
  );
}

// Delete a file from a repo on `main`. `sha` (previous blob sha) is required.
export async function deleteRepoFile(opts: {
  owner: string; repo: string; path: string;
  message: string; sha: string; branch?: string;
}): Promise<void> {
  if (!giteaEnabled()) return;
  await call(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/contents/${encodeRepoPath(opts.path)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({
        branch: opts.branch || 'main',
        message: opts.message,
        sha: opts.sha,
        author: { name: 'cvportal', email: 'cvportal@corpo-valley.com' },
        committer: { name: 'cvportal', email: 'cvportal@corpo-valley.com' },
      }),
    }
  );
}

// Configure branch protection on a Gitea repo's `main` branch so that the
// MVP 6 scan workflow (semgrep + osv-scanner) gates PRs. Status check
// contexts use glob patterns because Gitea Actions stamps checks with
// `<workflow-name> / <job-name>` (e.g. "Scan / semgrep") and we don't want
// the policy to silently stop matching if either name is renamed.
//
// Direct push to `main` is intentionally still allowed for the owner —
// single-user projects shouldn't be forced into a PR loop. Scans still run
// on push and show failures in the Actions tab.
//
// Idempotent: a 409 / "already exists" on POST is treated as success.
export async function setBranchProtection(opts: {
  owner: string;
  repo: string;
  branch?: string;
  statusCheckGlobs?: string[];
  // Overrides the default direct-push whitelist (`[owner, cvportal]`). Pass an
  // explicit list to force-PR for everyone but the named accounts — e.g. the
  // community-center template passes `[cvportal]` so only the seeding account
  // may push to `main` and all human collaborators must open a PR.
  pushWhitelistUsernames?: string[];
  // Whether merging is gated on the scan status checks. Defaults to true (the
  // current project-repo behavior). Pass false to force PRs without blocking
  // merges on checks/approvals (community-center seeding doesn't run scans).
  enableStatusCheck?: boolean;
}): Promise<void> {
  if (!giteaEnabled()) return;
  const branch = opts.branch || 'main';
  const contexts = opts.statusCheckGlobs || ['*semgrep*', '*osv-scanner*'];
  const enableStatusCheck = opts.enableStatusCheck ?? true;
  // Default whitelist preserves the existing project-repo behavior: the repo
  // owner (whose CV_PUSH_TOKEN PAT the Build workflow pushes with) plus the
  // platform admin. Callers may override it wholesale.
  const pushWhitelist = (opts.pushWhitelistUsernames ?? [opts.owner, giteaAdminUser])
    .filter((u, i, a) => u && a.indexOf(u) === i);
  // Status-check enforcement is back ON. The Build workflow auto-bump
  // would normally be rejected because Gitea 1.22's auto-provisioned
  // Actions token is an internal pseudo-user (UID 0) that can't be
  // whitelisted — so the bump now pushes using a PAT minted on the
  // project owner's account (stored as the CV_PUSH_TOKEN repo Actions
  // secret). That makes the bot's effective user = the owner, who IS
  // in `push_whitelist_usernames` and therefore bypasses status checks
  // on direct push.
  //
  // Outside contributors aren't on the whitelist; they're forced to PR,
  // and the PR's merge is gated by the status_check_contexts below.
  const body = {
    rule_name: branch,
    branch_name: branch,
    enable_push: true,
    enable_push_whitelist: true,
    // Whitelist defaults to the project owner (the Build workflow's
    // CV_PUSH_TOKEN PAT is minted on their account) and `cvportal` (the
    // platform admin that drives manifest generation, sealed-secret writes,
    // and any future portal-side Contents API edits). Overridable per call.
    push_whitelist_usernames: pushWhitelist,
    push_whitelist_deploy_keys: false,
    enable_status_check: enableStatusCheck,
    status_check_contexts: enableStatusCheck ? contexts : [],
    required_approvals: 0,
    block_on_outdated_branch: false,
    block_on_rejected_reviews: false,
    dismiss_stale_approvals: false,
    require_signed_commits: false,
  };
  try {
    await call(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/branch_protections`,
      { method: 'POST', body: JSON.stringify(body) }
    );
  } catch (err) {
    // A rule for this branch already exists. PATCH it so re-runs converge the
    // rule onto the requested config (e.g. a whitelist/status-check change),
    // instead of silently keeping a stale rule — this keeps the call truly
    // idempotent rather than create-once.
    if (err instanceof GiteaApiError && (err.status === 409 || alreadyExists(err))) {
      await call(
        `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/branch_protections/${encodeURIComponent(branch)}`,
        { method: 'PATCH', body: JSON.stringify(body) }
      );
      return;
    }
    throw err;
  }
}

// Read the branch-protection rule on a branch (default `main`), or null if no
// rule exists. Surfaces the fields the admin panel reports on: whether direct
// push is whitelisted, who's on the whitelist, and whether status checks gate
// merges.
export interface BranchProtectionInfo {
  branch: string;
  enablePush: boolean;
  enablePushWhitelist: boolean;
  pushWhitelistUsernames: string[];
  enableStatusCheck: boolean;
  statusCheckContexts: string[];
}

export async function getBranchProtection(opts: {
  owner: string; repo: string; branch?: string;
}): Promise<BranchProtectionInfo | null> {
  if (!giteaEnabled()) return null;
  const branch = opts.branch || 'main';
  try {
    const r = await call<{
      branch_name?: string;
      rule_name?: string;
      enable_push?: boolean;
      enable_push_whitelist?: boolean;
      push_whitelist_usernames?: string[];
      enable_status_check?: boolean;
      status_check_contexts?: string[];
    }>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/branch_protections/${encodeURIComponent(branch)}`
    );
    return {
      branch: r.branch_name || r.rule_name || branch,
      enablePush: !!r.enable_push,
      enablePushWhitelist: !!r.enable_push_whitelist,
      pushWhitelistUsernames: r.push_whitelist_usernames || [],
      enableStatusCheck: !!r.enable_status_check,
      statusCheckContexts: r.status_check_contexts || [],
    };
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return null;
    throw err;
  }
}

// Fetch a file from a Gitea repo (default ref: `main`). Returns the raw text
// and the file's `sha` (needed to update via the Contents API).
export async function getFile(opts: {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<{ content: string; sha: string } | null> {
  const ref = opts.ref || 'main';
  try {
    const res = await call<{ content: string; encoding: string; sha: string }>(
      `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/contents/${encodeRepoPath(opts.path)}?ref=${encodeURIComponent(ref)}`
    );
    const content = res.encoding === 'base64'
      ? Buffer.from(res.content, 'base64').toString('utf8')
      : res.content;
    return { content, sha: res.sha };
  } catch (err) {
    if (err instanceof GiteaApiError && err.status === 404) return null;
    throw err;
  }
}

// Best-effort: provision Gitea accounts for a human identity and its paired
// bot identity. Derives username/email/fullName from Kratos traits. Logs and
// swallows errors per-account so a Gitea hiccup never blocks the caller.
// `bot` may be null (e.g. no derivable username).
export async function provisionGiteaForIdentities(
  human: { traits?: any },
  bot: { traits?: any } | null
): Promise<void> {
  if (!giteaEnabled()) return;

  const accounts: Array<{ username: string; email: string; fullName?: string }> = [];

  const collect = (id: { traits?: any } | null) => {
    if (!id) return;
    const traits = (id.traits ?? {}) as Record<string, any>;
    const email = traits.email;
    // Username convention: preferred_username, else the email local part —
    // Google-signup identities carry no username trait but still need a Gitea
    // account for repo grants. Reserved/invalid derivations are refused (the
    // same backstop mintUserCliToken enforces).
    const username = traits.preferred_username
      || (typeof email === 'string' && email.includes('@') ? email.split('@')[0] : null);
    if (!username || !email) return;
    if (!isValidUsername(username) || isReservedUsername(username)) {
      console.warn('[gitea] skipping account provisioning for reserved/invalid derived username', username);
      return;
    }
    const first = traits?.name?.first || '';
    const last = traits?.name?.last || '';
    const fullName = `${first} ${last}`.trim() || undefined;
    accounts.push({ username, email, fullName });
  };

  collect(human);
  collect(bot);

  for (const acct of accounts) {
    try {
      await ensureUser(acct);
    } catch (err: any) {
      console.error('[gitea] ensureUser failed for', acct.username, err?.message);
    }
  }
}

function alreadyExists(err: GiteaApiError): boolean {
  const msg = typeof err.body?.message === 'string' ? err.body.message.toLowerCase() : '';
  return msg.includes('already exist') || msg.includes('already taken') || msg.includes('user already exists');
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
