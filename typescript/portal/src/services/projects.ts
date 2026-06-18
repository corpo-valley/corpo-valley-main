import { Pool } from 'pg';
import { encryptSecret, decryptSecret, needsReencrypt, secretCryptoAvailable } from './secret-crypto';
import type { GarageCredentials } from './garage';

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

// Corpo Valley does not publish projects publicly: neither the repo nor the
// deployed site can be reached unauthenticated. A project is PRIVATE by default
// — only the owner (and their bot) can reach it — and access is widened purely
// by explicit grants (services/access.ts). Org-wide access is the special
// `everyone` grant subject; there is no separate "default access" dial.
//
// A project has two independent areas a member can be granted access to:
//   - site: the deployed website. Levels read/write/admin are the
//     developer-facing X-CV-Perm classes the project code reads.
//   - repo: the Gitea repository. Levels map 1:1 onto Gitea collaborator
//     permissions (read/write/admin).

// Permission levels an explicit grant can carry, for either area. The
// `everyone` subject is capped at read/write (no org-wide admin) — enforced in
// services/access.ts and by a DB CHECK.
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

export function isGrantLevel(value: string): value is GrantLevel {
  return GRANT_LEVELS.includes(value as GrantLevel);
}

// Lifecycle of a project's external resources. New projects start
// `provisioning` and flip to `ready` the moment provisionProject finishes its
// happy path (shared by both the portal fire-and-forget path and the awaited
// MCP path). `failed` is set only when provisioning throws hard out of the
// portal's fire-and-forget call. Existing rows pre-date the column and default
// to `ready` (they are already provisioned).
export type ProjectStatus = 'provisioning' | 'ready' | 'failed';

