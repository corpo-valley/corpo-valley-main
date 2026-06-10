import { Router, Request, Response } from 'express';
import { requireSession, requireVerifiedEmail } from '../middleware/session';
import { POST_LOGIN_COOKIE } from './kratos';
import { csrfHiddenField } from '../middleware/csrf';
import { getUserTier } from '../services/keto';
import { createApiKey, listUserApiKeys, isKeyOwnedBy, deleteClient } from '../services/hydra-admin';
import {
  listProjectsByOwner, getProjectById, getProjectBySlug, createProject, updateProjectAccess,
  deleteProject, slugExists, isValidSlug, isServiceAccess, isRepoAccess,
  setGiteaRepo,
  clearPostgresPassword,
  claimOrGetPostgresPassword, decodePostgresPassword,
  setPinTokenHash,
  SERVICE_ACCESS, REPO_ACCESS,
} from '../services/projects';
import { generatePinToken, hashPinToken } from '../services/pin-token';
import {
  enablePostgres as enableProjectPostgres,
  disablePostgres as disableProjectPostgres,
  destroyPostgresPvc,
  postgresEnabled as projectPostgresEnabled,
  generatePostgresPassword,
} from '../services/postgres';
import {
  parseCapabilities, requiresPostgres, capabilityList,
  TEMPLATE_GITEA_OWNER, TEMPLATE_GITEA_REPO,
} from '../services/templates';
import { composeProjectManifests } from '../services/manifests';
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
import {
  renderProjects, renderProjectCreate, renderProjectDetail,
  renderKeyManagement, renderNewKeyDisplay, renderError,
  renderGiteaCliTokenReveal,
  ProjectRow, ApiKeyRow,
} from '../templates';
import * as crypto from 'crypto';

const router = Router();

const PROJECTS_DOMAIN = process.env.PROJECTS_DOMAIN || 'projects.corpo-valley.com';

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
  id: string; slug: string; name: string;
  service_access: string; repo_access: string; created_at: string;
  gitea_repo?: string | null;
}, extras: { postgresEnabled?: boolean } = {}): ProjectRow {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    serviceAccess: p.service_access,
    repoAccess: p.repo_access,
    createdAt: p.created_at ? new Date(p.created_at).toLocaleDateString() : '—',
    giteaRepo: p.gitea_repo ?? null,
    postgresEnabled: extras.postgresEnabled ?? false,
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

  try {
    const tier = await getUserTier(session.id);
    const projects = await listProjectsByOwner(session.id);
    res.send(renderProjects(
      session.email,
      projects.map((p) => toProjectRow(p)),
      tier,
      tier === 'ADMIN',
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
    const tier = await getUserTier(session.id);
    const csrf = csrfHiddenField(req, res);
    res.send(renderProjectCreate(
      session.email, tier === 'ADMIN', csrf, '', {},
    ));
  } catch (err: any) {
    console.error('Project create form error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to load form.'));
  }
});

// POST /projects — create a project owned by the logged-in user.
// New form sends `name` + `visibility`; legacy `slug` / `service_access` /
// `repo_access` are still accepted (advanced override). Slug derives from
// name when not provided.
router.post('/projects', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const { slug: rawSlug, name, service_access, repo_access, visibility } = req.body || {};

  const tier = await getUserTier(session.id).catch(() => 'EVERYONE');
  const isAdmin = tier === 'ADMIN';
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

  // Visibility preset → (service_access, repo_access) pair. `custom` means
  // the user filled in the advanced fields explicitly; private / internal map
  // to the two canonical tiers. Corpo Valley intentionally has no `public`
  // preset — neither repo nor deployed site can be exposed unauthenticated.
  const presets: Record<string, { service: typeof SERVICE_ACCESS[number]; repo: typeof REPO_ACCESS[number] } | null> = {
    private:  { service: 'private', repo: 'private-edit' },
    internal: { service: 'shared',  repo: 'shared-edit'  },
    custom:   null,
  };
  const v = typeof visibility === 'string' && visibility in presets ? visibility : 'private';
  const preset = presets[v];
  // For `custom`, the user MUST supply both advanced fields; for the named
  // presets, advanced fields override individual axes if provided.
  const serviceAccess = (service_access && typeof service_access === 'string' && service_access.trim())
    ? service_access : preset?.service;
  const repoAccess = (repo_access && typeof repo_access === 'string' && repo_access.trim())
    ? repo_access : preset?.repo;
  if (!serviceAccess || !isServiceAccess(serviceAccess)) {
    return fail('Service access must be private or shared.');
  }
  if (!repoAccess || !isRepoAccess(repoAccess)) {
    return fail('Repo access must be private-edit or shared-edit.');
  }

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
    const project = await createProject({
      slug,
      name,
      ownerId: session.id,
      serviceAccess,
      repoAccess,
    });
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
    const tier = await getUserTier(session.id);
    const csrf = csrfHiddenField(req, res);
    const secrets = await listProjectSecretNames(project);
    let postgresEnabledNow = false;
    if (project.gitea_repo) {
      const [pgOwner, pgRepo] = project.gitea_repo.split('/');
      postgresEnabledNow = await projectPostgresEnabled({ owner: pgOwner, repo: pgRepo }).catch(() => false);
    }
    res.send(renderProjectDetail(
      session.email, tier === 'ADMIN',
      toProjectRow(project, { postgresEnabled: postgresEnabledNow }),
      csrf, secrets,
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
    const tier = await getUserTier(session.id).catch(() => 'EVERYONE');
    res.send(renderGiteaCliTokenReveal(
      session.email, tier === 'ADMIN', toProjectRow(project), username, token, tokenName
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
    const tier = await getUserTier(session.id).catch(() => 'EVERYONE');
    const project = await getProjectById(req.params.id);
    if (!project) { res.status(404).send(renderError('Not Found', 'Project not found.')); return; }
    const csrf = csrfHiddenField(req, res);
    const secrets = await listProjectSecretNames(project);
    res.status(status).send(renderProjectDetail(
      session.email, tier === 'ADMIN', toProjectRow(project), csrf, secrets,
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

// POST /projects/:id — update access settings (owner only)
router.post('/projects/:id', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const { service_access, repo_access } = req.body || {};
  try {
    const project = await getProjectById(req.params.id);
    if (!project || project.owner_id !== session.id) {
      res.status(404).send(renderError('Not Found', 'Project not found.'));
      return;
    }
    if (!isServiceAccess(service_access) || !isRepoAccess(repo_access)) {
      res.status(400).send(renderError('Invalid Input', 'Invalid access values.'));
      return;
    }
    await updateProjectAccess(project.id, service_access, repo_access);
    res.redirect(`/projects/${project.id}`);
  } catch (err: any) {
    console.error('Project update error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to update project.'));
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
    const tier = await getUserTier(session.id);
    const keys = await listUserApiKeys(session.id);
    const keyRows: ApiKeyRow[] = keys.map(k => ({
      clientId: k.client_id || '',
      createdAt: k.created_at ? new Date(k.created_at).toLocaleDateString() : 'Unknown',
    }));
    const csrf = csrfHiddenField(req, res);
    res.send(renderKeyManagement(keyRows, session.email, tier === 'ADMIN', hydraPublicUrl, csrf));
  } catch (err: any) {
    console.error('Key list error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to load API keys.'));
  }
});

// POST /keys — create a new API key
router.post('/keys', requireSession, requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const tier = await getUserTier(session.id);
    const { clientId, clientSecret } = await createApiKey(session.id);
    res.send(renderNewKeyDisplay(clientId, clientSecret, session.email, tier === 'ADMIN', hydraPublicUrl));
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
