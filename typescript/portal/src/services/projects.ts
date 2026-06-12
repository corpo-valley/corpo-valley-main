import { Pool } from 'pg';
import { encryptSecret, decryptSecret, needsReencrypt, secretCryptoAvailable } from './secret-crypto';

// Resolve the portal's Postgres connection string. In production DATABASE_URL
// MUST be set: silently falling back to the well-known `portal:portal@localhost`
// default would connect to an unintended/insecure DB (this DB holds every
// project's encrypted password, pin-token hashes, and owner mappings) rather
// than failing closed like PORTAL_SECRET_KEY and the seal cert already do. The
// baked default remains only for local dev. Shared with pin-token-backfill.ts.
export function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is not set — refusing to start in production with the built-in portal:portal default credential.');
  }
  return 'postgres://portal:portal@localhost:5432/portal';
}

// Portal Postgres pool. Projects are registration records owned by Kratos
// identities. Exported for the sibling tables that live in the same DB
// (groups / grants — services/access.ts).
export const pool = new Pool({ connectionString: resolveDatabaseUrl() });

// A row id is a Postgres uuid; a non-UUID :id makes Postgres throw an
// invalid-input-syntax error (surfacing as a 500). Pre-validate so callers can
// treat "malformed id" the same as "not found" (404) and avoid leaking the
// distinction to scanners.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Corpo Valley does not publish projects publicly. The legacy `open` value
// (unauthenticated repo + service) has been removed; existing rows carrying
// it are migrated down to `shared` / `shared-edit` at startup (see migrate()).
//
// LEGACY: service_access / repo_access are superseded by the per-area default
// access dials below (site_default_access / repo_default_access) composed with
// explicit user/group grants (services/access.ts). The legacy columns are kept
// in sync on write for rollback safety, but nothing should read them anymore —
// read through siteDefaultAccess() / repoDefaultAccess() instead.
export const SERVICE_ACCESS = ['private', 'shared'] as const;
export type ServiceAccess = (typeof SERVICE_ACCESS)[number];

export const REPO_ACCESS = ['private-edit', 'shared-edit'] as const;
export type RepoAccess = (typeof REPO_ACCESS)[number];

// Default access every signed-in member gets to a project, per area (the
// deployed site, and the Gitea repo). Explicit grants layer on top; the
// effective permission is the max. `none` keeps the area owner-only.
export const DEFAULT_ACCESS = ['none', 'read', 'write'] as const;
export type DefaultAccess = (typeof DEFAULT_ACCESS)[number];

// Permission levels an explicit user/group grant can carry. For the SITE area
// these are the three classes the developer-facing X-CV-Perm standard exposes;
// for the REPO area they map 1:1 onto Gitea collaborator permissions.
export const GRANT_LEVELS = ['read', 'write', 'admin'] as const;
export type GrantLevel = (typeof GRANT_LEVELS)[number];

// Effective permission for a caller on an area: none < read < write < admin.
export type EffectivePerm = 'none' | GrantLevel;
const PERM_RANK: Record<EffectivePerm, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function maxPerm(...perms: Array<EffectivePerm | null | undefined>): EffectivePerm {
  let best: EffectivePerm = 'none';
  for (const p of perms) {
    if (p && PERM_RANK[p] > PERM_RANK[best]) best = p;
  }
  return best;
}

export function isDefaultAccess(value: string): value is DefaultAccess {
  return DEFAULT_ACCESS.includes(value as DefaultAccess);
}