export interface Project {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  created_at: string;
  // Provisioning lifecycle — see ProjectStatus.
  status: string;
  // Gitea repo full_name (`<owner>/<slug>`) once provisioned; null otherwise.
  gitea_repo: string | null;
  // Set when this project has ever had Postgres enabled. We keep it across
  // disable/enable cycles so the same password binds to the same data
  // directory (volumeClaimTemplate PVC survives a disable). Cleared when the
  // owner explicitly destroys the data via disable + destroy_data.
  postgres_password: string | null;
  // Set when this project has ever had the storage capability enabled.
  // Encrypted JSON blob of the per-project Garage credentials
  // (GarageCredentials). Kept across disable/enable cycles for the same reason
  // as postgres_password — the re-imported access key must still authorise
  // against the surviving data PVC. Cleared on disable + destroy_data.
  garage_creds: string | null;
  // sha256(plaintext token) of the per-project CV_PIN_TOKEN that the
  // project's Build workflow sends to POST /internal/projects/:slug/pin.
  // The plaintext is set as a Gitea Actions secret on the repo at
  // project-create time and never stored server-side — we only keep the
  // hash so we can verify the workflow's Bearer header.
  pin_token_hash: string | null;
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
      created_at timestamptz not null default now()
    );
  `);
  // Added in the Gitea-integration MVP: records the provisioned repo full_name.
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS gitea_repo text;');
  // Provisioning lifecycle (see ProjectStatus). Existing rows are already
  // provisioned, so the column defaults to 'ready'; only newly-created rows
  // start out 'provisioning'.
  await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';");
  // Per-project Postgres password (only ever set once per data lifecycle —
  // see services/postgres.ts).
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgres_password text;');
  // Per-project Garage credentials (encrypted JSON) — see services/garage.ts.
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS garage_creds text;');
  // CV_PIN_TOKEN hash — see routes/internal.ts. The token authenticates the
  // project's Build workflow's pin request; we only store the hash.
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS pin_token_hash text;');
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
  // A grant gives one subject — a user, a group, or the virtual `everyone`
  // (org-wide) subject — a permission level per area. NULL site_perm/repo_perm
  // means "no grant for that area"; at least one is enforced at the application
  // layer. The `everyone` subject is capped at read/write (no org-wide admin),
  // enforced by the project_grants_everyone_no_admin CHECK below.
  // subject_name/gitea username are denormalized for display + the Gitea
  // reconciler.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_grants (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      subject_type text not null check (subject_type in ('user', 'group', 'everyone')),
      subject_id text not null,
      subject_name text,
      gitea_username text,
      site_perm text check (site_perm in ('read', 'write', 'admin')),
      repo_perm text check (repo_perm in ('read', 'write', 'admin')),
      created_at timestamptz not null default now(),
      unique (project_id, subject_type, subject_id),
      constraint project_grants_everyone_no_admin
        check (subject_type <> 'everyone' or (site_perm is distinct from 'admin' and repo_perm is distinct from 'admin'))
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS project_grants_subject_idx ON project_grants (subject_type, subject_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);');

  // Existing DBs: widen the subject_type CHECK to admit `everyone` and add the
  // no-org-wide-admin CHECK (both no-ops once already present). The inline
  // CHECKs above only take effect on a fresh CREATE.
  await pool.query(`ALTER TABLE project_grants DROP CONSTRAINT IF EXISTS project_grants_subject_type_check;`);
  await pool.query(`ALTER TABLE project_grants ADD CONSTRAINT project_grants_subject_type_check CHECK (subject_type in ('user', 'group', 'everyone'));`);
  await pool.query(`ALTER TABLE project_grants DROP CONSTRAINT IF EXISTS project_grants_everyone_no_admin;`);
  await pool.query(`ALTER TABLE project_grants ADD CONSTRAINT project_grants_everyone_no_admin CHECK (subject_type <> 'everyone' or (site_perm is distinct from 'admin' and repo_perm is distinct from 'admin'));`);

  // One-time migration off the old per-area default-access dials
  // (site_default_access/repo_default_access) and their legacy
  // service_access/repo_access predecessors: an org-wide default of read/write
  // becomes an explicit `everyone` grant at the same level, then the columns
  // are dropped. Guarded by column existence so it runs exactly once and is a
  // no-op on fresh DBs and on every subsequent boot. `none` defaults (private)
  // produce no grant — that is the new default-private posture.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'projects' AND column_name = 'site_default_access'
      ) THEN
        INSERT INTO project_grants (project_id, subject_type, subject_id, subject_name, site_perm, repo_perm)
        SELECT p.id, 'everyone', 'everyone', 'Everyone',
               NULLIF(COALESCE(p.site_default_access, CASE WHEN p.service_access = 'shared' THEN 'write' ELSE 'none' END), 'none'),
               NULLIF(COALESCE(p.repo_default_access, CASE WHEN p.repo_access = 'shared-edit' THEN 'write' ELSE 'none' END), 'none')
        FROM projects p
        WHERE COALESCE(p.site_default_access, CASE WHEN p.service_access = 'shared' THEN 'write' ELSE 'none' END) <> 'none'
           OR COALESCE(p.repo_default_access, CASE WHEN p.repo_access = 'shared-edit' THEN 'write' ELSE 'none' END) <> 'none'
        ON CONFLICT (project_id, subject_type, subject_id) DO NOTHING;
      END IF;
    END $$;
  `);
  await pool.query('ALTER TABLE projects DROP COLUMN IF EXISTS site_default_access;');
  await pool.query('ALTER TABLE projects DROP COLUMN IF EXISTS repo_default_access;');
  await pool.query('ALTER TABLE projects DROP COLUMN IF EXISTS service_access;');
  await pool.query('ALTER TABLE projects DROP COLUMN IF EXISTS repo_access;');

  // Bring every stored per-project secret under the CURRENT encryption key:
  // re-encrypts legacy cleartext AND ciphertext written under a now-retired key
  // (key rotation). decryptSecret→encryptSecret preserves the exact value, so
  // the per-project databases (postgres_password) and object stores
  // (garage_creds) stay reachable. Skipped (with a warning) when the key isn't
  // configured, so the portal still boots.
  const isProd = process.env.NODE_ENV === 'production';
  // Each persisted-secret column gets the same re-encrypt treatment.
  const SECRET_COLUMNS = ['postgres_password', 'garage_creds'] as const;
  if (secretCryptoAvailable()) {
    let migrated = 0;
    let stillUnprotected = 0;
    for (const col of SECRET_COLUMNS) {
      const { rows } = await pool.query<{ id: string; val: string }>(
        `SELECT id, ${col} AS val FROM projects WHERE ${col} IS NOT NULL`
      );
      for (const row of rows) {
        if (!needsReencrypt(row.val)) continue;
        try {
          const plain = decryptSecret(row.val);
          await pool.query(`UPDATE projects SET ${col} = $2 WHERE id = $1`, [
            row.id, encryptSecret(plain),
          ]);
          migrated++;
        } catch (e: any) {
          // Can't decrypt (e.g. retired key dropped before migration) — leaves
          // the row unprotected/inaccessible. Surface loudly; fail closed below.
          stillUnprotected++;
          console.error(`[projects] could not re-encrypt ${col} for`, row.id, '-', e?.message);
        }
      }
    }
    if (migrated > 0) {
      console.log(`Re-encrypted ${migrated} per-project secret value(s) under the current key`);
    }
    // Fail closed in production: a leftover cleartext/undecryptable row defeats
    // the at-rest protection this module exists to provide.
    if (isProd && stillUnprotected > 0) {
      throw new Error(`${stillUnprotected} per-project secret row(s) remain unprotected after migration — refusing to start in production. Ensure PORTAL_SECRET_KEY (and PORTAL_SECRET_KEY_OLD for rotation) are set.`);
    }
  } else if (isProd) {
    // Mirror the sealing subsystem's production fail-closed for key material.
    throw new Error('PORTAL_SECRET_KEY is not set — refusing to start in production (per-project secrets would be stored in cleartext).');
  } else {
    console.warn('[projects] PORTAL_SECRET_KEY not set — per-project secrets remain in cleartext. Set the key to enable encryption at rest.');
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

// Create a project. Always PRIVATE on creation (owner-only) — org-wide or
// per-member access is added afterwards as explicit grants (services/access.ts).
export async function createProject(input: {
  slug: string;
  name: string;
  ownerId: string;
}): Promise<Project> {
  const { rows } = await pool.query<Project>(
    `INSERT INTO projects (slug, name, owner_id, status)
     VALUES ($1, $2, $3, 'provisioning')
     RETURNING *`,
    [input.slug, input.name, input.ownerId]
  );
  return rows[0];
}

// Update a project's provisioning lifecycle status. Best-effort UPDATE called
// from provisionProject (→ 'ready') and the portal's fire-and-forget catch
// (→ 'failed').
export async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await pool.query('UPDATE projects SET status = $2 WHERE id = $1', [id, status]);
}

