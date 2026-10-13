// Admin ownership transfer: move a project (and its Gitea repo, grants and
// ArgoCD source) from its current owner to another human member.
//
// Ordering is the whole point of this module. The Gitea repo transfer is the
// one step that cannot be rolled back by the portal, so the portal row is
// updated the moment it succeeds; every later step is best-effort and reports
// what to do by hand if it fails. Nothing before the Gitea transfer mutates
// state, so a validation or provisioning failure leaves the project untouched.
//
//   1. validate (planOwnershipTransfer)        — pure, unit-tested
//   2. provision the target in Gitea            — idempotent
//   3. Gitea: POST /repos/{old}/{slug}/transfer — verified by a GET
//   4. DB: owner_id + gitea_repo                — IMMEDIATELY after 3
//   5. grants: drop the new owner's row, optionally keep the previous owner
//   6. Gitea collaborators re-converge          — syncRepoAccess
//   7. ArgoCD Application spec.source.repoURL   — repoint to the new clone URL
//   8. cv_resource_audit row (scope = slug)
//
// The executor takes its collaborators as an injectable `deps` object so the
// ordering/partial-failure contract is testable without a cluster; production
// callers use `defaultTransferDeps`.

import type { Identity } from '@ory/client';
import { Project, GrantLevel, setProjectOwner } from './projects';
import { getIdentity } from './kratos-admin';
import { ensureProvisioned } from './provisioning';
import { giteaUsernameForIdentity, syncRepoAccess } from './repo-access';
import { getGiteaUser, transferRepo, giteaEnabled } from './gitea';
import { findGrantBySubject, deleteGrant, setGrantFacet, GrantFacet, SubjectType } from './access';
import { patchArgoApplicationRepoUrl, k8sEnabled } from './k8s';
import { recordResourceAudit } from './tenant-defaults';
import { CV_REGISTRY } from './platform-config';

const GITEA_INTERNAL_URL = process.env.GITEA_INTERNAL_URL || 'http://gitea.cv-gitea.svc.cluster.local';
export const CV_PROJECTS_ARGOCD_NAMESPACE = process.env.CV_PROJECTS_ARGOCD_NAMESPACE || 'cv-projects-argocd';

export const TRANSFER_AUDIT_ACTION = 'transfer-ownership';
const LOG = '[admin] transfer-ownership';

// The slice of a Kratos identity the validator needs, so tests don't have to
// build full Identity objects.
export interface TransferTarget {
  id: string;
  email: string | null;
  username: string | null;
  isBot: boolean;
  state: string | null;
}

export function describeIdentity(identity: Identity): TransferTarget {
  const traits = (identity.traits ?? {}) as Record<string, any>;
  const meta = (identity.metadata_public ?? {}) as Record<string, any>;
  return {
    id: identity.id,
    email: typeof traits.email === 'string' && traits.email ? traits.email : null,
    username: typeof traits.preferred_username === 'string' && traits.preferred_username
      ? traits.preferred_username : null,
    isBot: meta.type === 'bot',
    state: typeof identity.state === 'string' ? identity.state : null,
  };
}

export type TransferPlan = { ok: true } | { ok: false; reason: string };

// Pure pre-flight. Fails closed on anything that would make the transfer
// meaningless or leave the project unreachable for the new owner.
export function planOwnershipTransfer(
  project: Pick<Project, 'slug' | 'owner_id' | 'status' | 'gitea_repo'>,
  target: TransferTarget,
  confirmSlug: string,
): TransferPlan {
  if (confirmSlug.trim() !== project.slug) {
    return { ok: false, reason: `Type the project slug (${project.slug}) to confirm the transfer.` };
  }
  if (project.status !== 'ready') {
    return { ok: false, reason: `Only ready projects can be transferred — this one is "${project.status}".` };
  }
  if (!project.gitea_repo || !project.gitea_repo.includes('/')) {
    return { ok: false, reason: 'This project has no Gitea repository recorded, so there is nothing to transfer.' };
  }
  if (target.isBot) {
    return { ok: false, reason: 'Bot identities cannot own projects — pick the human member.' };
  }
  if (target.state && target.state !== 'active') {
    return { ok: false, reason: `That member's account is ${target.state}; reactivate it before transferring.` };
  }
  if (!target.email) {
    return { ok: false, reason: 'That member has no email on file, so a Gitea account cannot be provisioned for them.' };
  }
  if (target.id === project.owner_id) {
    return { ok: false, reason: 'That member already owns this project.' };
  }
  return { ok: true };
}

