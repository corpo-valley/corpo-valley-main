// MCP server core. Implements the Model Context Protocol (streamable HTTP
// transport) on top of the portal's existing service layer so an MCP-aware
// agent (Claude Code, Cursor, Codex, …) can manage Corpo Valley projects
// without a human in the loop.
//
// Auth happens at the route layer (Bearer token introspected via Hydra).
// Here we just accept a `userId` in the request context and treat it as
// the project owner for the duration of the call.
//
// Transport: a single HTTP endpoint serves JSON-RPC 2.0 over POST. Each
// request is one JSON object (no batching for now). Responses are
// `application/json` — no SSE needed because all tool calls are short.

import * as crypto from 'crypto';
import {
  createProject, getProjectById, listProjectsByOwner, deleteProject,
  slugExists, isValidSlug, SERVICE_ACCESS, REPO_ACCESS,
  setGiteaRepo, clearPostgresPassword,
  claimOrGetPostgresPassword, decodePostgresPassword,
  setPinTokenHash,
  type Project,
} from './projects';
import {
  enablePostgres, disablePostgres, postgresEnabled,
  destroyPostgresPvc, generatePostgresPassword,
} from './postgres';
import {
  parseCapabilities, requiresPostgres, capabilityList, defaultCapabilities,
  TEMPLATE_GITEA_OWNER, TEMPLATE_GITEA_REPO,
  type Capabilities,
} from './templates';
import { composeProjectManifests, detectCapabilities } from './manifests';
import { provisionProject } from './provisionProject';
import {
  ensureUser, generateFromTemplate, getFile,
  setBranchProtection, mintUserCliToken,
  upsertRepoFile, listRepoFiles, deleteRepoFile,
  getBranchHead, getCommitStatus,
  setActionsSecret,
  listPullRequests, createPullRequest, mergePullRequest,
  listActionsRuns, listActionsRunJobs, getActionsJobLogs,
  giteaEnabled,
} from './gitea';
import { generatePinToken, hashPinToken } from './pin-token';
import {
  createArgoApplication, k8sEnabled, k8sGetNamespaced, k8sListNamespaced, k8sPodLogs,
  getArgoApplication, triggerArgoSync, k8sDeletePodsByLabel,
  applyMcpGateway, removeMcpGateway, namespaceExists,
} from './k8s';
import { purgeProjectResources } from './project-purge';
import { buildSealedSecretYaml } from './seal';
import { getDocsTopic, listDocsTopics, type DocsTopic } from './mcp-docs';
import { PROJECTS_DOMAIN, GITEA_PUBLIC_URL } from './platform-config';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = {
  name: 'corpo-valley-mcp',
  version: '0.1.0',
};

const CV_PROJECTS_ARGOCD_NAMESPACE = process.env.CV_PROJECTS_ARGOCD_NAMESPACE || 'cv-projects-argocd';
const CV_PROJECTS_APPPROJECT = process.env.CV_PROJECTS_APPPROJECT || 'projects';

export interface McpContext {
  // Kratos identity id (from Hydra token introspection `sub`).
  userId: string;
  // Email if available, for ensureUser bootstrapping.
  email?: string;
  // Preferred username, for Gitea credential minting.
  preferredUsername?: string;
  // Whether the identity's email is verified — gates provisioning tools so an
  // unverified self-registered user can't spin up compute / mint credentials.
  emailVerified: boolean;
}

// Throw from a provisioning tool when the caller's email isn't verified.
function requireVerified(ctx: McpContext): void {
  if (!ctx.emailVerified) {
    throw new ToolError('email verification required: verify your Corpo Valley email before provisioning resources.');
  }
}

// ── JSON-RPC types ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: any;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: any };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// MCP error codes follow the JSON-RPC convention (-32xxx ranges).
const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_INTERNAL = -32603;
const E_TOOL_FAILED = -32000;

