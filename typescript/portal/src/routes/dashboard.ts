import { Router, Request, Response } from 'express';
import { requireSession, requireVerifiedEmail } from '../middleware/session';
import { POST_LOGIN_COOKIE } from './kratos';
import { csrfHiddenField } from '../middleware/csrf';
import { isUserAdmin } from '../services/keto';
import { createApiKey, listUserApiKeys, isKeyOwnedBy, deleteClient } from '../services/hydra-admin';
import {
  listProjectsByOwner, getProjectById, getProjectBySlug, createProject,
  deleteProject, slugExists, isValidSlug, isGrantLevel,
  setGiteaRepo,
  clearPostgresPassword,
  claimOrGetPostgresPassword, decodePostgresPassword,
  clearGarageCredentials, claimOrGetGarageCredentials, decodeGarageCredentials,
  setPinTokenHash,
  GrantLevel,
} from '../services/projects';
import {
  listProjectGrants, upsertProjectGrant, getGrantById,
  setGrantFacet, revokeGrantFacet, getEveryoneGrants,
  getGroupByName, listGroups, listProjectsSharedWith,
  EVERYONE_SUBJECT_ID, EVERYONE_SUBJECT_NAME,
  SubjectType, GrantFacet,
} from '../services/access';
import { syncRepoAccess, giteaUsernameForIdentity } from '../services/repo-access';
import { findIdentityByEmail, findIdentityByUsername } from '../services/kratos-admin';
import { ensureProvisionedLazy } from '../services/provisioning';
import { generatePinToken, hashPinToken } from '../services/pin-token';
import {
  enablePostgres as enableProjectPostgres,
  disablePostgres as disableProjectPostgres,
  destroyPostgresPvc,
  postgresEnabled as projectPostgresEnabled,
  generatePostgresPassword,
} from '../services/postgres';
import {
  enableGarage as enableProjectGarage,
  disableGarage as disableProjectGarage,
  destroyGaragePvc,
  garageEnabled as projectGarageEnabled,
  generateGarageCredentials,
} from '../services/garage';
import {
  parseCapabilities, requiresPostgres, capabilityList,
  TEMPLATE_GITEA_OWNER, TEMPLATE_GITEA_REPO,
} from '../services/templates';
import { provisionProject } from '../services/provisionProject';
import {
  generateFromTemplate, ensureUser, giteaEnabled,
  setBranchProtection,
  listRepoFiles, upsertRepoFile, deleteRepoFile,
  mintUserCliToken, setActionsSecret,
} from '../services/gitea';
import { createArgoApplication, k8sEnabled, namespaceExists } from '../services/k8s';
import { purgeProjectResources } from '../services/project-purge';
import { buildSealedSecretYaml } from '../services/seal';
import { PROJECTS_DOMAIN } from '../services/platform-config';
import {
  renderProjects, renderProjectCreate, renderProjectDetail,
  renderKeyManagement, renderNewKeyDisplay, renderError,
  renderGiteaCliTokenReveal,
  ProjectRow, ApiKeyRow,
} from '../templates';
import * as crypto from 'crypto';

const router = Router();

// A stashed post-login destination must be an https project host.
function isSafePostLoginDest(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.' + PROJECTS_DOMAIN);
  } catch {
    return false;
  }
}

// Extract the project slug from a `https://<slug>.<PROJECTS_DOMAIN>/...` URL.
function projectSlugFromHost(url: string): string | null {
  try {
    const u = new URL(url);
    const suffix = '.' + PROJECTS_DOMAIN;
    if (!u.hostname.endsWith(suffix)) return null;
    const slug = u.hostname.slice(0, -suffix.length);
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(slug)) return null;
    return slug;
  } catch {
    return null;
  }
}

// Token endpoint shown to users for API keys. Defaults to the public Hydra
// OAuth2 issuer (oauth.corpo-valley.com), falling back to localhost for dev.
const hydraPublicUrl = process.env.HYDRA_PUBLIC_URL || 'http://localhost:4444';