export function isGrantLevel(value: string): value is GrantLevel {
  return GRANT_LEVELS.includes(value as GrantLevel);
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  service_access: ServiceAccess;
  repo_access: RepoAccess;
  // Default access for all signed-in members, per area. NULL on rows created
  // before the grants model — read through siteDefaultAccess()/
  // repoDefaultAccess(), which derive the legacy equivalent lazily (a
  // write-preserving, idempotent migration: shared → write, private → none).
  site_default_access: DefaultAccess | null;
  repo_default_access: DefaultAccess | null;
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

// The effective default-access dial for the site area, deriving the legacy
// service_access mapping for rows that predate the column. `shared` maps to
// `write` (not `read`): a shared site today lets any member fully use the app,
// and mapping down would silently break existing shared projects.
export function siteDefaultAccess(p: Pick<Project, 'site_default_access' | 'service_access'>): DefaultAccess {
  return p.site_default_access ?? (p.service_access === 'shared' ? 'write' : 'none');
}

// Effective repo default. Legacy `shared-edit` literally meant "anyone can
// edit", so it maps to `write`.
export function repoDefaultAccess(p: Pick<Project, 'repo_default_access' | 'repo_access'>): DefaultAccess {
  return p.repo_default_access ?? (p.repo_access === 'shared-edit' ? 'write' : 'none');
}

// Legacy-column equivalents, written alongside the new dials so a rollback to
// a pre-grants portal sees a coherent (if coarser) access state.
function legacyServiceAccess(site: DefaultAccess): ServiceAccess {
  return site === 'none' ? 'private' : 'shared';
}
function legacyRepoAccess(repo: DefaultAccess): RepoAccess {
  return repo === 'none' ? 'private-edit' : 'shared-edit';
}

// Slugs become `{slug}.projects.corpo-valley.com`, a Gitea repo name, and a
// k8s namespace — so they must be a strict DNS-1123 label: lowercase
// alphanumerics and hyphens, 1–63 chars, and NOT starting or ending with a
// hyphen. A loose `^[a-z0-9-]+$` accepted `-foo`/`foo-`, which k8s, Gitea, and
// the ingress host all reject — leaving a DB row whose downstream resources
// can never be created (partial provisioning).
const SLUG_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

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
  // Default-access dials (grants model). NULL means "derive from the legacy
  // columns at read time" (siteDefaultAccess/repoDefaultAccess) — that keeps
  // this migration idempotent: we never backfill, so a later owner change to
  // the dial can't be clobbered by a portal restart.
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_default_access text;');
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_default_access text;');

  // Groups + per-project grants. Groups are member-created (the platform-role
  // ADMIN group lives in Keto and is unrelated). group_members denormalizes
  // username/email so pickers and the Gitea reconciler don't need a Kratos
  // round-trip per row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id uuid primary key default gen_random_uuid(),
      name text unique not null,
      owner_id text not null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id uuid not null references groups(id) on delete cascade,
      user_id text not null,
      username text,
      email text,
      added_at timestamptz not null default now(),
      primary key (group_id, user_id)
    );
  `);
  // A grant gives one subject (a user or a group) a permission level per area.
  // NULL site_perm/repo_perm means "no grant for that area" — at least one is
  // enforced at the application layer. subject_name/gitea username are
  // denormalized for display + the Gitea reconciler.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_grants (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      subject_type text not null check (subject_type in ('user', 'group')),
      subject_id text not null,
      subject_name text,
      gitea_username text,
      site_perm text check (site_perm in ('read', 'write', 'admin')),
      repo_perm text check (repo_perm in ('read', 'write', 'admin')),
      created_at timestamptz not null default now(),
      unique (project_id, subject_type, subject_id)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS project_grants_subject_idx ON project_grants (subject_type, subject_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);');

  // Bring every stored postgres_password under the CURRENT encryption key:
  // re-encrypts legacy cleartext AND ciphertext written under a now-retired key
  // (key rotation). decryptSecret→encryptSecret preserves the exact password, so
  // the per-project databases stay reachable. Skipped (with a warning) when the
  // key isn't configured, so the portal still boots.
  const isProd = process.env.NODE_ENV === 'production';
  if (secretCryptoAvailable()) {
    const { rows } = await pool.query<{ id: string; postgres_password: string }>(
      'SELECT id, postgres_password FROM projects WHERE postgres_password IS NOT NULL'
    );
    let migrated = 0;
    let stillUnprotected = 0;
    for (const row of rows) {
      if (!needsReencrypt(row.postgres_password)) continue;
      try {
        const plain = decryptSecret(row.postgres_password);
        await pool.query('UPDATE projects SET postgres_password = $2 WHERE id = $1', [
          row.id, encryptSecret(plain),
        ]);
        migrated++;
      } catch (e: any) {
        // Can't decrypt (e.g. retired key dropped before migration) — leaves the
        // row unprotected/inaccessible. Surface loudly; fail closed in prod below.
        stillUnprotected++;
        console.error('[projects] could not re-encrypt postgres_password for', row.id, '-', e?.message);
      }
    }
    if (migrated > 0) {
      console.log(`Re-encrypted ${migrated} postgres_password value(s) under the current key`);
    }
    // Fail closed in production: a leftover cleartext/undecryptable row defeats
    // the at-rest protection this module exists to provide.
    if (isProd && stillUnprotected > 0) {
      throw new Error(`${stillUnprotected} postgres_password row(s) remain unprotected after migration — refusing to start in production. Ensure PORTAL_SECRET_KEY (and PORTAL_SECRET_KEY_OLD for rotation) are set.`);
    }
  } else if (isProd) {
    // Mirror the sealing subsystem's production fail-closed for key material.
    throw new Error('PORTAL_SECRET_KEY is not set — refusing to start in production (per-project Postgres passwords would be stored in cleartext).');
  } else {
    console.warn('[projects] PORTAL_SECRET_KEY not set — postgres_password values remain in cleartext. Set the key to enable encryption at rest.');
  }
}

// Decrypt a project's stored postgres_password to its plaintext, or null if the
// project has none. All read sites should go through this rather than reading
// the raw column.
export function decodePostgresPassword(project: Pick<Project, 'postgres_password'>): string | null {
  if (!project.postgres_password) return null;
  return decryptSecret(project.postgres_password);
}

export async function listProjectsByOwner(ownerId: string): Promise<Project[]> {
  const { rows } = await pool.query<Project>(
    'SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at DESC',
    [ownerId]
  );
  return rows;
}

export async function getProjectById(id: string): Promise<Project | null> {
  if (!UUID_RE.test(id)) return null; // malformed id → treat as not found
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
  siteDefault: DefaultAccess;
  repoDefault: DefaultAccess;
}): Promise<Project> {
  const { rows } = await pool.query<Project>(
    `INSERT INTO projects (slug, name, owner_id, service_access, repo_access, site_default_access, repo_default_access)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.slug, input.name, input.ownerId,
      legacyServiceAccess(input.siteDefault), legacyRepoAccess(input.repoDefault),
      input.siteDefault, input.repoDefault,
    ]
  );
  return rows[0];
}