function ok(id: JsonRpcRequest['id'] | undefined, result: any): JsonRpcSuccess {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function err(id: JsonRpcRequest['id'] | undefined, code: number, message: string, data?: any): JsonRpcError {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ── Tool registry ──────────────────────────────────────────────────────────

interface ToolDef {
  description: string;
  inputSchema: any;
  handler: (ctx: McpContext, args: any) => Promise<any>;
}

const tools: Record<string, ToolDef> = {
  list_projects: {
    description: 'List all Corpo Valley projects owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(ctx) {
      const rows = await listProjectsByOwner(ctx.userId);
      return { projects: rows.map(toToolProject) };
    },
  },

  get_project: {
    description: 'Get the full record for a single project owned by the user, by uuid or slug. Includes the enabled `capabilities` (derived from the repo manifests) and `postgres.enabled`. Returns null if not found or not owned by the caller.',
    inputSchema: {
      type: 'object',
      required: ['id_or_slug'],
      properties: { id_or_slug: { type: 'string', description: 'Project uuid or slug.' } },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const p = await resolveOwnedProject(ctx, args.id_or_slug);
      if (!p) return null;
      let pgEnabled = false;
      let caps = defaultCapabilities();
      if (p.gitea_repo) {
        const [o, r] = p.gitea_repo.split('/');
        pgEnabled = await postgresEnabled({ owner: o, repo: r }).catch(() => false);
        caps = await detectCapabilities({ owner: o, repo: r }).catch(() => caps);
      }
      return { ...toToolProject(p), capabilities: capabilityList(caps), postgres: { enabled: pgEnabled } };
    },
  },

  create_project: {
    description: 'Plant a new Corpo Valley project. Every project gets a website. Pass `capabilities` to also add a Postgres-backed database (JSON API at /api) and/or an MCP endpoint (at /mcp). Provisions a Gitea repo from the Community Center template, seals the project namespace (Pod Security + default-deny egress NetworkPolicy + resource quota), generates the k8s manifests for the chosen capabilities (one container each, path-routed), auto-enables Postgres when the database capability is on, registers an ArgoCD Application, and sets branch protection. Returns the new project record (live URL, Gitea repo, capabilities, and `postgres.enabled`). Slug auto-derives from name when not provided.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, description: 'Human-readable name.' },
        slug: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 63, description: 'Optional URL slug; derived from name when omitted.' },
        visibility: { type: 'string', enum: ['private', 'internal'], description: 'Who can see it. `private` = only the owner; `internal` = any signed-in Corpo Valley member (still auth-gated). Defaults to private. Corpo Valley does not publish projects publicly.' },
        capabilities: {
          type: 'object',
          description: 'Which optional capabilities to enable. The website is always on.',
          properties: {
            database: { type: 'boolean', description: 'Add a Postgres-backed JSON API at /api. Auto-provisions a per-project Postgres.' },
            mcp: { type: 'boolean', description: 'Add an MCP endpoint at /mcp so agents can connect to this project.' },
            shared: { type: 'boolean', description: 'Data/views are shared across users. Default false = each user only sees their own data.' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const name = String(args.name || '').trim();
      if (!name) throw new ToolError('name is required');
      const visibility = (args.visibility && ['private', 'internal'].includes(args.visibility)) ? args.visibility : 'private';
      const presets: Record<string, { service: typeof SERVICE_ACCESS[number]; repo: typeof REPO_ACCESS[number] }> = {
        private: { service: 'private', repo: 'private-edit' },
        internal: { service: 'shared', repo: 'shared-edit' },
      };
      const preset = presets[visibility];
      const caps = parseCapabilities(args.capabilities);
      const sluggify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
      const slug = (typeof args.slug === 'string' && args.slug.trim()) ? args.slug.trim() : sluggify(name);
      if (!isValidSlug(slug)) throw new ToolError(`slug "${slug}" is invalid; must be lowercase letters, digits, and hyphens (max 63 chars).`);
      if (await slugExists(slug)) throw new ToolError(`slug "${slug}" is already taken.`);
      // Slug availability is NOT just the DB row: a prior project's namespace can
      // outlive its DB row (best-effort teardown / keep_namespace). Refuse to
      // claim a slug whose namespace still exists, or the new owner would
      // inherit the previous tenant's live namespace + secrets.
      if (await namespaceExists(slug)) throw new ToolError(`slug "${slug}" is not available (its namespace still exists).`);

      const project = await createProject({
        slug, name, ownerId: ctx.userId,
        serviceAccess: preset.service, repoAccess: preset.repo,
      });

      // Unified provisioning (shared with the dashboard): seals the namespace
      // baseline, then provisions repo/postgres/manifests/argocd. Best-effort —
      // the project row is the source of truth.
      const prov = await provisionProject(project, caps, {
        ownerUsername: ctx.preferredUsername, email: ctx.email, logTag: 'mcp',
      });
      return {
        ...toToolProject(project),
        application_registered: prov.argoRegistered,
        capabilities: capabilityList(caps),
        postgres: { enabled: prov.postgresEnabled },
      };
    },
  },

  delete_project: {
    description: `Delete a Corpo Valley project AND all its external resources: the Gitea repository, the ArgoCD Application in ${CV_PROJECTS_ARGOCD_NAMESPACE} (which prunes the running pods/PVCs/Secrets), the project's Kubernetes namespace, and finally the portal DB row. This is destructive and irreversible — Postgres data and any committed code go too. Pass \`keep_repo: true\` to retain the Gitea repo (e.g. to fork/archive it) or \`keep_namespace: true\` to retain the cluster namespace (e.g. for forensic inspection). Requires \`confirm_slug\` to match the project slug exactly to prevent accidents.`,
    inputSchema: {
      type: 'object',
      required: ['id_or_slug', 'confirm_slug'],
      properties: {
        id_or_slug: { type: 'string' },
        confirm_slug: { type: 'string' },
        keep_repo: { type: 'boolean', default: false, description: 'Skip the Gitea repo delete. Default false (repo is deleted).' },
        keep_namespace: { type: 'boolean', default: false, description: 'Skip the k8s namespace delete. Default false (namespace + PVCs are deleted).' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (args.confirm_slug !== p.slug) throw new ToolError('confirm_slug must equal the project slug exactly.');
      const purge = await purgeProjectResources(p, {
        keepRepo: !!args.keep_repo,
        keepNamespace: !!args.keep_namespace,
      });
      await deleteProject(p.id);
      return {
        deleted: true,
        slug: p.slug,
        cascade: purge,
      };
    },
  },

  enable_postgres: {
    description: 'Turn on a per-project Postgres database. The platform commits a StatefulSet + sealed credentials Secret (named `postgres`) to the project repo as cvportal; ArgoCD deploys a one-replica postgres pod in the project namespace within a minute. The platform-generated `database` container reads the connection string from `DATABASE_URL`, projected from the `postgres` Secret via `valueFrom.secretKeyRef`. If you hand-write your own Deployment instead, read `DATABASE_URL` (or the components POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB) from the same `postgres` Secret. Idempotent — calling on an already-enabled project just refreshes the manifest with the same password so existing data keeps working.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: { project_id_or_slug: { type: 'string', description: 'Project uuid or slug.' } },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('project has no Gitea repo yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      // Atomic claim: concurrent calls don't desync the DB password
      // from the password that ends up sealed in the repo. See
      // services/projects.ts:claimOrGetPostgresPassword.
      const existingPw = decodePostgresPassword(p);
      const { password } = existingPw
        ? { password: existingPw }
        : await claimOrGetPostgresPassword(p.id, generatePostgresPassword());
      const { secret_name, env_var } = await enablePostgres({ owner, repo, slug: p.slug, password });
      return {
        ok: true,
        slug: p.slug,
        secret_name,
        env_var,
        usage: `The platform-generated database container already reads ${env_var} from the ${secret_name} Secret via valueFrom.secretKeyRef. If you hand-write your own Deployment, project ${env_var} from the ${secret_name} Secret (valueFrom.secretKeyRef, or envFrom for all keys).`,
      };
    },
  },

  disable_postgres: {
    description: 'Remove the per-project Postgres deployment. The manifest + sealed Secret are deleted from the repo (ArgoCD prunes the StatefulSet, Service, and Secret on next sync). The PVC is preserved by default so re-enabling restores the same data; pass `destroy_data: true` to also delete the PVC and clear the stored password (irreversible — drops all data). Idempotent.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: {
        project_id_or_slug: { type: 'string' },
        destroy_data: { type: 'boolean', default: false, description: 'Also delete the PVC and clear the stored password. Cannot be undone.' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('project has no Gitea repo yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      const result = await disablePostgres({ owner, repo });
      let pvcDeleted = false;
      if (args.destroy_data) {
        try { ({ deleted: pvcDeleted } = await destroyPostgresPvc(p.slug)); }
        catch (e: any) { /* swallow — caller can re-try; see warning below */ console.warn('[mcp/disable_postgres] PVC delete failed:', e?.message); }
        await clearPostgresPassword(p.id);
      }
      return {
        ok: true,
        slug: p.slug,
        removed_manifest: result.removed_manifest,
        removed_secret: result.removed_secret,
        pvc_deleted: pvcDeleted,
        note: args.destroy_data
          ? 'Data destruction requested. The PVC delete may be queued behind the StatefulSet pod terminating; re-call with the same args if pvc_deleted=false.'
          : 'Data preserved. The PVC stays bound; re-enable with `enable_postgres` to mount the same data.',
      };
    },
  },

  set_capabilities: {
    description: 'Change which capabilities a project has. The website is always on; toggle `database` (Postgres-backed /api) and `mcp` (/mcp endpoint), and `shared` (per-user vs shared data). Only the fields you pass are changed; the rest keep their current state. The platform enables/disables the per-project Postgres as needed, regenerates k8s/deployment.yaml + Services + Ingress, and commits them — ArgoCD rolls out the change within a minute. Disabling the database preserves its data (the PVC stays) unless you also call disable_postgres with destroy_data. Returns the resulting capability set.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: {
        project_id_or_slug: { type: 'string' },
        database: { type: 'boolean', description: 'Enable/disable the database capability (/api + per-project Postgres).' },
        mcp: { type: 'boolean', description: 'Enable/disable the MCP capability (/mcp endpoint).' },
        shared: { type: 'boolean', description: 'Data/views shared across users (true) vs per-user isolation (false).' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('project has no Gitea repo yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      const current = await detectCapabilities({ owner, repo });
      const next: Capabilities = {
        website: true,
        database: typeof args.database === 'boolean' ? args.database : current.database,
        mcp: typeof args.mcp === 'boolean' ? args.mcp : current.mcp,
        shared: typeof args.shared === 'boolean' ? args.shared : current.shared,
      };
      // Sharing only matters when there's user data; force it off otherwise.
      if (!next.database && !next.mcp) next.shared = false;

      // Bring Postgres in line with the database capability BEFORE writing the
      // manifest, so the secret exists before the database container appears.
      let postgresEnabledNow = current.database;
      if (next.database && !current.database) {
        const existingPw = decodePostgresPassword(p);
        const { password } = existingPw
          ? { password: existingPw }
          : await claimOrGetPostgresPassword(p.id, generatePostgresPassword());
        await enablePostgres({ owner, repo, slug: p.slug, password });
        postgresEnabledNow = true;
      } else if (!next.database && current.database) {
        await disablePostgres({ owner, repo });
        postgresEnabledNow = false;
      }

      await composeProjectManifests({ owner, repo, slug: p.slug, caps: next });

      // Bring the /mcp OAuth gateway routing in line with the mcp capability.
      if (next.mcp && !current.mcp) await applyMcpGateway(p.slug);
      else if (!next.mcp && current.mcp) await removeMcpGateway(p.slug);

      return {
        ok: true,
        slug: p.slug,
        capabilities: capabilityList(next),
        postgres: { enabled: postgresEnabledNow },
        note: 'Manifests committed. ArgoCD will roll out the change within a minute. Push code for any newly-enabled capability if you customised it.',
      };
    },
  },

  get_template: {
    description: 'Read the canonical Community Center template for a capability so you can mirror the platform pattern instead of inventing one. Returns the module\'s source. Use this before adding a capability by hand, or just enable it with set_capabilities and let the platform scaffold it.',
    inputSchema: {
      type: 'object',
      required: ['capability'],
      properties: {
        capability: { type: 'string', enum: ['static-site', 'database', 'mcp'], description: 'Which capability module to fetch.' },
      },
      additionalProperties: false,
    },
    async handler(_ctx, args) {
      const capability = String(args.capability || '');
      const fileFor: Record<string, string> = {
        'static-site': 'static-site/server.js',
        'database': 'database/server.js',
        'mcp': 'mcp/server.js',
      };
      const filePath = fileFor[capability];
      if (!filePath) throw new ToolError(`unknown capability "${capability}"; one of: ${Object.keys(fileFor).join(', ')}.`);
      const file = await getFile({ owner: TEMPLATE_GITEA_OWNER, repo: TEMPLATE_GITEA_REPO, path: filePath }).catch(() => null);
      if (!file) throw new ToolError(`template file ${filePath} not found in ${TEMPLATE_GITEA_OWNER}/${TEMPLATE_GITEA_REPO}.`);
      return {
        capability,
        path: filePath,
        template_repo: `${TEMPLATE_GITEA_OWNER}/${TEMPLATE_GITEA_REPO}`,
        content: file.content,
      };
    },
  },

  get_gitea_credentials: {
    description: 'Mint a fresh Gitea personal access token on the caller\'s Gitea account so the agent can `git clone` and `git push` over HTTPS. Returns the bare `token` and the plain `clone_url`. Supply the token via a git credential helper (e.g. `git -c credential.helper=...` or `GIT_ASKPASS`) rather than embedding it in the remote URL — a creds-in-URL remote leaks the secret into `.git/config`, shell history, and logs. The token is user-wide (not repo-scoped) and stays valid until revoked in Gitea\'s UI.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: { project_id_or_slug: { type: 'string' } },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!ctx.preferredUsername) throw new ToolError('your Corpo Valley account has no Gitea username paired with it.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      // Mint only for the account that owns this repo (see the dashboard
      // cli-token route for the rationale). A user-wide PAT for a username that
      // no longer owns the repo would be both over-broad and useless here.
      const repoOwner = p.gitea_repo.split('/')[0];
      if (repoOwner !== ctx.preferredUsername) {
        throw new ToolError('this project repo is owned by a different Gitea account than your current username; ask an admin to reconcile.');
      }
      const suffix = crypto.randomBytes(3).toString('hex');
      const tokenName = `cv-mcp-${suffix}`;
      const { token } = await mintUserCliToken({
        username: ctx.preferredUsername, tokenName, scopes: ['write:repository'],
      });
      // Deliberately NOT returning a creds-embedded clone URL — that
      // secret-in-URL form leaks into .git/config / shell history / logs. The
      // caller supplies `token` via a credential helper instead.
      return {
        username: ctx.preferredUsername,
        token,
        token_name: tokenName,
        clone_url: `${GITEA_PUBLIC_URL}/${p.gitea_repo}.git`,
        usage: 'git clone with a credential helper, e.g.: git -c credential.helper=\'!f(){ echo "username=' + ctx.preferredUsername + '"; echo "password=$CV_TOKEN"; };f\' clone <clone_url>  (export CV_TOKEN=<token>)',
      };
    },
  },

  set_project_secret: {
    description: 'Create or update a SealedSecret on a project. Seals each KEY=VALUE in-process with the cluster\'s sealed-secrets cert and commits `k8s/secrets/<name>.sealed.yaml` to the project repo. ArgoCD syncs it and the controller materialises the unsealed Kubernetes Secret in the project namespace.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug', 'name', 'data'],
      properties: {
        project_id_or_slug: { type: 'string' },
        name: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 63 },
        data: {
          type: 'object',
          additionalProperties: { type: 'string' },
          minProperties: 1,
          description: 'Map of KEY → VALUE. Keys must match [A-Za-z_][A-Za-z0-9_]*.',
        },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      const name = String(args.name);
      if (!/^[a-z0-9-]+$/.test(name) || name.length > 63) throw new ToolError('secret name must be lowercase letters, digits, and hyphens (max 63 chars).');
      const data: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.data || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ToolError(`invalid key "${k}" — must match [A-Za-z_][A-Za-z0-9_]*.`);
        data[k] = String(v);
      }
      const [owner, repo] = p.gitea_repo.split('/');
      const yaml = await buildSealedSecretYaml({ namespace: p.slug, name, data });
      const existing = await listRepoFiles({ owner, repo, dir: 'k8s/secrets' });
      const existingFile = existing.find((f) => f.name === `${name}.sealed.yaml`);
      await upsertRepoFile({
        owner, repo,
        path: `k8s/secrets/${name}.sealed.yaml`,
        content: yaml,
        message: existingFile ? `mcp: update sealed secret ${name}` : `mcp: add sealed secret ${name}`,
        sha: existingFile?.sha,
      });
      return { sealed: true, name, keys: Object.keys(data), commit_path: `k8s/secrets/${name}.sealed.yaml` };
    },
  },

  delete_project_secret: {
    description: 'Remove a SealedSecret file from a project\'s repo. ArgoCD prunes the in-cluster Secret on the next sync.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug', 'name'],
      properties: {
        project_id_or_slug: { type: 'string' },
        name: { type: 'string', pattern: '^[a-z0-9-]+$' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      const name = String(args.name);
      const [owner, repo] = p.gitea_repo.split('/');
      const files = await listRepoFiles({ owner, repo, dir: 'k8s/secrets' });
      const f = files.find((x) => x.name === `${name}.sealed.yaml`);
      if (!f) return { deleted: false, reason: 'not found' };
      await deleteRepoFile({ owner, repo, path: f.path, sha: f.sha, message: `mcp: delete sealed secret ${name}` });
      return { deleted: true, name };
    },
  },

  get_project_status: {
    description: 'Check the build + scan status of a project at a given ref (branch or sha). Returns the combined state ("success" / "failure" / "pending") and the per-check breakdown — typically Build/build, Scan/semgrep, and Scan/osv-scanner. Use this after pushing code to know whether CI went green; use the `target_url` in each check to deep-link the user to the failed job logs in Gitea.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: {
        project_id_or_slug: { type: 'string' },
        ref: { type: 'string', description: 'Branch name or full commit sha. Defaults to "main".' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      const ref = (typeof args.ref === 'string' && args.ref.trim()) ? args.ref.trim() : 'main';
      // Resolve the ref to a sha: anything that looks like a 7+ hex run is
      // treated as a sha, else as a branch name.
      let sha = ref;
      let branchMeta: Awaited<ReturnType<typeof getBranchHead>> = null;
      if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
        branchMeta = await getBranchHead({ owner, repo, branch: ref });
        if (!branchMeta) throw new ToolError(`branch "${ref}" not found on ${p.gitea_repo}.`);
        sha = branchMeta.sha;
      }
      const status = await getCommitStatus({ owner, repo, sha });
      if (!status) {
        return {
          project: p.slug,
          ref,
          sha,
          state: 'pending',
          total_count: 0,
          checks: [],
          message: 'No status reported yet — CI may not have run on this commit.',
          ...(branchMeta ? { last_commit: { sha: branchMeta.sha, message: branchMeta.message, author: branchMeta.author, date: branchMeta.date } } : {}),
        };
      }
      return {
        project: p.slug,
        ref,
        sha: status.sha,
        state: status.state,
        total_count: status.total_count,
        checks: status.checks,
        ...(branchMeta ? { last_commit: { sha: branchMeta.sha, message: branchMeta.message, author: branchMeta.author, date: branchMeta.date } } : {}),
      };
    },
  },

  list_prs: {
    description: 'List pull requests on a project\'s Gitea repository. Defaults to open PRs. Returns the PR number, title, head/base refs, head SHA (use with `get_project_status` or `get_ci_logs`), mergeable flag, author, and html_url for deep-linking.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: {
        project_id_or_slug: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      const state = (typeof args.state === 'string' ? args.state : 'open') as 'open' | 'closed' | 'all';
      const prs = await listPullRequests({ owner, repo, state });
      return { project: p.slug, state, count: prs.length, prs };
    },
  },

  create_pr: {
    description: 'Open a pull request on a project\'s Gitea repo. Used for the dev/prod promotion pattern: push a feature branch, open a PR against `main`, let the scan workflow gate the merge. `base` defaults to `main`. Returns the created PR (number + html_url).',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug', 'title', 'head'],
      properties: {
        project_id_or_slug: { type: 'string' },
        title: { type: 'string', minLength: 1 },
        head: { type: 'string', description: 'Source branch (e.g. "feature/login").' },
        base: { type: 'string', description: 'Target branch. Defaults to main.' },
        body: { type: 'string', description: 'Optional PR description (markdown).' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx); // merging a PR drives a build/deploy — same gate as every other mutating tool
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      const pr = await createPullRequest({
        owner, repo,
        title: String(args.title).trim(),
        head: String(args.head).trim(),
        base: typeof args.base === 'string' && args.base.trim() ? args.base.trim() : 'main',
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      return { project: p.slug, pr };
    },
  },

  merge_pr: {
    description: 'Merge an open pull request on a project\'s Gitea repo. Defaults to squash-merge. Branch protection means the merge will be rejected if required status checks (semgrep / osv-scanner) haven\'t passed on the PR\'s head sha — use `get_project_status` against the PR head first to verify.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug', 'number'],
      properties: {
        project_id_or_slug: { type: 'string' },
        number: { type: 'integer', minimum: 1 },
        method: { type: 'string', enum: ['merge', 'rebase', 'rebase-merge', 'squash'], default: 'squash' },
        title: { type: 'string', description: 'Optional override of the merge-commit title.' },
        message: { type: 'string', description: 'Optional override of the merge-commit body.' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx); // merging a PR drives a build/deploy — same gate as every other mutating tool
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      await mergePullRequest({
        owner, repo,
        number: Number(args.number),
        method: args.method,
        title: typeof args.title === 'string' ? args.title : undefined,
        message: typeof args.message === 'string' ? args.message : undefined,
      });
      return { project: p.slug, merged: true, number: Number(args.number) };
    },
  },

  get_ci_logs: {
    description: 'Fetch the Gitea Actions workflow run logs for a ref (branch HEAD or commit sha). Returns per-job log text — typically Build/build, Scan/semgrep, Scan/osv-scanner — tail-capped per job so the response stays parseable. Use this after `get_project_status` reports a failure to read the actual semgrep / osv-scanner output instead of guessing. Filter to a single workflow with `workflow_name_includes` (e.g. "Scan") or a single job with `job_name_includes` (e.g. "semgrep").',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: {
        project_id_or_slug: { type: 'string' },
        ref: { type: 'string', description: 'Branch name or commit sha. Defaults to main.' },
        workflow_name_includes: { type: 'string', description: 'Case-insensitive substring filter on workflow run name.' },
        job_name_includes: { type: 'string', description: 'Case-insensitive substring filter on job name.' },
        tail_lines: { type: 'integer', minimum: 1, maximum: 2000, default: 400, description: 'Lines kept from the end of each job log.' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      if (!p.gitea_repo) throw new ToolError('this project has no Gitea repository yet.');
      const [owner, repo] = p.gitea_repo.split('/');
      const ref = (typeof args.ref === 'string' && args.ref.trim()) ? args.ref.trim() : 'main';
      let sha = ref;
      if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
        const head = await getBranchHead({ owner, repo, branch: ref });
        if (!head) throw new ToolError(`branch "${ref}" not found on ${p.gitea_repo}.`);
        sha = head.sha;
      }
      const runs = await listActionsRuns({ owner, repo, headSha: sha, limit: 20 });
      const wfFilter = typeof args.workflow_name_includes === 'string' ? args.workflow_name_includes.toLowerCase() : '';
      const jobFilter = typeof args.job_name_includes === 'string' ? args.job_name_includes.toLowerCase() : '';
      const tail = Math.max(1, Math.min(Number(args.tail_lines) || 400, 2000));
      const filteredRuns = wfFilter ? runs.filter((r) => (r.name || '').toLowerCase().includes(wfFilter)) : runs;
      if (filteredRuns.length === 0) {
        return {
          project: p.slug, ref, sha,
          runs: [],
          message: runs.length === 0
            ? 'No workflow runs found for this commit yet. CI may not have started, or this Gitea version doesn\'t expose the actions/runs API to this token.'
            : `No workflow runs matched workflow_name_includes="${args.workflow_name_includes}". Available: ${runs.map((r) => r.name).join(', ')}.`,
        };
      }
      const results: any[] = [];
      for (const run of filteredRuns) {
        const jobs = await listActionsRunJobs({ owner, repo, runId: run.id });
        const filteredJobs = jobFilter ? jobs.filter((j) => (j.name || '').toLowerCase().includes(jobFilter)) : jobs;
        const jobResults: any[] = [];
        for (const j of filteredJobs) {
          let logs = '';
          let logsError: string | undefined;
          try {
            const raw = await getActionsJobLogs({ owner, repo, jobId: j.id });
            logs = tailLines(raw, tail);
          } catch (e: any) {
            logsError = e?.message || 'failed to fetch logs';
          }
          jobResults.push({
            id: j.id, name: j.name,
            status: j.status, conclusion: j.conclusion,
            started_at: j.started_at, completed_at: j.completed_at,
            html_url: j.html_url,
            ...(logsError ? { logs_error: logsError } : { logs, logs_truncated_to_lines: tail }),
          });
        }
        results.push({
          run_id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          run_number: run.run_number,
          html_url: run.html_url,
          jobs: jobResults,
        });
      }
      return { project: p.slug, ref, sha, runs: results };
    },
  },

  get_argo_status: {
    description: 'Read the ArgoCD Application for a project. Start from the `healthy` boolean and `status_summary` — they are the overall verdict: ArgoCD can report health=Healthy while sync is Unknown and error conditions show the controller cannot even read cluster state, so `health` alone is NOT trustworthy. Also returns sync status (Synced / OutOfSync / Unknown), the revision ArgoCD currently has, last sync operation outcome, raw conditions, and any non-Healthy child resources. One call replaces a chain of Deployment / Pod / Event reads when you just want "is the deploy in good shape, and if not, why." Pass `also_sync: true` to also trigger a refresh+sync after reading the status.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: {
        project_id_or_slug: { type: 'string' },
        also_sync: { type: 'boolean', default: false, description: 'After reading status, patch the Application to trigger a fresh sync from HEAD.' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      const app = await getArgoApplication({
        name: p.slug,
        namespace: CV_PROJECTS_ARGOCD_NAMESPACE,
      }).catch(rethrowK8s);
      if (!app) {
        return {
          project: p.slug,
          found: false,
          message: `No ArgoCD Application named "${p.slug}" in ${CV_PROJECTS_ARGOCD_NAMESPACE}. The project may not have finished provisioning.`,
        };
      }
      const degraded = app.resources.filter((r) => (r.health?.status && r.health.status !== 'Healthy') || (r.status && r.status !== 'Synced'));

      // Overall verdict. ArgoCD's `health` can read Healthy while the
      // controller can't even load cluster state (sync Unknown + error
      // conditions, e.g. missing RBAC) — echoing it verbatim told agents a
      // broken deploy was fine. healthy=true requires ALL of: health Healthy,
      // sync Synced, no error conditions, no degraded child resources.
      const errorConditions = app.conditions.filter((c) => /error|warning/i.test(c.type));
      const problems: string[] = [];
      if (app.health.status !== 'Healthy') problems.push(`health is ${app.health.status}${app.health.message ? ` (${app.health.message})` : ''}`);
      if (app.sync.status !== 'Synced') problems.push(`sync is ${app.sync.status}`);
      for (const c of errorConditions) problems.push(`${c.type}: ${c.message}`);
      if (degraded.length > 0) problems.push(`${degraded.length} resource(s) not Healthy/Synced`);
      const healthy = problems.length === 0;
      const statusSummary = healthy
        ? 'Synced and healthy.'
        : `NOT healthy: ${problems.join('; ')}`;

      let syncTriggered = false;
      if (args.also_sync) {
        requireVerified(ctx);
        try {
          await triggerArgoSync({ name: p.slug, namespace: CV_PROJECTS_ARGOCD_NAMESPACE });
          syncTriggered = true;
        } catch (e: any) {
          // Surface the failure but don't make the whole call fail — the
          // status read still succeeded.
          return {
            project: p.slug,
            found: true,
            healthy,
            status_summary: statusSummary,
            sync: app.sync,
            health: app.health,
            conditions: app.conditions,
            operation_state: app.operationState,
            degraded_resources: degraded,
            reconciled_at: app.reconciledAt,
            sync_trigger_error: e?.message || 'sync trigger failed',
          };
        }
      }
      return {
        project: p.slug,
        found: true,
        healthy,
        status_summary: statusSummary,
        sync: app.sync,
        health: app.health,
        conditions: app.conditions,
        operation_state: app.operationState,
        degraded_resources: degraded,
        reconciled_at: app.reconciledAt,
        ...(args.also_sync ? { sync_triggered: syncTriggered } : {}),
      };
    },
  },

  restart_project: {
    description: 'Roll the pods in a project namespace. Deletes pods so their owning Deployment / StatefulSet ReplicaSet recreates them — this is the rollout-restart pattern that works under ArgoCD selfHeal (patching the Deployment template annotation would be reverted within seconds). Without `deployment`, every pod in the namespace is rolled. With `deployment`, only pods carrying that deployment\'s label selector (`app=<deployment>` by default) are rolled.',
    inputSchema: {
      type: 'object',
      required: ['project_id_or_slug'],
      properties: {
        project_id_or_slug: { type: 'string' },
        deployment: { type: 'string', description: 'Optional Deployment name. If set, only that workload\'s pods are rolled (uses its `.spec.selector.matchLabels`).' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      requireVerified(ctx);
      const p = await resolveOwnedProject(ctx, args.project_id_or_slug);
      if (!p) throw new ToolError('project not found or not owned by you.');
      let labelSelector: string | undefined;
      if (typeof args.deployment === 'string' && args.deployment.trim()) {
        const dep = String(args.deployment).trim();
        if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(dep)) {
          throw new ToolError('invalid deployment name; expected DNS-1123-style identifier.');
        }
        // Resolve the deployment's matchLabels so we restart the right
        // pods — a deployment named "web" may carry labels other than
        // app=web (e.g. app.kubernetes.io/name). 404 = the named
        // deployment doesn't exist; surface that clearly.
        const dRef = { apiGroup: 'apps', version: 'v1', plural: 'deployments', namespace: p.slug };
        let deployment: any;
        try {
          deployment = await k8sGetNamespaced<any>(dRef, dep);
        } catch (e) {
          rethrowK8s(e);
        }
        const matchLabels = deployment?.spec?.selector?.matchLabels || {};
        const parts = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`);
        labelSelector = parts.length > 0 ? parts.join(',') : `app=${dep}`;
      }
      const deleted = await k8sDeletePodsByLabel({
        namespace: p.slug,
        labelSelector,
      }).catch(rethrowK8s);
      return {
        project: p.slug,
        deployment: args.deployment || null,
        label_selector: labelSelector || null,
        deleted_pods: deleted.map((d) => d.name),
        count: deleted.length,
        message: deleted.length === 0
          ? 'No pods matched. Either there are no pods running yet or the deployment selector didn\'t match anything.'
          : `Deleted ${deleted.length} pod(s). Their owning ReplicaSet will spin up replacements.`,
      };
    },
  },

  kube_get: {
    description: 'Read Kubernetes objects from a project\'s namespace. Use this to debug deploys: list pods to see if they\'re running, list events to see why a pod is pending, fetch a single deployment to see its image/replicas, etc. Read-only — no patch, apply, delete, exec, or port-forward. Secrets are not readable through here (use Sealed Secrets for the supported secret flow). The namespace must equal a project slug you own.',
    inputSchema: {
      type: 'object',
      required: ['namespace', 'kind'],
      properties: {
        namespace: { type: 'string', description: 'Project namespace = slug.' },
        kind: {
          type: 'string',
          description: 'Kubernetes Kind. Supported: Pod, Deployment, StatefulSet, ReplicaSet, DaemonSet, Service, Ingress, Endpoints, ConfigMap, PersistentVolumeClaim, Event, Job, CronJob, HorizontalPodAutoscaler, NetworkPolicy, SealedSecret.',
        },
        name: { type: 'string', description: 'Optional. If set, returns the full object; if omitted, returns a summarised list.' },
        label_selector: { type: 'string', description: 'Optional label selector (e.g. "app=foo").' },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const p = await resolveOwnedProject(ctx, args.namespace);
      if (!p) throw new ToolError(`namespace "${args.namespace}" doesn't match a project you own.`);
      const ref = kindToRef(String(args.kind || ''), p.slug);
      if (!ref) throw new ToolError(`unsupported kind "${args.kind}". See the tool description for the supported list.`);

      if (args.name) {
        const name = String(args.name);
        // DNS-1123 subdomain charset. Rejects path separators, dots
        // outside DNS labels, percent-encoded escapes, and anything else
        // that could confuse the k8s API path builder.
        if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(name)) {
          throw new ToolError('invalid resource name; expected DNS-1123-style identifier.');
        }
        const obj = await k8sGetNamespaced<any>(ref, name).catch(rethrowK8s);
        return {
          namespace: p.slug,
          kind: args.kind,
          name,
          resource: stripManagedFields(obj),
        };
      }
      const list = await k8sListNamespaced<any>(ref, {
        labelSelector: typeof args.label_selector === 'string' ? args.label_selector : undefined,
        limit: 100,
      }).catch(rethrowK8s);
      const items = Array.isArray(list?.items) ? list.items : [];
      return {
        namespace: p.slug,
        kind: args.kind,
        count: items.length,
        items: items.map((it: any) => summarize(args.kind, it)),
      };
    },
  },

  kube_logs: {
    description: 'Fetch the most recent log lines from a pod in a project namespace. Tail size defaults to 200 lines, max 5000. Use `previous: true` to get logs from the prior crashed container. Namespace must equal a project slug you own.',
    inputSchema: {
      type: 'object',
      required: ['namespace', 'pod'],
      properties: {
        namespace: { type: 'string' },
        pod: { type: 'string', description: 'Pod name. List with kube_get if you don\'t know it.' },
        container: { type: 'string', description: 'Container name; required only if the pod has more than one.' },
        tail_lines: { type: 'integer', minimum: 1, maximum: 5000, default: 200 },
        previous: { type: 'boolean', default: false, description: 'Logs from the previous, crashed container.' },
        timestamps: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const p = await resolveOwnedProject(ctx, args.namespace);
      if (!p) throw new ToolError(`namespace "${args.namespace}" doesn't match a project you own.`);
      const pod = String(args.pod || '');
      if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(pod)) {
        throw new ToolError('invalid pod name; expected DNS-1123-style identifier.');
      }
      const container = typeof args.container === 'string' ? args.container : undefined;
      if (container !== undefined && !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(container)) {
        throw new ToolError('invalid container name; expected DNS-1123-style identifier.');
      }
      const logs = await k8sPodLogs({
        namespace: p.slug,
        pod,
        container,
        tailLines: typeof args.tail_lines === 'number' ? args.tail_lines : 200,
        previous: !!args.previous,
        timestamps: !!args.timestamps,
      }).catch(rethrowK8s);
      return {
        namespace: p.slug,
        pod: args.pod,
        container: args.container,
        tail_lines: args.tail_lines ?? 200,
        logs,
      };
    },
  },

  how_corpo_valley_works: {
    description: 'Returns a markdown explainer of how the Corpo Valley platform fits together. Call this at the start of a new session to bootstrap your mental model. Omit `topic` for the overview; pass a specific topic for detail.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: listDocsTopics(), description: 'Which doc to fetch. Default: overview.' },
      },
      additionalProperties: false,
    },
    async handler(_ctx, args) {
      const { topic, markdown } = getDocsTopic(args?.topic as DocsTopic | undefined);
      return { topic, markdown, available_topics: listDocsTopics() };
    },
  },
};

