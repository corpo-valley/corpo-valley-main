// Project cascade-delete orchestrator. Tears down every external resource
// attached to a project — Gitea repo, ArgoCD Application in the projects
// instance, and the destination Kubernetes namespace (which cascades all
// pods, PVCs, secrets, deployments, etc.). The portal DB row is dropped by
// the caller AFTER this returns, so a partial failure surfaces as a
// PurgeResult the caller can log without losing the row.
//
// Best-effort: every step is wrapped so a Gitea outage doesn't block the
// k8s cleanup, and vice versa. Mirrors the inverse of the create-project
// orchestration in routes/dashboard.ts / services/mcp.ts.

import { deleteRepo, giteaEnabled } from './gitea';
import { deleteArgoApplication, deleteNamespace, k8sEnabled } from './k8s';
import type { Project } from './projects';

const CV_PROJECTS_ARGOCD_NAMESPACE = process.env.CV_PROJECTS_ARGOCD_NAMESPACE || 'cv-projects-argocd';

export interface PurgeOptions {
  // Skip the Gitea repo delete (default false — repo IS deleted by default).
  keepRepo?: boolean;
  // Skip the k8s namespace delete (default false — namespace IS deleted by default).
  keepNamespace?: boolean;
}

export interface PurgeResult {
  gitea_repo: 'deleted' | 'skipped' | 'failed' | 'not_applicable';
  argo_application: 'deleted' | 'skipped' | 'failed' | 'not_applicable';
  namespace: 'deleted' | 'skipped' | 'failed' | 'not_applicable';
  errors: string[];
}

export async function purgeProjectResources(
  project: Project,
  opts: PurgeOptions = {}
): Promise<PurgeResult> {
  const result: PurgeResult = {
    gitea_repo: 'not_applicable',
    argo_application: 'not_applicable',
    namespace: 'not_applicable',
    errors: [],
  };

  // Step 1 — ArgoCD Application. The finalizer cascades workload pruning
  // first; deleting the namespace before this would race with the
  // controller, leave it stuck terminating, and the auto-sync would try to
  // recreate it. So Application first.
  if (k8sEnabled()) {
    try {
      await deleteArgoApplication({
        name: project.slug,
        namespace: CV_PROJECTS_ARGOCD_NAMESPACE,
      });
      result.argo_application = 'deleted';
    } catch (err: any) {
      result.argo_application = 'failed';
      result.errors.push(`argo_application: ${err?.message || 'unknown'}`);
    }
  }

  // Step 2 — destination namespace. With the Application gone (or its
  // finalizer holding it until the controller prunes), wipe the namespace
  // so any user-applied stragglers, sealed-secret materialised Secrets,
  // and PVCs go too.
  if (opts.keepNamespace) {
    result.namespace = 'skipped';
  } else if (k8sEnabled()) {
    try {
      await deleteNamespace(project.slug);
      result.namespace = 'deleted';
    } catch (err: any) {
      result.namespace = 'failed';
      result.errors.push(`namespace: ${err?.message || 'unknown'}`);
    }
  }

  // Step 3 — Gitea repo. Last because losing the repo without losing the
  // live workload is the worst order — the user would see a deployed app
  // with no source. Doing it last means a partial failure leaves the user
  // with the repo (recoverable code) rather than orphan cluster state.
  if (opts.keepRepo) {
    result.gitea_repo = 'skipped';
  } else if (giteaEnabled() && project.gitea_repo) {
    const [owner, repo] = project.gitea_repo.split('/');
    if (owner && repo) {
      try {
        await deleteRepo({ owner, repo });
        result.gitea_repo = 'deleted';
      } catch (err: any) {
        result.gitea_repo = 'failed';
        result.errors.push(`gitea_repo: ${err?.message || 'unknown'}`);
      }
    }
  }

  return result;
}