function toProjectRow(p: {
  id: string; slug: string; name: string; created_at: string;
  gitea_repo?: string | null;
}, extras: {
  postgresEnabled?: boolean; storageEnabled?: boolean;
  // The project's org-wide `everyone` grant levels, for the summary badge
  // ('none' when the project is private to the owner + explicit grantees).
  everyoneSite?: string; everyoneRepo?: string;
} = {}): ProjectRow {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    everyoneSite: extras.everyoneSite ?? 'none',
    everyoneRepo: extras.everyoneRepo ?? 'none',
    createdAt: p.created_at ? new Date(p.created_at).toLocaleDateString() : '—',
    giteaRepo: p.gitea_repo ?? null,
    postgresEnabled: extras.postgresEnabled ?? false,
    storageEnabled: extras.storageEnabled ?? false,
  };
}

// ── Projects ───────────────────────────────────────────────

// GET / — list MY projects
router.get('/', requireSession, async (req: Request, res: Response) => {
  const session = req.portalSession!;

  // Honour a stashed post-login destination (set by /login) ONLY if it is a
  // valid project host AND the logged-in subject owns that project. This closes
  // the open-redirect-to-tenant-subdomain phishing vector: an attacker's project
  // host won't be owned by the victim, so we fall through to the dashboard.
  const pld = req.cookies?.[POST_LOGIN_COOKIE];
  if (pld) {
    res.clearCookie(POST_LOGIN_COOKIE, { path: '/' });
    if (isSafePostLoginDest(pld)) {
      const slug = projectSlugFromHost(pld);
      if (slug) {
        const project = await getProjectBySlug(slug).catch(() => null);
        if (project && project.owner_id === session.id) {
          return res.redirect(pld);
        }
      }
    }
  }

  // Backstop for self-service (Google) signups whose registration webhook
  // flaked: provision the .bot identity + Gitea account on first sight.
  // Fire-and-forget, once per process per user, idempotent.
  ensureProvisionedLazy(session.id);

  try {
    const isAdmin = await isUserAdmin(session.id);
    const projects = await listProjectsByOwner(session.id);
    const shared = await listProjectsSharedWith(session.id).catch(() => []);
    const everyone = await getEveryoneGrants(projects.map((p) => p.id)).catch(() => new Map());
    res.send(renderProjects(
      session.email,
      projects.map((p) => {
        const e = everyone.get(p.id);
        return toProjectRow(p, { everyoneSite: e?.site ?? 'none', everyoneRepo: e?.repo ?? 'none' });
      }),
      isAdmin,
      shared.map((p) => ({ ...toProjectRow(p), sitePerm: p.site_perm, repoPerm: p.repo_perm })),
    ));
  } catch (err: any) {
    console.error('Projects list error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to load projects.'));
  }
});

// GET /projects/new — create form
router.get('/projects/new', requireSession, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const isAdmin = await isUserAdmin(session.id);
    const csrf = csrfHiddenField(req, res);
    res.send(renderProjectCreate(
      session.email, isAdmin, csrf, '', {},
    ));
  } catch (err: any) {
    console.error('Project create form error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to load form.'));
  }
});