class ToolError extends Error {}

// Tail the last N lines of a (possibly multi-MB) log blob. Used by
// get_ci_logs so a noisy build doesn't blow the JSON-RPC response;
// failures are always at the tail of the stream anyway.
function tailLines(s: string, n: number): string {
  if (!s) return '';
  const lines = s.split(/\r?\n/);
  if (lines.length <= n) return s;
  return lines.slice(-n).join('\n');
}

// ── kube_get helpers ──────────────────────────────────────────────────

// Map user-friendly kind names to (apiGroup, version, plural). Only
// kinds the cv-projects-reader ClusterRole grants reads on.
const KIND_MAP: Record<string, { apiGroup: string; version: string; plural: string }> = {
  pod: { apiGroup: '', version: 'v1', plural: 'pods' },
  service: { apiGroup: '', version: 'v1', plural: 'services' },
  endpoints: { apiGroup: '', version: 'v1', plural: 'endpoints' },
  configmap: { apiGroup: '', version: 'v1', plural: 'configmaps' },
  persistentvolumeclaim: { apiGroup: '', version: 'v1', plural: 'persistentvolumeclaims' },
  pvc: { apiGroup: '', version: 'v1', plural: 'persistentvolumeclaims' },
  event: { apiGroup: '', version: 'v1', plural: 'events' },
  deployment: { apiGroup: 'apps', version: 'v1', plural: 'deployments' },
  statefulset: { apiGroup: 'apps', version: 'v1', plural: 'statefulsets' },
  replicaset: { apiGroup: 'apps', version: 'v1', plural: 'replicasets' },
  daemonset: { apiGroup: 'apps', version: 'v1', plural: 'daemonsets' },
  ingress: { apiGroup: 'networking.k8s.io', version: 'v1', plural: 'ingresses' },
  networkpolicy: { apiGroup: 'networking.k8s.io', version: 'v1', plural: 'networkpolicies' },
  job: { apiGroup: 'batch', version: 'v1', plural: 'jobs' },
  cronjob: { apiGroup: 'batch', version: 'v1', plural: 'cronjobs' },
  horizontalpodautoscaler: { apiGroup: 'autoscaling', version: 'v2', plural: 'horizontalpodautoscalers' },
  hpa: { apiGroup: 'autoscaling', version: 'v2', plural: 'horizontalpodautoscalers' },
  sealedsecret: { apiGroup: 'bitnami.com', version: 'v1alpha1', plural: 'sealedsecrets' },
};