// Update the per-area default-access dials. Also rewrites the legacy columns
// so a rollback sees a coherent state.
export async function updateProjectDefaults(
  id: string,
  siteDefault: DefaultAccess,
  repoDefault: DefaultAccess
): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    `UPDATE projects
     SET site_default_access = $2, repo_default_access = $3,
         service_access = $4, repo_access = $5
     WHERE id = $1
     RETURNING *`,
    [id, siteDefault, repoDefault, legacyServiceAccess(siteDefault), legacyRepoAccess(repoDefault)]
  );
  return rows[0] ?? null;
}

// Projects whose repo default grants every member `write` — the Gitea
// collaborator fan-out set a newly provisioned user must be added to. The
// COALESCE mirrors repoDefaultAccess()'s lazy legacy derivation.
export async function listProjectsWithRepoDefaultWrite(): Promise<Project[]> {
  const { rows } = await pool.query<Project>(
    `SELECT * FROM projects
     WHERE COALESCE(repo_default_access, CASE WHEN repo_access = 'shared-edit' THEN 'write' ELSE 'none' END) = 'write'`
  );
  return rows;
}

// Record the provisioned Gitea repo full_name on a project. Best-effort:
// called after the project row already exists.
export async function setGiteaRepo(id: string, fullName: string): Promise<void> {
  await pool.query('UPDATE projects SET gitea_repo = $2 WHERE id = $1', [id, fullName]);
}

// Atomically claim the project's postgres password, or read it back if
// another caller already claimed. Two concurrent `enable_postgres` calls
// would otherwise race: both generate a candidate, both write the password
// (last write wins), then both `upsertRepoFile` the sealed secret — and
// the DB password may not match the one that got sealed. With this
// helper, only one caller's UPDATE flips the NULL → claimed transition;
// every other caller reads back the winner's value, so the sealed secret
// they each (idempotently) write carries the same password.
export async function claimOrGetPostgresPassword(id: string, candidate: string): Promise<{ password: string; claimed: boolean }> {
  // The candidate is stored encrypted; we hand back the plaintext to callers
  // (who seal it into the project's SealedSecret). Try to claim — the UPDATE
  // returns the row only when it actually flipped a NULL → ciphertext.
  const claim = await pool.query<{ postgres_password: string }>(
    `UPDATE projects
     SET postgres_password = $1
     WHERE id = $2 AND postgres_password IS NULL
     RETURNING postgres_password`,
    [encryptSecret(candidate), id]
  );
  if (claim.rows.length > 0) {
    return { password: candidate, claimed: true };
  }
  // Lost the race (or password was already set from a prior cycle).
  // Read the live value and decrypt it.
  const { rows } = await pool.query<{ postgres_password: string | null }>(
    'SELECT postgres_password FROM projects WHERE id = $1',
    [id]
  );
  const existing = rows[0]?.postgres_password;
  if (!existing) {
    throw new Error(`project ${id} not found or has no postgres_password`);
  }
  return { password: decryptSecret(existing), claimed: false };
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
