// Single source of truth for provisioning a project's external resources.
//
// Both the web dashboard (POST /projects) and the MCP `create_project` tool
// call this after inserting the project row, so the two paths can't drift.
// Order matters: the platform seals the namespace (PSA labels + default-deny
// egress + quota + limits) BEFORE anything tenant-controlled exists, then
// provisions the repo, database, manifests, and ArgoCD Application.
//
// Every step is best-effort and logged: a downstream hiccup (Gitea/k8s) must
// not roll back the project row, which is the source of truth a reconciler can
// retry from later.

import type { Project } from './projects';
import { claimOrGetPostgresPassword, decodePostgresPassword, setGiteaRepo, setPinTokenHash } from './projects';
import { type Capabilities, requiresPostgres, TEMPLATE_GITEA_OWNER, TEMPLATE_GITEA_REPO } from './templates';
import { enablePostgres, generatePostgresPassword } from './postgres';
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
  postgresEnabled: boolean;
  argoRegistered: boolean;
}

export async function provisionProject(
  project: Project,
  caps: Capabilities,
  ctx: ProvisionContext,
): Promise<ProvisionResult> {
  const tag = ctx.logTag || 'provision';
  const slug = project.slug;
  const result: ProvisionResult = { namespaceSealed: false, postgresEnabled: false, argoRegistered: false };

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
      const fullName = await generateFromTemplate({
        ownerUsername, name: slug,
        private: project.service_access === 'private', description: project.name,
        templateOwner: TEMPLATE_GITEA_OWNER, templateRepo: TEMPLATE_GITEA_REPO,
      });
      await setGiteaRepo(project.id, fullName);

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

      try { await composeProjectManifests({ owner: ownerUsername, repo: slug, slug, caps }); }
      catch (e: any) { console.error(`[${tag}] manifest generation failed for ${slug}:`, e?.message); }

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
  //    into the (now sealed) namespace. FAIL CLOSED: never deploy tenant code
  //    into an unsealed namespace. If the seal failed, skip registration — the
  //    project row remains and a retry/reconcile can complete it later.
  if (!result.namespaceSealed) {
    console.error(`[${tag}] skipping ArgoCD registration for ${slug}: namespace not sealed`);
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
      console.error(`[${tag}] argo register failed for ${slug}:`, e?.message);
    }
  }

  return result;
}