// POST /projects — create a project owned by the logged-in user. The form
// sends `name`, an optional `slug` (derived from name when absent), and a
// `visibility` preset (`private` | `internal`); `internal` seeds the org-wide
// `everyone` grant. Finer access is managed on the project page after creation.
router.post('/projects', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const { slug: rawSlug, name, visibility } = req.body || {};

  const isAdmin = await isUserAdmin(session.id).catch(() => false);
  const fail = (msg: string, status = 400) => {
    const csrf = csrfHiddenField(req, res);
    res.status(status).send(renderProjectCreate(
      session.email, isAdmin, csrf, msg, req.body,
    ));
  };

  // The website is always on; the form's "database" and "mcp" checkboxes are
  // the optional capabilities. The database checkbox is labelled "data/views
  // are shared across users", so enabling it also turns sharing on.
  const caps = parseCapabilities({
    database: req.body?.database,
    storage: req.body?.storage,
    mcp: req.body?.mcp,
    shared: req.body?.database,
  });

  if (!name || typeof name !== 'string' || !name.trim()) {
    return fail('Name is required.');
  }

  // Auto-derive slug from name when not supplied.
  function sluggify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  }
  const slug = (typeof rawSlug === 'string' && rawSlug.trim()) ? rawSlug.trim() : sluggify(name);
  if (!isValidSlug(slug)) {
    return fail('Slug must be lowercase letters, digits, and hyphens (max 63 chars). Edit the slug if your project name has special characters.');
  }

  // Visibility preset → the project's initial org-wide `everyone` grant.
  // `private` (default) seeds nothing — owner-only. `internal` grants every
  // signed-in member write on both the site and the repo. Finer access is
  // managed afterwards as explicit user/group/everyone grants on the project
  // page. Corpo Valley has no `public` preset — neither repo nor deployed site
  // can be exposed unauthenticated.
  const visible = visibility === 'internal' ? 'internal' : 'private';

  try {
    if (await slugExists(slug)) {
      return fail(`Slug "${slug}" is already taken.`, 409);
    }
    // The DB row isn't the only authority for slug availability: a prior
    // project's namespace can outlive its DB row (best-effort teardown /
    // keep_namespace). Refuse a slug whose namespace still exists so the new
    // owner can't inherit the previous tenant's namespace + secrets.
    if (await namespaceExists(slug)) {
      return fail(`Slug "${slug}" is not available (its namespace still exists).`, 409);
    }
    const project = await createProject({ slug, name, ownerId: session.id });
    // Seed the org-wide grant before provisioning so the repo collaborator
    // fan-out picks it up; private projects seed nothing (owner-only).
    if (visible === 'internal') {
      await upsertProjectGrant({
        projectId: project.id, subjectType: 'everyone',
        subjectId: EVERYONE_SUBJECT_ID, subjectName: EVERYONE_SUBJECT_NAME,
        sitePerm: 'write', repoPerm: 'write',
      }).catch((e: any) => console.error('[dashboard] seed everyone grant failed:', e?.message));
    }
    if (!session.preferredUsername) {
      console.warn('Project provisioning limited: no preferred_username for', session.id);
    }
    // Unified provisioning (shared with the MCP create_project tool): seals the
    // namespace baseline first, then provisions repo/postgres/manifests/argocd.
    // Best-effort — never fail creation on a downstream error; the project row
    // is the source of truth and a reconciler can retry from it.
    await provisionProject(project, caps, {
      ownerUsername: session.preferredUsername, email: session.email, logTag: 'dashboard',
    });
    // Converge the repo collaborator set for the seeded org-wide grant (the
    // repo only exists after provisioning).
    if (visible === 'internal') {
      syncRepoAccess(project).catch((e: any) =>
        console.error(`[dashboard] repo access sync failed for ${project.slug}:`, e?.message));
    }
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    // Unique-violation race: another request grabbed the slug first.
    if (err?.code === '23505') {
      return fail(`Slug "${slug}" is already taken.`, 409);
    }
    console.error('Project create error:', err.message);
    fail('Failed to create project.', 500);
  }
});

// GET /projects/:id — view a project (owner only)
router.get('/projects/:id', requireSession, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    const isAdmin = await isUserAdmin(session.id);
    const csrf = csrfHiddenField(req, res);
    const secrets = await listProjectSecretNames(project);
    let postgresEnabledNow = false;
    let storageEnabledNow = false;
    if (project.gitea_repo) {
      const [pgOwner, pgRepo] = project.gitea_repo.split('/');
      postgresEnabledNow = await projectPostgresEnabled({ owner: pgOwner, repo: pgRepo }).catch(() => false);
      storageEnabledNow = await projectGarageEnabled({ owner: pgOwner, repo: pgRepo }).catch(() => false);
    }
    const grants = await listProjectGrants(project.id).catch(() => []);
    const everyoneGrant = grants.find((g) => g.subject_type === 'everyone');
    const groups = await listGroups().catch(() => []);
    res.send(renderProjectDetail(
      session.email, isAdmin,
      toProjectRow(project, {
        postgresEnabled: postgresEnabledNow, storageEnabled: storageEnabledNow,
        everyoneSite: everyoneGrant?.site_perm ?? 'none', everyoneRepo: everyoneGrant?.repo_perm ?? 'none',
      }),
      csrf, secrets, null,
      grants, groups.map((g) => ({ name: g.name, memberCount: g.member_count })),
    ));
  } catch (err: any) {
    console.error('Project detail error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to load project.'));
  }
});

// Helper — list `<name>` from `k8s/secrets/<name>.sealed.yaml` in the user's
// Gitea repo. Returns [] if the dir doesn't exist or Gitea isn't wired.
async function listProjectSecretNames(project: { gitea_repo: string | null; }): Promise<{ name: string }[]> {
  if (!project.gitea_repo) return [];
  const [owner, repo] = project.gitea_repo.split('/');
  if (!owner || !repo) return [];
  const files = await listRepoFiles({ owner, repo, dir: 'k8s/secrets' });
  return files
    .filter((f) => f.name.endsWith('.sealed.yaml'))
    .map((f) => ({ name: f.name.replace(/\.sealed\.yaml$/, '') }));
}