// Every project, for the periodic repo-access reconcile sweep.
export async function listAllProjects(): Promise<Project[]> {
  const { rows } = await pool.query<Project>('SELECT * FROM projects ORDER BY created_at');
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

// Decrypt + parse a project's stored Garage credentials, or null if storage
// has never been enabled (or the data was destroyed). Mirrors
// decodePostgresPassword; the blob is encrypted JSON.
export function decodeGarageCredentials(project: Pick<Project, 'garage_creds'>): GarageCredentials | null {
  if (!project.garage_creds) return null;
  return JSON.parse(decryptSecret(project.garage_creds)) as GarageCredentials;
}

// Atomically claim the project's Garage credentials, or read them back if
// another caller already claimed. Same race-avoidance contract as
// claimOrGetPostgresPassword: only one caller flips NULL → ciphertext, and
// every other caller reads back the winner's value so the SealedSecret they
// each (idempotently) write carries the same keys.
export async function claimOrGetGarageCredentials(
  id: string, candidate: GarageCredentials,
): Promise<{ creds: GarageCredentials; claimed: boolean }> {
  const claim = await pool.query<{ garage_creds: string }>(
    `UPDATE projects
     SET garage_creds = $1
     WHERE id = $2 AND garage_creds IS NULL
     RETURNING garage_creds`,
    [encryptSecret(JSON.stringify(candidate)), id]
  );
  if (claim.rows.length > 0) {
    return { creds: candidate, claimed: true };
  }
  const { rows } = await pool.query<{ garage_creds: string | null }>(
    'SELECT garage_creds FROM projects WHERE id = $1',
    [id]
  );
  const existing = rows[0]?.garage_creds;
  if (!existing) {
    throw new Error(`project ${id} not found or has no garage_creds`);
  }
  return { creds: JSON.parse(decryptSecret(existing)) as GarageCredentials, claimed: false };
}

export async function clearGarageCredentials(id: string): Promise<void> {
  await pool.query('UPDATE projects SET garage_creds = NULL WHERE id = $1', [id]);
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