function kindToRef(kind: string, namespace: string): { apiGroup: string; version: string; plural: string; namespace: string } | null {
  const k = kind.toLowerCase().replace(/s$/, ''); // accept "pods" or "Pod"
  const ref = KIND_MAP[k] || KIND_MAP[kind.toLowerCase()];
  if (!ref) return null;
  return { ...ref, namespace };
}

// Strip the noisy managedFields server-side metadata so the agent gets
// the meat of the resource without ~30% of the bytes being kubectl history.
function stripManagedFields<T extends { metadata?: any }>(obj: T): T {
  if (obj?.metadata?.managedFields) {
    const { managedFields, ...rest } = obj.metadata;
    return { ...obj, metadata: rest };
  }
  return obj;
}

function summarize(kind: string, it: any): Record<string, any> {
  const name = it?.metadata?.name;
  const created = it?.metadata?.creationTimestamp;
  const k = String(kind).toLowerCase().replace(/s$/, '');
  switch (k) {
    case 'pod': {
      const cs = (it.status?.containerStatuses || []) as Array<any>;
      const ready = `${cs.filter((c) => c.ready).length}/${cs.length || (it.spec?.containers?.length || 0)}`;
      const restarts = cs.reduce((acc, c) => acc + (c.restartCount || 0), 0);
      return { name, phase: it.status?.phase, ready, restarts, node: it.spec?.nodeName, created, reason: it.status?.reason || cs.find((c) => !c.ready)?.state?.waiting?.reason };
    }
    case 'deployment':
      return { name, replicas: `${it.status?.readyReplicas || 0}/${it.spec?.replicas ?? 0}`, available: it.status?.availableReplicas || 0, image: it.spec?.template?.spec?.containers?.[0]?.image, created };
    case 'service':
      return { name, type: it.spec?.type, cluster_ip: it.spec?.clusterIP, ports: (it.spec?.ports || []).map((p: any) => `${p.port}/${p.protocol || 'TCP'}→${p.targetPort}`).join(','), created };
    case 'ingress':
      return { name, hosts: (it.spec?.rules || []).map((r: any) => r.host).filter(Boolean), class: it.spec?.ingressClassName, created };
    case 'event':
      return { type: it.type, reason: it.reason, object: `${it.involvedObject?.kind}/${it.involvedObject?.name}`, message: (it.message || '').slice(0, 200), count: it.count, last: it.lastTimestamp || it.eventTime };
    case 'configmap':
      return { name, keys: Object.keys(it.data || {}), created };
    case 'sealedsecret':
      return { name, keys: Object.keys((it.spec || {}).encryptedData || {}), created };
    case 'replicaset':
    case 'statefulset':
    case 'daemonset':
      return { name, replicas: `${it.status?.readyReplicas || 0}/${it.spec?.replicas ?? 0}`, created };
    case 'job':
      return { name, succeeded: it.status?.succeeded || 0, failed: it.status?.failed || 0, active: it.status?.active || 0, created };
    default:
      return { name, created };
  }
}