// The cv_resource_audit change blob written on every state-changing transfer.
export interface TransferAuditChange extends Record<string, unknown> {
  action: typeof TRANSFER_AUDIT_ACTION;
  fromOwnerId: string;
  toOwnerId: string;
  fromEmail: string;
  toEmail: string;
  giteaFrom: string;
  giteaTo: string;
  keptPreviousOwnerAsAdmin: boolean;
  // Steps after the Gitea transfer that failed and need manual follow-up.
  partial?: string[];
}

// Human summary for the admin audit tables (routes/admin.ts auditSummary).
export function summarizeTransferAudit(change: Record<string, unknown>): string {
  const s = (k: string) => (typeof change[k] === 'string' ? (change[k] as string) : '?');
  let out = `ownership transferred ${s('fromEmail')} → ${s('toEmail')} (Gitea ${s('giteaFrom')} → ${s('giteaTo')})`;
  out += change.keptPreviousOwnerAsAdmin ? '; previous owner kept as admin' : '; previous owner access removed';
  const partial = Array.isArray(change.partial) ? change.partial.filter((p) => typeof p === 'string') : [];
  if (partial.length) out += `; ${partial.length} step(s) need attention: ${partial.join(' | ')}`;
  return out;
}

export interface TransferInput {
  project: Project;
  target: Identity;
  actorEmail: string;
  keepPreviousOwnerAsAdmin: boolean;
  confirmSlug: string;
}

export interface TransferOutcome {
  ok: boolean;
  // True once the Gitea repo has moved — the project is no longer in its
  // pre-transfer state even if later steps failed.
  changed: boolean;
  message: string;
  details: string[];
  project: Project;
}

export interface TransferDeps {
  giteaEnabled(): boolean;
  k8sEnabled(): boolean;
  getIdentity(id: string): Promise<Identity>;
  ensureProvisioned(identity: Identity): Promise<void>;
  giteaUsernameFor(identity: Identity): string | null;
  getGiteaUser(username: string): Promise<{ login: string; email?: string } | null>;
  transferRepo(opts: { owner: string; repo: string; newOwner: string }): Promise<{ fullName: string }>;
  setProjectOwner(id: string, ownerId: string, giteaRepo: string): Promise<void>;
  findGrantBySubject(projectId: string, subjectType: SubjectType, subjectId: string): Promise<{ id: string } | null>;
  deleteGrant(id: string): Promise<void>;
  setGrantFacet(input: {
    projectId: string; subjectType: SubjectType; subjectId: string;
    subjectName?: string | null; giteaUsername?: string | null;
    facet: GrantFacet; level: GrantLevel;
  }): Promise<unknown>;
  syncRepoAccess(project: Project): Promise<{ skipped: boolean; added: string[]; removed: string[]; errors: string[] }>;
  patchArgoRepoUrl(opts: { name: string; namespace: string; repoUrl: string }): Promise<void>;
  recordAudit(actorEmail: string, scope: string, change: Record<string, unknown>): Promise<void>;
  log(message: string): void;
  error(message: string): void;
}

export const defaultTransferDeps: TransferDeps = {
  giteaEnabled, k8sEnabled, getIdentity, ensureProvisioned,
  giteaUsernameFor: giteaUsernameForIdentity,
  getGiteaUser, transferRepo, setProjectOwner,
  findGrantBySubject, deleteGrant, setGrantFacet, syncRepoAccess,
  patchArgoRepoUrl: patchArgoApplicationRepoUrl,
  recordAudit: recordResourceAudit,
  log: (m) => console.log(`${LOG} ${m}`),
  error: (m) => console.error(`${LOG} ${m}`),
};

export function argoRepoUrlFor(giteaRepo: string): string {
  return `${GITEA_INTERNAL_URL}/${giteaRepo}.git`;
}

