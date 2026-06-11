// Seeds the Community Center template repo in Gitea from the baseline tree
// baked into the portal image (community-center/ in this monorepo).
//
// Lifecycle model: the baseline in code is the FACTORY DEFAULT. The portal
// pushes it to Gitea exactly once — on startup, only when the Gitea repo is
// missing or empty. From then on Gitea is the source of truth: platform
// admins edit the template there, and every new project generates from
// whatever it currently holds. The baseline is pushed again only on an
// explicit reset (POST /admin/template/reset), which makes the Gitea repo
// match the baseline exactly — including deleting files admins added.
//
// Rendering: the baseline carries two kinds of placeholder. {{OWNER}},
// {{REPO}} and {{SLUG}} are per-project markers in the k8s/ reference copies
// (manifests.ts regenerates those files at project create; the markers are
// documentation). {{CV_*}} placeholders are THIS DEPLOYMENT's values —
// registry DNS, portal/Kratos URLs, projects domain — rendered here at seed
// time from platform-config so admin edits start from deployment-correct
// content.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  giteaEnabled, getRepo, ensureOrg, createOrgRepo, setRepoTemplate,
  getTreeFiles, upsertRepoFile, deleteRepoFile,
} from './gitea';
import { TEMPLATE_GITEA_OWNER, TEMPLATE_GITEA_REPO } from './templates';
import {
  CV_REGISTRY, PORTAL_INTERNAL_URL, PORTAL_PUBLIC_URL,
  KRATOS_CLUSTER_URL, PROJECTS_DOMAIN,
} from './platform-config';

// Locate the baseline tree. In the container it's /app/community-center
// (two levels up from dist/services); in a dev checkout it's at the monorepo
// root (four levels up from typescript/portal/{src,dist}/services).
function findBaselineDir(): string | null {
  const candidates = [
    process.env.CV_TEMPLATE_DIR,
    path.resolve(__dirname, '../../community-center'),
    path.resolve(__dirname, '../../../../community-center'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'package.json'))) return c;
  }
  return null;
}

const RENDER_VARS: Record<string, string> = {
  '{{CV_REGISTRY}}': CV_REGISTRY,
  '{{CV_PORTAL_PIN_URL}}': `${PORTAL_INTERNAL_URL}/internal/projects`,
  '{{CV_PORTAL_LOGIN_URL}}': `${PORTAL_PUBLIC_URL}/login`,
  '{{CV_KRATOS_PUBLIC_URL}}': KRATOS_CLUSTER_URL,
  '{{CV_PROJECTS_DOMAIN}}': PROJECTS_DOMAIN,
};

export function renderTemplateFile(content: string): string {
  let out = content;
  for (const [token, value] of Object.entries(RENDER_VARS)) {
    out = out.split(token).join(value);
  }
  return out;
}

// Read + render the whole baseline: repo-relative path -> rendered content.
// Dotfiles (.gitea/, .gitignore, ...) are part of the template and included.
function loadBaseline(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile()) {
        files.set(relPath, renderTemplateFile(fs.readFileSync(path.join(dir, relPath), 'utf8')));
      }
    }
  };
  walk('');
  return files;
}

// Read + render one baseline file (pin-token-backfill refreshes tenant
// build.yaml from the same canonical source the seed pushes). Null when the
// baseline isn't on disk.
export function renderedBaselineFile(relPath: string): string | null {
  const dir = findBaselineDir();
  if (!dir) return null;
  const abs = path.join(dir, relPath);
  if (!fs.existsSync(abs)) return null;
  return renderTemplateFile(fs.readFileSync(abs, 'utf8'));
}

// Git blob sha of `content` — lets the sync skip files Gitea already holds
// verbatim, so a no-op seed/reset writes zero commits.
function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

export interface SeedResult {
  action: 'seeded' | 'reset' | 'skipped' | 'disabled';
  reason?: string;
  written?: number;
  deleted?: number;
}

export async function seedCommunityCenterTemplate(
  opts: { force?: boolean } = {}
): Promise<SeedResult> {
  if (!giteaEnabled()) {
    return { action: 'disabled', reason: 'Gitea integration is not configured' };
  }
  const dir = findBaselineDir();
  if (!dir) {
    return { action: 'skipped', reason: 'baseline community-center/ tree not found on disk' };
  }
  const owner = TEMPLATE_GITEA_OWNER;
  const repoName = TEMPLATE_GITEA_REPO;

  await ensureOrg(owner);
  const repo = await getRepo({ owner, repo: repoName });
  let created = false;
  if (!repo) {
    await createOrgRepo({
      org: owner,
      name: repoName,
      description: 'Corpo Valley Community Center — the template every project starts from',
    });
    created = true;
  }

  const existing = await getTreeFiles({ owner, repo: repoName });
  // auto_init's README.md is sync residue, not admin content — a repo holding
  // only that still counts as empty for the seed-if-absent check.
  const hasAdminContent = existing.some((e) => e.path !== 'README.md');
  if (!created && hasAdminContent && !opts.force) {
    return { action: 'skipped', reason: 'template repo already has content (admin-owned)' };
  }

  // The generate endpoint refuses non-template sources; make sure the flag is
  // set even on repos created before this seeding existed.
  if (created || !repo?.template) {
    await setRepoTemplate({ owner, repo: repoName });
  }

  const baseline = loadBaseline(dir);
  const existingByPath = new Map(existing.map((e) => [e.path, e.sha]));
  let written = 0;
  let deleted = 0;

  for (const [relPath, content] of baseline) {
    const prevSha = existingByPath.get(relPath);
    if (prevSha && prevSha === gitBlobSha(content)) continue;
    await upsertRepoFile({
      owner, repo: repoName, path: relPath, content,
      sha: prevSha,
      message: `platform: ${opts.force ? 'reset' : 'seed'} ${relPath} from baseline`,
    });
    written++;
  }
  for (const e of existing) {
    if (baseline.has(e.path)) continue;
    await deleteRepoFile({
      owner, repo: repoName, path: e.path, sha: e.sha,
      message: `platform: ${opts.force ? 'reset' : 'seed'} — remove ${e.path} (not in baseline)`,
    });
    deleted++;
  }

  return { action: opts.force && !created ? 'reset' : 'seeded', written, deleted };
}

// Lightweight status for the admin page.
export interface TemplateStatus {
  giteaEnabled: boolean;
  baselineOnDisk: boolean;
  repo: string;
  repoExists: boolean;
  isTemplate: boolean;
  fileCount: number;
}

export async function communityCenterTemplateStatus(): Promise<TemplateStatus> {
  const repoFull = `${TEMPLATE_GITEA_OWNER}/${TEMPLATE_GITEA_REPO}`;
  const base: TemplateStatus = {
    giteaEnabled: giteaEnabled(),
    baselineOnDisk: findBaselineDir() !== null,
    repo: repoFull,
    repoExists: false,
    isTemplate: false,
    fileCount: 0,
  };
  if (!base.giteaEnabled) return base;
  const repo = await getRepo({ owner: TEMPLATE_GITEA_OWNER, repo: TEMPLATE_GITEA_REPO });
  if (!repo) return base;
  base.repoExists = true;
  base.isTemplate = !!repo.template;
  base.fileCount = (await getTreeFiles({ owner: TEMPLATE_GITEA_OWNER, repo: TEMPLATE_GITEA_REPO })).length;
  return base;
}