function rethrowK8s(err: unknown): never {
  if (err && typeof err === 'object' && 'status' in (err as any) && 'body' in (err as any)) {
    const e = err as { status: number; body: any };
    if (e.status === 404) throw new ToolError(`not found (k8s API returned 404).`);
    if (e.status === 403) throw new ToolError(`forbidden (k8s API returned 403); the platform reader role may need updating.`);
    throw new ToolError(`k8s API ${e.status}: ${typeof e.body === 'string' ? e.body.slice(0, 200) : (e.body?.message || JSON.stringify(e.body).slice(0, 200))}`);
  }
  throw err;
}

function toToolProject(p: Project) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    url: `https://${p.slug}.${PROJECTS_DOMAIN}`,
    service_access: p.service_access,
    repo_access: p.repo_access,
    created_at: p.created_at,
    gitea_repo: p.gitea_repo,
    gitea_url: p.gitea_repo ? `${GITEA_PUBLIC_URL}/${p.gitea_repo}` : null,
  };
}

// Resolve id-or-slug to a Project the caller owns. Returns null when not
// found or not owned.
async function resolveOwnedProject(ctx: McpContext, idOrSlug: string): Promise<Project | null> {
  if (!idOrSlug) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)) {
    const p = await getProjectById(idOrSlug);
    return p && p.owner_id === ctx.userId ? p : null;
  }
  // Slug lookup: list user's projects and match (cheaper than a new SQL
  // for the typical case of a few projects per user).
  const rows = await listProjectsByOwner(ctx.userId);
  return rows.find((r) => r.slug === idOrSlug) || null;
}