// POST /projects/:id/cli-token — mint a fresh Gitea PAT on the owner's
// account so they can `git clone` over HTTPS without manually creating one
// in Gitea's UI. Renders the secret once with a pre-filled clone command.
router.post('/projects/:id/cli-token', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    const username = session.preferredUsername;
    if (!username) {
      res.status(400).send(renderError(
        'No Gitea account',
        'Your Corpo Valley account has no preferred_username, so no Gitea account is paired with it. Ask an admin to investigate.'
      ));
      return;
    }
    // Only mint for the account that actually owns this project's repo. If the
    // owner's username has since changed, the repo (`<owner>/<slug>`) still
    // points at the old account, and minting a PAT for the new username would
    // be a user-wide token that doesn't even grant access to this repo. Refuse
    // rather than hand out a confusing/over-broad credential.
    const repoOwner = project.gitea_repo ? project.gitea_repo.split('/')[0] : null;
    if (repoOwner && repoOwner !== username) {
      res.status(409).send(renderError(
        'Account mismatch',
        'This project repo is owned by a different Gitea account than your current username. Ask an admin to reconcile your account before minting a token.'
      ));
      return;
    }
    // Token names must be unique per Gitea user; bake a short random
    // suffix so repeat mints never collide.
    const suffix = crypto.randomBytes(3).toString('hex');
    const tokenName = `cv-cli-${suffix}`;
    const { token } = await mintUserCliToken({
      username,
      tokenName,
      scopes: ['write:repository'],
    });
    const isAdmin = await isUserAdmin(session.id).catch(() => false);
    res.send(renderGiteaCliTokenReveal(
      session.email, isAdmin, toProjectRow(project), username, token, tokenName
    ));
  } catch (err: any) {
    // Don't reflect raw upstream (Gitea) error bodies to the tenant — keep the
    // detail in the server log only.
    console.error('CLI token mint error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to mint CLI token. Contact support if this persists.'));
  }
});

// POST /projects/:id/secrets — seal KEY=VALUE pairs and commit
// k8s/secrets/<name>.sealed.yaml to the user's repo (owner only).
router.post('/projects/:id/secrets', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const fail = async (msg: string, status = 400) => {
    const isAdmin = await isUserAdmin(session.id).catch(() => false);
    const project = await getProjectById(req.params.id);
    if (!project) { res.status(404).send(renderError('Not Found', 'Project not found.')); return; }
    const csrf = csrfHiddenField(req, res);
    const secrets = await listProjectSecretNames(project);
    res.status(status).send(renderProjectDetail(
      session.email, isAdmin, toProjectRow(project), csrf, secrets,
      { type: 'error', text: msg }
    ));
  };

  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    if (!project.gitea_repo) return fail('Project has no Gitea repo yet.');

    const rawName = String(req.body?.secret_name || '').trim();
    const rawData = String(req.body?.secret_data || '').trim();
    if (!/^[a-z0-9-]+$/.test(rawName) || rawName.length > 63) {
      return fail('Secret name must be lowercase letters, digits, and hyphens (max 63 chars).');
    }
    const data: Record<string, string> = {};
    for (const line of rawData.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) return fail(`Invalid line "${t}" — expected KEY=VALUE.`);
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        return fail(`Invalid key "${k}" — must match [A-Za-z_][A-Za-z0-9_]*.`);
      }
      data[k] = v;
    }
    if (Object.keys(data).length === 0) {
      return fail('Provide at least one KEY=VALUE pair.');
    }

    const [owner, repo] = project.gitea_repo.split('/');
    const path = `k8s/secrets/${rawName}.sealed.yaml`;
    const yaml = await buildSealedSecretYaml({
      namespace: project.slug,
      name: rawName,
      data,
    });

    // If the file already exists we update it (Gitea contents PUT needs the sha).
    const existing = await listRepoFiles({ owner, repo, dir: 'k8s/secrets' });
    const existingFile = existing.find((f) => f.name === `${rawName}.sealed.yaml`);
    await upsertRepoFile({
      owner,
      repo,
      path,
      content: yaml,
      message: existingFile
        ? `Corpo Valley: update sealed secret ${rawName}`
        : `Corpo Valley: add sealed secret ${rawName}`,
      sha: existingFile?.sha,
    });

    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    // Keep raw upstream error detail in the log only, not in the user response.
    console.error('Project secret create error:', err?.message);
    fail('Failed to seal secret. Contact support if this persists.', 500);
  }
});

