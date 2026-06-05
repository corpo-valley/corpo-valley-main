import { Pool } from 'pg';

// Portal Postgres pool. Projects are registration records owned by Kratos
// identities. No Gitea/ArgoCD provisioning yet — that lands in later MVPs.
const databaseUrl = process.env.DATABASE_URL || 'postgres://portal:portal@localhost:5432/portal';

const pool = new Pool({ connectionString: databaseUrl });

// Corpo Valley does not publish projects publicly. The legacy `open` value
// (unauthenticated repo + service) has been removed; existing rows carrying
// it are migrated down to `shared` / `shared-edit` at startup (see migrate()).
export const SERVICE_ACCESS = ['private', 'shared'] as const;
export type ServiceAccess = (typeof SERVICE_ACCESS)[number];

export const REPO_ACCESS = ['private-edit', 'shared-edit'] as const;
export type RepoAccess = (typeof REPO_ACCESS)[number];

export interface Project {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  service_access: ServiceAccess;
  repo_access: RepoAccess;
  created_at: string;
  // Gitea repo full_name (`<owner>/<slug>`) once provisioned; null otherwise.
  gitea_repo: string | null;
  // Set when this project has ever had Postgres enabled. We keep it across
  // disable/enable cycles so the same password binds to the same data
  // directory (volumeClaimTemplate PVC survives a disable). Cleared when the
  // owner explicitly destroys the data via disable + destroy_data.
  postgres_password: string | null;
  // sha256(plaintext token) of the per-project CV_PIN_TOKEN that the
  // project's Build workflow sends to POST /internal/projects/:slug/pin.
  // The plaintext is set as a Gitea Actions secret on the repo at
  // project-create time and never stored server-side — we only keep the
  // hash so we can verify the workflow's Bearer header.
  pin_token_hash: string | null;
}

export function isServiceAccess(value: string): value is ServiceAccess {
  return SERVICE_ACCESS.includes(value as ServiceAccess);
}

export function isRepoAccess(value: string): value is RepoAccess {
  return REPO_ACCESS.includes(value as RepoAccess);
}

// Slugs are DNS-label friendly: lowercase alphanumerics + hyphens. They
// become `{slug}.projects.corpo-valley.com` later, so keep them strict.
const SLUG_RE = /^[a-z0-9-]+$/;

// Names that collide with platform / system namespaces, well-known
// service identities, or platform-prefixed identifiers. Squatting one of
// these would create a Gitea repo + DB row that's permanently broken
// (the VAP would reject the ArgoCD Application), and could mislead users
// into thinking they're looking at a platform component. Also blocks
// the `cv-` prefix wholesale — the entire platform namespace family is
// reserved.
const RESERVED_SLUGS = new Set([
  'admin', 'argocd', 'auth', 'cvportal', 'default', 'docs', 'gitea',
  'health', 'healthz', 'hydra', 'ingress', 'ingress-controller',
  'ingress-nginx', 'internal', 'keto', 'kratos', 'kube-public',
  'kube-system', 'mcp', 'metrics', 'oauth', 'oidc', 'ory', 'portal',
  'projects', 'public', 'registry', 'root', 'static', 'sys', 'system',
  'www',
]);

export function isValidSlug(slug: string): boolean {
  if (!SLUG_RE.test(slug)) return false;
  if (slug.length < 1 || slug.length > 63) return false;
  // Block the cv- platform-namespace family and kube-* explicitly so a
  // user can't claim `cv-foo` and end up resembling a platform component.
  if (slug.startsWith('cv-') || slug.startsWith('kube-')) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  return true;
}

