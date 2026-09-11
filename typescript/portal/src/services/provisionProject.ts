// Single source of truth for provisioning a project's external resources.
//
// Both the web dashboard (POST /projects) and the MCP `create_project` tool
// call this after inserting the project row, so the two paths can't drift.
// Order matters: the platform seals the namespace (PSA labels + default-deny
// egress + quota + limits) BEFORE anything tenant-controlled exists, then
// provisions the repo, database, manifests, and ArgoCD Application.
//
// Every step is best-effort and logged: a downstream hiccup (Gitea/k8s) must
// not roll back the project row. But "best-effort" is not "pretend it worked":
// the ArgoCD Application is only created — and the project only marked `ready`
// — when the namespace was sealed AND the repo was generated AND its k8s/
// manifests were rendered. Anything less flips the project to `failed`.
// NOTE: there is NO background reconciler today — a `failed` project stays
// failed until it's deleted and recreated (the row is kept so a future
// reconciler could retry from it).

import type { Project, ProjectStatus } from './projects';
import {
  claimOrGetPostgresPassword, decodePostgresPassword,
  claimOrGetGarageCredentials, decodeGarageCredentials,
  setGiteaRepo, setPinTokenHash, setProjectStatus,
} from './projects';
import { syncRepoAccess } from './repo-access';
import { type Capabilities, requiresPostgres, TEMPLATE_GITEA_OWNER, TEMPLATE_GITEA_REPO } from './templates';
import { enablePostgres, generatePostgresPassword } from './postgres';
import { enableGarage, generateGarageCredentials } from './garage';
import { composeProjectManifests } from './manifests';
import {
  ensureUser, generateFromTemplate, setBranchProtection, setActionsSecret, giteaEnabled,
} from './gitea';
import { generatePinToken, hashPinToken } from './pin-token';
import { applyNamespaceBaseline, applyMcpGateway, createArgoApplication, k8sEnabled } from './k8s';

const GITEA_INTERNAL_URL = process.env.GITEA_INTERNAL_URL || 'http://gitea.cv-gitea.svc.cluster.local';
const CV_PROJECTS_ARGOCD_NAMESPACE = process.env.CV_PROJECTS_ARGOCD_NAMESPACE || 'cv-projects-argocd';
const CV_PROJECTS_APPPROJECT = process.env.CV_PROJECTS_APPPROJECT || 'projects';

export interface ProvisionContext {
  // Gitea/owner username (session.preferredUsername or MCP ctx.preferredUsername).
  ownerUsername?: string;
  email?: string;
  // Log prefix so dashboard vs MCP failures are distinguishable.
  logTag?: string;
}

export interface ProvisionResult {
  namespaceSealed: boolean;
  // The project repo was generated from the template (and recorded on the row).
  repoGenerated: boolean;
  // composeProjectManifests rewrote k8s/{deployment,service,ingress}.yaml for
  // the chosen capabilities. Without this the repo still holds the template's
  // un-rendered {{SLUG}} reference copies — not deployable.
  manifestsRendered: boolean;
  postgresEnabled: boolean;
  storageEnabled: boolean;
  argoRegistered: boolean;
  // The lifecycle status this run wrote to the project row: 'ready' only on
  // the full happy path, 'failed' otherwise. Callers (dashboard initializing
  // screen, MCP create_project) surface it to the user.
  status: ProjectStatus;
}