export async function executeOwnershipTransfer(
  input: TransferInput, deps: TransferDeps = defaultTransferDeps,
): Promise<TransferOutcome> {
  const { project, target } = input;
  const slug = project.slug;
  const targetInfo = describeIdentity(target);
  const fail = (message: string, details: string[] = []): TransferOutcome =>
    ({ ok: false, changed: false, message, details, project });

  const plan = planOwnershipTransfer(project, targetInfo, input.confirmSlug);
  if (!plan.ok) {
    deps.log(`${slug}: rejected — ${plan.reason}`);
    return fail(plan.reason);
  }
  if (!deps.giteaEnabled()) {
    return fail('Gitea integration is disabled on this portal, so repositories cannot be transferred.');
  }
  // Both are non-null once the plan passed.
  const toEmail = targetInfo.email as string;
  const giteaFrom = project.gitea_repo as string;

  // Previous owner, for the audit row and the optional keep-as-admin grant.
  // Best-effort: a deleted/unknown identity falls back to the raw id.
  let fromEmail = project.owner_id;
  try {
    const prev = describeIdentity(await deps.getIdentity(project.owner_id));
    fromEmail = prev.email || prev.username || project.owner_id;
  } catch (e: any) {
    deps.error(`${slug}: could not resolve previous owner ${project.owner_id}: ${e?.message}`);
  }

  // Target must address exactly one Gitea account before anything moves.
  try {
    await deps.ensureProvisioned(target);
  } catch (e: any) {
    deps.error(`${slug}: provisioning ${targetInfo.id} failed: ${e?.message}`);
  }
  const newGiteaUser = deps.giteaUsernameFor(target);
  if (!newGiteaUser) {
    return fail('Could not derive a Gitea username for that member (reserved or invalid name). Nothing was changed.');
  }
  let giteaAccount: { login: string; email?: string } | null = null;
  try {
    giteaAccount = await deps.getGiteaUser(newGiteaUser);
  } catch (e: any) {
    return fail(`Gitea lookup of "${newGiteaUser}" failed: ${e?.message}. Nothing was changed.`);
  }
  if (!giteaAccount) {
    return fail(`Gitea account "${newGiteaUser}" does not exist and could not be provisioned — see portal logs. Nothing was changed.`);
  }
  if (giteaAccount.email && targetInfo.email
      && giteaAccount.email.toLowerCase() !== targetInfo.email.toLowerCase()) {
    return fail(`Gitea account "${newGiteaUser}" belongs to a different email (${giteaAccount.email}) — refusing to hand the repo to it. Nothing was changed.`);
  }

  const [oldGiteaOwner, repo] = giteaFrom.split('/');
  if (!oldGiteaOwner || !repo) return fail('Recorded Gitea repo is malformed. Nothing was changed.');
  const newGiteaRepo = `${newGiteaUser}/${repo}`;
  const details: string[] = [];
  const partial: string[] = [];

  // ── 3. Gitea transfer (the point of no return) ──────────────────────────
  if (oldGiteaOwner === newGiteaUser) {
    deps.log(`${slug}: repo already under ${newGiteaUser}; skipping the Gitea transfer (reconciling the portal row only)`);
    details.push(`Gitea repo was already under ${newGiteaUser}; only the portal record changed.`);
  } else {
    try {
      const r = await deps.transferRepo({ owner: oldGiteaOwner, repo, newOwner: newGiteaUser });
      deps.log(`${slug}: Gitea ${project.gitea_repo} → ${r.fullName} by ${input.actorEmail}`);
      details.push(`Gitea repository moved to ${r.fullName}.`);
    } catch (e: any) {
      deps.error(`${slug}: Gitea transfer ${project.gitea_repo} → ${newGiteaRepo} failed: ${e?.message}`);
      return fail(`Gitea refused the repository transfer: ${e?.message}. Nothing was changed.`);
    }
  }

  // ── 4. Portal row — immediately, before anything else can fail ──────────
  try {
    await deps.setProjectOwner(project.id, target.id, newGiteaRepo);
    deps.log(`${slug}: owner ${project.owner_id} → ${target.id}, gitea_repo ${project.gitea_repo} → ${newGiteaRepo}`);
  } catch (e: any) {
    deps.error(`${slug}: DB update failed AFTER the Gitea transfer: ${e?.message}`);
    const fix = `UPDATE projects SET owner_id = '${target.id}', gitea_repo = '${newGiteaRepo}' WHERE id = '${project.id}';`;
    await deps.recordAudit(input.actorEmail, slug, {
      action: TRANSFER_AUDIT_ACTION, fromOwnerId: project.owner_id, toOwnerId: target.id,
      fromEmail, toEmail, giteaFrom, giteaTo: newGiteaRepo,
      keptPreviousOwnerAsAdmin: false, partial: [`portal row not updated: ${e?.message}`],
    } satisfies TransferAuditChange);
    return {
      ok: false, changed: true, project,
      message: `The Gitea repository is now ${newGiteaRepo} but the portal record could NOT be updated (${e?.message}). The project is inconsistent until this is fixed by hand, then re-submit this form to finish the remaining steps.`,
      details: [...details, `Run against the portal database: ${fix}`],
    };
  }
  const updated: Project = { ...project, owner_id: target.id, gitea_repo: newGiteaRepo };

  // ── 5. Grants ───────────────────────────────────────────────────────────
  try {
    const own = await deps.findGrantBySubject(project.id, 'user', target.id);
    if (own) {
      await deps.deleteGrant(own.id);
      details.push(`Removed ${targetInfo.email}'s explicit grant (owners have full access).`);
    }
  } catch (e: any) {
    partial.push(`could not remove the new owner's old grant row: ${e?.message} — delete it from the project's Access page`);
  }
  if (input.keepPreviousOwnerAsAdmin) {
    try {
      const base = {
        projectId: project.id, subjectType: 'user' as const, subjectId: project.owner_id,
        subjectName: fromEmail, giteaUsername: oldGiteaOwner,
      };
      await deps.setGrantFacet({ ...base, facet: 'site', level: 'admin' });
      await deps.setGrantFacet({ ...base, facet: 'repo', level: 'admin' });
      details.push(`Previous owner ${fromEmail} kept as admin (site + repo).`);
    } catch (e: any) {
      partial.push(`previous owner ${fromEmail} was NOT granted admin: ${e?.message} — grant them from the project's Access page`);
    }
  } else {
    details.push(`Previous owner ${fromEmail} no longer has access.`);
  }

  // ── 6. Gitea collaborators ──────────────────────────────────────────────
  try {
    const sync = await deps.syncRepoAccess(updated);
    if (sync.skipped) {
      details.push('Collaborator converge skipped (Gitea disabled or no repo).');
    } else if (sync.errors.length) {
      partial.push(`collaborator converge incomplete: ${sync.errors.join('; ')} — the periodic reconcile will retry`);
    } else {
      details.push(`Gitea collaborators re-converged (+${sync.added.length} / -${sync.removed.length}).`);
    }
  } catch (e: any) {
    partial.push(`collaborator converge failed: ${e?.message} — the periodic reconcile will retry`);
  }

  // ── 7. ArgoCD source ────────────────────────────────────────────────────
  const repoUrl = argoRepoUrlFor(newGiteaRepo);
  const manualPatch = `kubectl -n ${CV_PROJECTS_ARGOCD_NAMESPACE} patch application ${slug} --type merge -p '{"spec":{"source":{"repoURL":"${repoUrl}"}}}'`;
  if (deps.k8sEnabled()) {
    try {
      await deps.patchArgoRepoUrl({ name: slug, namespace: CV_PROJECTS_ARGOCD_NAMESPACE, repoUrl });
      deps.log(`${slug}: ArgoCD Application repointed to ${repoUrl}`);
      details.push(`ArgoCD Application now syncs from ${repoUrl}.`);
    } catch (e: any) {
      deps.error(`${slug}: ArgoCD repoint failed: ${e?.message}`);
      partial.push(`ArgoCD Application still points at the OLD repo URL (${e?.message}); deployments will not follow new pushes until you run: ${manualPatch}`);
    }
  } else {
    partial.push(`Kubernetes integration is disabled here, so the ArgoCD Application was not repointed; if one exists run: ${manualPatch}`);
  }

  // Image path note: the running deployment is unaffected by the transfer.
  details.push(`Running deployment unchanged: k8s/deployment.yaml still pins ${CV_REGISTRY}/${oldGiteaOwner}/${repo}:<tag>, which stays pullable (the in-cluster registry has no per-user ownership). The next build pushes ${CV_REGISTRY}/${newGiteaRepo}:<tag> and the pin step rewrites the image path to match.`);

  // ── 8. Audit ────────────────────────────────────────────────────────────
  const change: TransferAuditChange = {
    action: TRANSFER_AUDIT_ACTION,
    fromOwnerId: project.owner_id, toOwnerId: target.id,
    fromEmail, toEmail, giteaFrom, giteaTo: newGiteaRepo,
    keptPreviousOwnerAsAdmin: input.keepPreviousOwnerAsAdmin,
    ...(partial.length ? { partial } : {}),
  };
  await deps.recordAudit(input.actorEmail, slug, change);

  const ok = partial.length === 0;
  const message = ok
    ? `Ownership of ${slug} transferred to ${targetInfo.email}.`
    : `Ownership of ${slug} transferred to ${targetInfo.email}, but ${partial.length} follow-up step(s) failed — see below.`;
  return {
    ok, changed: true, message, project: updated,
    details: [...details, ...partial.map((p) => `Needs attention: ${p}`)],
  };
}