// Idempotent startup migration. pgcrypto gives us gen_random_uuid().
export async function migrate(): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id uuid primary key default gen_random_uuid(),
      slug text unique not null,
      name text not null,
      owner_id text not null,
      service_access text not null default 'private',
      repo_access text not null default 'private-edit',
      created_at timestamptz not null default now()
    );
  `);
  // Added in the Gitea-integration MVP: records the provisioned repo full_name.
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS gitea_repo text;');
  // Per-project Postgres password (only ever set once per data lifecycle —
  // see services/postgres.ts).
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgres_password text;');
  // CV_PIN_TOKEN hash — see routes/internal.ts. The token authenticates the
  // project's Build workflow's pin request; we only store the hash.
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS pin_token_hash text;');
  // Drop the legacy 'open' visibility tier — Corpo Valley no longer offers a
  // publicly-accessible deployment. Collapse to the most-permissive remaining
  // tier (shared = visible to other CV users, still auth-gated) so existing
  // projects keep working without quietly going dark.
  await pool.query(`UPDATE projects SET service_access='shared' WHERE service_access='open';`);
  await pool.query(`UPDATE projects SET repo_access='shared-edit' WHERE repo_access='open';`);
}

export async function listProjectsByOwner(ownerId: string): Promise<Project[]> {
  const { rows } = await pool.query<Project>(
    'SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at DESC',
    [ownerId]
  );
  return rows;
}

export async function getProjectById(id: string): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    'SELECT * FROM projects WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    'SELECT * FROM projects WHERE slug = $1',
    [slug]
  );
  return rows[0] ?? null;
}

export async function slugExists(slug: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM projects WHERE slug = $1',
    [slug]
  );
  return rows.length > 0;
}

export async function createProject(input: {
  slug: string;
  name: string;
  ownerId: string;
  serviceAccess: ServiceAccess;
  repoAccess: RepoAccess;
}): Promise<Project> {
  const { rows } = await pool.query<Project>(
    `INSERT INTO projects (slug, name, owner_id, service_access, repo_access)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.slug, input.name, input.ownerId, input.serviceAccess, input.repoAccess]
  );
  return rows[0];
}

export async function updateProjectAccess(
  id: string,
  serviceAccess: ServiceAccess,
  repoAccess: RepoAccess
): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    `UPDATE projects SET service_access = $2, repo_access = $3
     WHERE id = $1
     RETURNING *`,
    [id, serviceAccess, repoAccess]
  );
  return rows[0] ?? null;
}

// Record the provisioned Gitea repo full_name on a project. Best-effort:
// called after the project row already exists.
export async function setGiteaRepo(id: string, fullName: string): Promise<void> {
  await pool.query('UPDATE projects SET gitea_repo = $2 WHERE id = $1', [id, fullName]);
}

export async function setPostgresPassword(id: string, password: string): Promise<void> {
  await pool.query('UPDATE projects SET postgres_password = $2 WHERE id = $1', [id, password]);
}

// Atomically claim the project's postgres password, or read it back if
// another caller already claimed. Two concurrent `enable_postgres` calls
// would otherwise race: both generate a candidate, both `setPostgresPassword`
// (last write wins), then both `upsertRepoFile` the sealed secret — and
// the DB password may not match the one that got sealed. With this
// helper, only one caller's UPDATE flips the NULL → claimed transition;
// every other caller reads back the winner's value, so the sealed secret
// they each (idempotently) write carries the same password.
export async function claimOrGetPostgresPassword(id: string, candidate: string): Promise<{ password: string; claimed: boolean }> {
  // Try to claim. The UPDATE returns the row only when it actually
  // flipped a NULL postgres_password to the candidate.
  const claim = await pool.query<{ postgres_password: string }>(
    `UPDATE projects
     SET postgres_password = $1
     WHERE id = $2 AND postgres_password IS NULL
     RETURNING postgres_password`,
    [candidate, id]
  );
  if (claim.rows.length > 0) {
    return { password: claim.rows[0].postgres_password, claimed: true };
  }
  // Lost the race (or password was already set from a prior cycle).
  // Read the live value.
  const { rows } = await pool.query<{ postgres_password: string | null }>(
    'SELECT postgres_password FROM projects WHERE id = $1',
    [id]
  );
  const existing = rows[0]?.postgres_password;
  if (!existing) {
    throw new Error(`project ${id} not found or has no postgres_password`);
  }
  return { password: existing, claimed: false };
}

export async function clearPostgresPassword(id: string): Promise<void> {
  await pool.query('UPDATE projects SET postgres_password = NULL WHERE id = $1', [id]);
}

export async function setPinTokenHash(id: string, hash: string): Promise<void> {
  await pool.query('UPDATE projects SET pin_token_hash = $2 WHERE id = $1', [id, hash]);
}

// Lookup by the pin token hash. Used by POST /internal/projects/:slug/pin
// to authenticate the calling workflow: portal sha256s the supplied Bearer
// and finds the project that owns it. The slug in the URL must then match
// the returned project — defence in depth against any future bug that
// might let a token-rebind happen.
export async function getProjectByPinTokenHash(hash: string): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    'SELECT * FROM projects WHERE pin_token_hash = $1',
    [hash]
  );
  return rows[0] ?? null;
}

export async function deleteProject(id: string): Promise<void> {
  await pool.query('DELETE FROM projects WHERE id = $1', [id]);
}