// POST /projects/:id/secrets/:name/delete — remove the sealed secret file
// from the user's repo (owner only).
router.post('/projects/:id/secrets/:name/delete', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    if (!project.gitea_repo) {
      res.status(400).send(renderError('Bad Request', 'Project has no Gitea repo.'));
      return;
    }
    const name = String(req.params.name || '');
    if (!/^[a-z0-9-]+$/.test(name)) {
      res.status(400).send(renderError('Bad Request', 'Invalid secret name.'));
      return;
    }
    const [owner, repo] = project.gitea_repo.split('/');
    const files = await listRepoFiles({ owner, repo, dir: 'k8s/secrets' });
    const f = files.find((x) => x.name === `${name}.sealed.yaml`);
    if (!f) {
      res.redirect(`/projects/${project.id}`);
      return;
    }
    await deleteRepoFile({
      owner, repo, path: f.path, sha: f.sha,
      message: `Corpo Valley: delete sealed secret ${name}`,
    });
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Project secret delete error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to delete sealed secret.'));
  }
});

// POST /projects/:id/postgres/enable — turn on per-project Postgres.
//
// Idempotent: commits k8s/postgres.yaml + k8s/secrets/postgres.sealed.yaml
// to the user's repo as cvportal. ArgoCD syncs them into the project's
// namespace within ~a minute. The password lives in the projects row so a
// later disable/enable cycle keeps the same credentials and the existing
// PVC's data is still readable.
router.post('/projects/:id/postgres/enable', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    if (!project.gitea_repo) {
      res.status(400).send(renderError('Bad Request', 'Project has no Gitea repo.'));
      return;
    }
    const [owner, repo] = project.gitea_repo.split('/');
    // Atomic claim: concurrent calls don't desync the DB password from
    // the password that ends up sealed in the repo. See
    // services/projects.ts:claimOrGetPostgresPassword.
    const existingPw = decodePostgresPassword(project);
    const { password } = existingPw
      ? { password: existingPw }
      : await claimOrGetPostgresPassword(project.id, generatePostgresPassword());
    await enableProjectPostgres({ owner, repo, slug: project.slug, password });
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Postgres enable error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to enable Postgres.'));
  }
});

// POST /projects/:id/postgres/disable — remove the postgres manifest + sealed
// secret (ArgoCD prunes the StatefulSet/Service). If the form carries
// destroy_data=true the portal also deletes the PVC and clears the stored
// password so the next enable starts fresh.
router.post('/projects/:id/postgres/disable', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const destroyData = req.body?.destroy_data === 'true' || req.body?.destroy_data === 'on';
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    if (!project.gitea_repo) {
      res.status(400).send(renderError('Bad Request', 'Project has no Gitea repo.'));
      return;
    }
    const [owner, repo] = project.gitea_repo.split('/');
    await disableProjectPostgres({ owner, repo });
    if (destroyData) {
      // Best-effort: the StatefulSet probably hasn't been pruned by ArgoCD
      // yet, which means the PVC is still bound. K8s queues the delete
      // until the StatefulSet's pod releases it. We accept the eventual
      // delete and clear the password regardless — re-enable will mint a
      // fresh one against the fresh PVC.
      try { await destroyPostgresPvc(project.slug); }
      catch (e: any) { console.warn('[postgres/disable] PVC delete failed:', e?.message); }
      await clearPostgresPassword(project.id);
    }
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Postgres disable error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to disable Postgres.'));
  }
});

// POST /projects/:id/storage/enable — turn on per-project Garage object store.
//
// Idempotent: commits k8s/garage.yaml + k8s/secrets/garage.sealed.yaml to the
// user's repo as cvportal. ArgoCD syncs them into the project's namespace
// within ~a minute and the self-bootstrapping image creates the bucket + key.
// The credentials live in the projects row so a later disable/enable cycle
// keeps the same access key and the existing PVC's objects stay usable.
router.post('/projects/:id/storage/enable', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    if (!project.gitea_repo) {
      res.status(400).send(renderError('Bad Request', 'Project has no Gitea repo.'));
      return;
    }
    const [owner, repo] = project.gitea_repo.split('/');
    // Atomic claim: concurrent calls don't desync the DB credentials from the
    // ones that end up sealed in the repo. See
    // services/projects.ts:claimOrGetGarageCredentials.
    const existing = decodeGarageCredentials(project);
    const { creds } = existing
      ? { creds: existing }
      : await claimOrGetGarageCredentials(project.id, generateGarageCredentials());
    await enableProjectGarage({ owner, repo, slug: project.slug, creds });
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Storage enable error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to enable storage.'));
  }
});

