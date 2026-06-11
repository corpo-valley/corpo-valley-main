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
// identities.
const pool = new Pool({ connectionString: resolveDatabaseUrl() });

// A row id is a Postgres uuid; a non-UUID :id makes Postgres throw an
// invalid-input-syntax error (surfacing as a 500). Pre-validate so callers can
// treat "malformed id" the same as "not found" (404) and avoid leaking the
// distinction to scanners.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