export async function provisionProject(
  project: Project,
  caps: Capabilities,
  ctx: ProvisionContext,
): Promise<ProvisionResult> {
  const tag = ctx.logTag || 'provision';
  const slug = project.slug;
  const result: ProvisionResult = {
    namespaceSealed: false, repoGenerated: false, manifestsRendered: false,
    postgresEnabled: false, storageEnabled: false, argoRegistered: false,
    status: 'failed',
  };

  // 1. Seal the namespace FIRST — PSA labels + default-deny egress + quota +
  //    limits — so the box is locked before any tenant workload can land.
  try {
    await applyNamespaceBaseline(slug);
    result.namespaceSealed = true;
  } catch (e: any) {
    console.error(`[${tag}] namespace baseline failed for ${slug}:`, e?.message);
  }

  // 2. Gitea repo + database + manifests + branch protection + pin token.
  if (giteaEnabled() && ctx.ownerUsername) {
    const ownerUsername = ctx.ownerUsername;
    try {
      await ensureUser({ username: ownerUsername, email: ctx.email || `${ownerUsername}@unknown` });
      // The repo is ALWAYS created private. Project repos live under the owner's
      // personal Gitea account, which has no org-internal visibility tier, so a
      // non-private repo would be anonymously cloneable from the internet
      // (finding F1). Member read/write access is granted as collaborators by
      // syncRepoAccess below, never by flipping the repo public.
      const fullName = await generateFromTemplate({
        ownerUsername, name: slug,
        private: true, description: project.name,
        templateOwner: TEMPLATE_GITEA_OWNER, templateRepo: TEMPLATE_GITEA_REPO,
      });
      await setGiteaRepo(project.id, fullName);
      result.repoGenerated = true;

      // Converge collaborators (default-`write` fan-out for `internal`
      // projects; explicit grants don't exist yet at create time).
      try { await syncRepoAccess({ ...project, gitea_repo: fullName }); }
      catch (e: any) { console.error(`[${tag}] repo access converge failed for ${slug}:`, e?.message); }

      // Postgres BEFORE manifests so the Secret exists before ArgoCD first
      // syncs the database container.
      if (requiresPostgres(caps)) {
        try {
          const existingPw = decodePostgresPassword(project);
          const { password } = existingPw
            ? { password: existingPw }
            : await claimOrGetPostgresPassword(project.id, generatePostgresPassword());
          await enablePostgres({ owner: ownerUsername, repo: slug, slug, password });
          result.postgresEnabled = true;
        } catch (e: any) {
          console.error(`[${tag}] auto-enable postgres failed for ${slug}:`, e?.message);
        }
      }

      // Garage BEFORE manifests too, for the same reason — the storage
      // container's Secret must exist before ArgoCD first syncs it.
      if (caps.storage) {
        try {
          const existing = decodeGarageCredentials(project);
          const { creds } = existing
            ? { creds: existing }
            : await claimOrGetGarageCredentials(project.id, generateGarageCredentials());
          await enableGarage({ owner: ownerUsername, repo: slug, slug, creds });
          result.storageEnabled = true;
        } catch (e: any) {
          console.error(`[${tag}] auto-enable garage failed for ${slug}:`, e?.message);
        }
      }

      try {
        await composeProjectManifests({ owner: ownerUsername, repo: slug, slug, caps });
        result.manifestsRendered = true;
      } catch (e: any) { console.error(`[${tag}] manifest generation failed for ${slug}:`, e?.message); }

      try { await setBranchProtection({ owner: ownerUsername, repo: slug }); }
      catch (e: any) { console.error(`[${tag}] branch protection failed for ${slug}:`, e?.message); }

      try {
        const pinToken = generatePinToken();
        await setPinTokenHash(project.id, hashPinToken(pinToken));
        await setActionsSecret({ owner: ownerUsername, repo: slug, name: 'CV_PIN_TOKEN', data: pinToken });
      } catch (e: any) { console.error(`[${tag}] CV_PIN_TOKEN provisioning failed for ${slug}:`, e?.message); }
    } catch (e: any) {
      console.error(`[${tag}] Gitea provisioning failed for ${slug}:`, e?.message);
    }
  }

  // 2b. If the project has the MCP capability, route /mcp to the shared
  //     OAuth gateway (portal-applied Ingress + ExternalName, bypassing the
  //     cookie gate so MCP clients can authenticate with a bearer).
  if (result.namespaceSealed && caps.mcp) {
    try { await applyMcpGateway(slug); }
    catch (e: any) { console.error(`[${tag}] mcp gateway wiring failed for ${slug}:`, e?.message); }
  }

  // 3. Register the ArgoCD Application so the projects ArgoCD deploys the repo
  //    into the (now sealed) namespace. FAIL CLOSED on two conditions:
  //    - never deploy tenant code into an unsealed namespace;
  //    - never point ArgoCD at a repo that wasn't generated, or whose k8s/
  //      manifests weren't rendered (the repo would be missing, or still carry
  //      the template's un-rendered {{SLUG}} reference copies).
  //    Either way the project never reached a deployable state: mark it
  //    `failed` and surface that, rather than leaving it stuck `provisioning`
  //    (which would poll the initializing screen forever) or lying with
  //    `ready`. There is NO reconciler that retries a failed project today —
  //    the row is kept so one could be built later.
  const markFailed = async () => {
    result.status = 'failed';
    try { await setProjectStatus(project.id, 'failed'); }
    catch (e: any) { console.error(`[${tag}] could not mark ${slug} failed:`, e?.message); }
  };
  // Repo/manifest success is only required where Gitea provisioning was
  // actually attempted (Gitea wired up + an owner username to create under);
  // a dev deployment without Gitea behaves as before.
  const giteaAttempted = giteaEnabled() && !!ctx.ownerUsername;
  if (!result.namespaceSealed || (giteaAttempted && (!result.repoGenerated || !result.manifestsRendered))) {
    const why = !result.namespaceSealed ? 'namespace not sealed'
      : !result.repoGenerated ? 'repo generation failed'
      : 'manifest rendering failed';
    console.error(`[${tag}] skipping ArgoCD registration for ${slug}: ${why} — marking project failed`);
    await markFailed();
    return result;
  }
  if (k8sEnabled() && ctx.ownerUsername) {
    try {
      await createArgoApplication({
        name: slug,
        namespace: CV_PROJECTS_ARGOCD_NAMESPACE,
        project: CV_PROJECTS_APPPROJECT,
        destNamespace: slug,
        repoUrl: `${GITEA_INTERNAL_URL}/${ctx.ownerUsername}/${slug}.git`,
        path: 'k8s', revision: 'main',
      });
      result.argoRegistered = true;
    } catch (e: any) {
      console.error(`[${tag}] argo register failed for ${slug} — marking project failed:`, e?.message);
      // Without the Application nothing will ever deploy this repo; that's not
      // `ready` either.
      await markFailed();
      return result;
    }
  }

  // Provisioning reached the end of the happy path. Flip the project to
  // `ready` so the portal's initializing screen redirects to the detail page
  // and the MCP path (which awaits this) returns a ready project. Best-effort
  // and logged — a DB hiccup here shouldn't change provisionProject's contract.
  result.status = 'ready';
  try { await setProjectStatus(project.id, 'ready'); }
  catch (e: any) { console.error(`[${tag}] could not mark ${slug} ready:`, e?.message); }

  return result;
}