// POST /projects/:id/storage/disable — remove the garage manifest + sealed
// secret (ArgoCD prunes the StatefulSet/Service). If the form carries
// destroy_data=true the portal also deletes the PVC and clears the stored
// credentials so the next enable starts fresh.
router.post('/projects/:id/storage/disable', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const destroyData = req.body?.destroy_data === 'true' || req.body?.destroy_data === 'on';
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    if (!project.gitea_repo) {
      res.status(400).send(renderError('Bad Request', 'Project has no Gitea repo.'));
      return;
    }
    const [owner, repo] = project.gitea_repo.split('/');
    await disableProjectGarage({ owner, repo });
    if (destroyData) {
      // Best-effort: the PVC delete may queue behind the StatefulSet pod
      // terminating. We clear the credentials regardless — re-enable mints
      // fresh ones against the fresh PVC.
      try { await destroyGaragePvc(project.slug); }
      catch (e: any) { console.warn('[storage/disable] PVC delete failed:', e?.message); }
      await clearGarageCredentials(project.id);
    }
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Storage disable error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to disable storage.'));
  }
});

// POST /projects/:id/access — grant a subject (user, group, or everyone) a
// level on ONE area (owner only). Form: `facet` ('site'|'repo'), `level`
// ('read'|'write'|'admin'), `subject_type` ('user'|'group'|'everyone'),
// `identifier` (email/username or group name; unused for everyone). The two
// areas are edited independently — a grant the subject already holds on the
// OTHER area is preserved. Site access takes effect within seconds (the edge
// auth endpoint reads the DB live); repo grants converge Gitea collaborators.
router.post('/projects/:id/access', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    const facet: GrantFacet = req.body?.facet === 'repo' ? 'repo' : 'site';
    const rawLevel = String(req.body?.level || '');
    if (!isGrantLevel(rawLevel)) {
      res.status(400).send(renderError('Invalid Input', 'Level must be read, write, or admin.'));
      return;
    }
    const level: GrantLevel = rawLevel;
    const rawSubject = req.body?.subject_type;
    const subjectType: SubjectType =
      rawSubject === 'group' ? 'group' : rawSubject === 'everyone' ? 'everyone' : 'user';

    // The org-wide `everyone` subject is capped at read/write on both areas.
    if (subjectType === 'everyone' && level === 'admin') {
      res.status(400).send(renderError('Invalid Input', '“Everyone” cannot be granted Admin — use read or write for org-wide access.'));
      return;
    }

    if (subjectType === 'everyone') {
      await setGrantFacet({
        projectId: project.id, subjectType: 'everyone',
        subjectId: EVERYONE_SUBJECT_ID, subjectName: EVERYONE_SUBJECT_NAME,
        facet, level,
      });
    } else if (subjectType === 'group') {
      const identifier = String(req.body?.identifier || '').trim();
      if (!identifier) {
        res.status(400).send(renderError('Invalid Input', 'Provide a group name.'));
        return;
      }
      const group = await getGroupByName(identifier.toLowerCase());
      if (!group) {
        res.status(404).send(renderError('Not Found', `No group named "${identifier}". Create it under Groups first.`));
        return;
      }
      await setGrantFacet({
        projectId: project.id, subjectType: 'group', subjectId: group.id,
        subjectName: group.name, facet, level,
      });
    } else {
      const identifier = String(req.body?.identifier || '').trim();
      if (!identifier || identifier.length > 254) {
        res.status(400).send(renderError('Invalid Input', 'Provide a user email or username.'));
        return;
      }
      const identity = identifier.includes('@')
        ? await findIdentityByEmail(identifier)
        : await findIdentityByUsername(identifier);
      if (!identity) {
        res.status(404).send(renderError('Not Found', `No Corpo Valley member matches "${identifier}".`));
        return;
      }
      const meta = (identity.metadata_public ?? {}) as Record<string, any>;
      if (meta.type === 'bot') {
        res.status(400).send(renderError('Invalid Subject', 'Bot identities cannot be granted access directly.'));
        return;
      }
      if (identity.id === project.owner_id) {
        res.status(400).send(renderError('Invalid Subject', 'The owner already has full access.'));
        return;
      }
      const traits = (identity.traits ?? {}) as Record<string, any>;
      await setGrantFacet({
        projectId: project.id, subjectType: 'user', subjectId: identity.id,
        subjectName: traits.email || traits.preferred_username || identity.id,
        giteaUsername: giteaUsernameForIdentity(identity),
        facet, level,
      });
    }

    if (facet === 'repo') {
      const fresh = await getProjectById(project.id);
      if (fresh) {
        syncRepoAccess(fresh).catch((e: any) =>
          console.error(`[dashboard] repo access sync failed for ${fresh.slug}:`, e?.message));
      }
    }
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Access grant error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to update access.'));
  }
});