// ── JSON-RPC dispatch ──────────────────────────────────────────────────────

async function handleRpc(req: JsonRpcRequest, ctx: McpContext): Promise<JsonRpcResponse | null> {
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return err(req.id, E_INVALID_REQUEST, 'invalid JSON-RPC request');
  }

  const isNotification = req.id === undefined;

  try {
    switch (req.method) {
      case 'initialize': {
        const result = {
          protocolVersion: PROTOCOL_VERSION,
          // We declare `listChanged: true` and back it up by serving an
          // SSE channel at GET /mcp that immediately pushes
          // `notifications/tools/list_changed` on connect. After a
          // portal upgrade adds tools, clients that hold the SSE channel
          // open see the notification on reconnect and refresh their
          // tools/list — no editor restart needed.
          capabilities: { tools: { listChanged: true } },
          serverInfo: SERVER_INFO,
          instructions: 'Call `how_corpo_valley_works` first to learn the platform. Use `list_projects` to see what the user has, `create_project` to plant a new one, and `get_gitea_credentials` to get a ready-to-use clone URL. Platform source & issues: https://github.com/corpo-valley/corpo-valley-main',
        };
        return isNotification ? null : ok(req.id, result);
      }
      case 'notifications/initialized':
      case 'initialized':
        return null;
      case 'ping':
        return isNotification ? null : ok(req.id, {});
      case 'tools/list': {
        const list = Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return ok(req.id, { tools: list });
      }
      case 'tools/call': {
        const params = (req.params || {}) as { name?: string; arguments?: any };
        const tool = params.name ? tools[params.name] : undefined;
        if (!tool) return err(req.id, E_METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
        try {
          const result = await tool.handler(ctx, params.arguments || {});
          // MCP tool-call result is a list of content blocks. For
          // structured returns we hand the agent a JSON-stringified text
          // block — Claude / Cursor / Codex all parse it back happily,
          // and the text representation keeps payloads inspectable.
          return ok(req.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
            structuredContent: result,
          });
        } catch (e: any) {
          // ToolError messages are intentionally user-facing. Any OTHER exception
          // (e.g. GiteaApiError / k8s errors that embed raw upstream response
          // bodies) is logged server-side and returned to the caller as a
          // generic message, so platform-internal detail isn't reflected to a
          // tenant for reconnaissance.
          let msg: string;
          if (e instanceof ToolError) {
            msg = e.message;
          } else {
            console.error(`[mcp] tool ${params.name} failed:`, e?.message || e);
            msg = 'internal error running tool';
          }
          return ok(req.id, {
            content: [{ type: 'text', text: msg }],
            isError: true,
          });
        }
      }
      default:
        if (isNotification) return null;
        return err(req.id, E_METHOD_NOT_FOUND, `method not implemented: ${req.method}`);
    }
  } catch (e: any) {
    if (isNotification) return null;
    return err(req.id, E_INTERNAL, e?.message || 'internal error');
  }
}

export async function dispatchJsonRpc(raw: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  if (!raw || typeof raw !== 'object') {
    return err(null, E_PARSE, 'request body must be a JSON object');
  }
  return handleRpc(raw as JsonRpcRequest, ctx);
}

export const __mcpInternals = { tools, PROTOCOL_VERSION, SERVER_INFO };