// POST /projects/:id/access/:grantId/revoke — remove a subject's level on ONE
// area (owner only). Form: `facet` ('site'|'repo'). When the subject is left
// with no grant on either area the grant row is deleted entirely.
router.post('/projects/:id/access/:grantId/revoke', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    const facet: GrantFacet = req.body?.facet === 'repo' ? 'repo' : 'site';
    const grant = await getGrantById(req.params.grantId);
    if (grant && grant.project_id === project.id) {
      const hadRepo = !!grant.repo_perm;
      await revokeGrantFacet(grant.id, facet);
      if (facet === 'repo' && hadRepo) {
        syncRepoAccess(project).catch((e: any) =>
          console.error(`[dashboard] repo access sync failed for ${project.slug}:`, e?.message));
      }
    }
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Access revoke error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to remove access.'));
  }
});

// POST /projects/:id/delete — delete a project (owner only).
//
// Cascade: tears down the Gitea repo + ArgoCD Application + project
// namespace (which cascades pods/PVCs/secrets/etc.) before dropping the
// portal DB row. Partial failures are logged but never block the DB drop —
// otherwise a one-step Gitea outage leaves the project undeleteable from
// the user's project list. Every step is 404-tolerant, so a retry safely
// picks up any straggler resources.
router.post('/projects/:id/delete', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    const purge = await purgeProjectResources(project);
    if (purge.errors.length > 0) {
      console.warn(`[dashboard] partial cascade-delete for ${project.slug}:`, purge.errors.join('; '));
    }
    await deleteProject(project.id);
    res.redirect('/');
  } catch (err: any) {
    console.error('Project delete error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to delete project.'));
  }
});

// ── API Keys (generic platform keys, Hydra client_credentials) ──

// GET /connect — alias for /keys; the page is now "Connect Claude Code"
// with MCP setup as the headline and API keys behind a disclosure.
router.get('/connect', requireSession, (req: Request, res: Response) => res.redirect(307, '/keys'));

// GET /keys — list MY API keys
router.get('/keys', requireSession, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const isAdmin = await isUserAdmin(session.id);
    const keys = await listUserApiKeys(session.id);
    const keyRows: ApiKeyRow[] = keys.map(k => ({
      clientId: k.client_id || '',
      createdAt: k.created_at ? new Date(k.created_at).toLocaleDateString() : 'Unknown',
    }));
    const csrf = csrfHiddenField(req, res);
    res.send(renderKeyManagement(keyRows, session.email, isAdmin, hydraPublicUrl, csrf));
  } catch (err: any) {
    console.error('Key list error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to load API keys.'));
  }
});

// POST /keys — create a new API key
router.post('/keys', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const isAdmin = await isUserAdmin(session.id);
    const { clientId, clientSecret } = await createApiKey(session.id);
    res.send(renderNewKeyDisplay(clientId, clientSecret, session.email, isAdmin, hydraPublicUrl));
  } catch (err: any) {
    console.error('Key create error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to create API key.'));
  }
});

// POST /keys/:keyId/revoke — revoke one of MY keys
router.post('/keys/:keyId/revoke', requireSession, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const { keyId } = req.params;
  try {
    const owned = await isKeyOwnedBy(keyId, session.id);
    if (!owned) {
      res.status(403).send(renderError('Forbidden', 'This key does not belong to you.'));
      return;
    }
    await deleteClient(keyId);
    res.redirect('/keys');
  } catch (err: any) {
    console.error('Key revoke error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to revoke API key.'));
  }
});

export default router;
