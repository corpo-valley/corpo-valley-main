import { Router, Request, Response } from 'express';
import { requireSession } from '../middleware/session';
import { requireAdmin } from '../middleware/requireAdmin';
import { csrfHiddenField } from '../middleware/csrf';
import { isUserAdmin, setUserAdmin, setServiceAdminOnly, listAllServices } from '../services/keto';
import {
  listIdentities, getIdentity, createIdentity, updateIdentityTraits,
  createRecoveryCodeForIdentity,
} from '../services/kratos-admin';
import { listClients, getClient, createClient, deleteClient, API_KEY_TYPE } from '../services/hydra-admin';
import { ensureProvisioned } from '../services/provisioning';
import { deleteUserCascade } from '../services/user-delete';
import { isReservedUsername, isValidUsername } from '../services/reserved-names';
import {
  renderAdminUsers, renderAdminUserDetail, renderAdminUserCreate,
  renderAdminRecoveryResult, renderAdminApps,
  renderAdminRegisterForm, renderAdminRegisterResult, renderAdminTemplate,
  renderAdminResourcesIndex, renderAdminProjectResourceDetail,
  renderStorageHelp, renderError,
  renderAdminCooldeps,
  UserRow, AppRow, DefaultsGroupView, ResourceProjectRow, ResourcesResultView,
  ProjectResourceDetailView,
} from '../templates';
import {
  cooldepsEnabled, loadCooldepsConfig, saveCooldepsConfig,
  parseCooldepsConfig, reconcileCooldepsConfig, CooldepsConfigError,
  DEFAULT_COOLDEPS_CONFIG,
} from '../services/cooldeps-config';
import {
  seedCommunityCenterTemplate, communityCenterTemplateStatus,
} from '../services/template-seed';
import {
  communityCenterAccessOverview, grantManualAccess, revokeManualAccess,
  applyAdminRoleToRepo,
} from '../services/community-center';
import {
  reconcileTenantResources, reconcileTenantStorage, readTenantQuota,
  TenantResourceOverrides, StorageReconcileEntry, TenantQuotaState,
} from '../services/k8s';
import {
  getProjectBySlug, listAllProjects, setProjectResourceOverrides, Project,
} from '../services/projects';
import {
  isQuantity, isCount, quantityToNumber, TENANT_MAX_PVC_SIZE,
} from '../services/platform-config';
import {
  TenantDefaults, CHART_TENANT_DEFAULTS, tenantDefaults, loadTenantDefaults,
  saveTenantDefaults, effectiveForProject, validateTenantDefaults,
  TenantDefaultsError, recordResourceAudit, listResourceAudit,
} from '../services/tenant-defaults';

const router = Router();

// All admin routes require session + admin
router.use(requireSession, requireAdmin);

// ── Users ──────────────────────────────────────────────────

function toUserRow(identity: { id: string; state?: string; traits?: any }, isAdmin: boolean): UserRow {
  const traits = (identity.traits ?? {}) as Record<string, any>;
  const first = traits?.name?.first || '';
  const last = traits?.name?.last || '';
  return {
    id: identity.id,
    email: traits?.email || '',
    preferredUsername: traits?.preferred_username || '',
    firstName: first,
    lastName: last,
    name: `${first} ${last}`.trim(),
    state: identity.state || 'active',
    isAdmin,
  };
}

router.get('/users', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const page = parseInt(req.query.page as string) || 0;

  try {
    const { identities, hasMore } = await listIdentities(page, 25);

    const users: UserRow[] = await Promise.all(
      identities.map(async (identity) => {
        let admin = false;
        try { admin = await isUserAdmin(identity.id); } catch { /* default to user */ }
        return toUserRow(identity, admin);
      })
    );

    res.send(renderAdminUsers(users, page, hasMore, session.email));
  } catch (err: any) {
    console.error('Admin users error:');
    res.status(500).send(renderError('Error', 'Failed to load users.'));
  }
});

router.get('/users/new', (req: Request, res: Response) => {
  const csrf = csrfHiddenField(req, res);
  res.send(renderAdminUserCreate(req.portalSession!.email, csrf));
});

router.post('/users', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const { email, preferred_username, first_name, last_name } = req.body || {};

  if (!email || typeof email !== 'string') {
    const csrf = csrfHiddenField(req, res);
    res.status(400).send(renderAdminUserCreate(session.email, csrf, 'Email is required.', req.body));
    return;
  }

  const traits: Record<string, any> = { email };
  if (preferred_username) {
    if (!isValidUsername(preferred_username) || isReservedUsername(preferred_username)) {
      const csrf = csrfHiddenField(req, res);
      res.status(400).send(renderAdminUserCreate(session.email, csrf, `Username "${preferred_username}" is reserved or invalid.`, req.body));
      return;
    }
    traits.preferred_username = preferred_username;
  }
  if (first_name || last_name) {
    traits.name = {};
    if (first_name) traits.name.first = first_name;
    if (last_name) traits.name.last = last_name;
  }

  try {
    const identity = await createIdentity(traits as any);
    // Provision the paired .bot identity + Gitea accounts. Shared, idempotent,
    // best-effort (services/provisioning.ts). Awaited here so the admin sees a
    // fully provisioned user on redirect. New accounts are regular users; the
    // admin role is granted separately via the toggle on the user page.
    await ensureProvisioned(identity);
    res.redirect(`/admin/users/${identity.id}`);
  } catch (err: any) {
    const detail = err?.response?.data?.error?.message
      || err?.response?.data?.error?.reason
      || err.message
      || 'Failed to create user.';
    console.error('Create user error:', detail);
    const csrf = csrfHiddenField(req, res);
    res.status(400).send(renderAdminUserCreate(session.email, csrf, detail, req.body));
  }
});

router.get('/users/:id', async (req: Request, res: Response) => {
  const session = req.portalSession!;

  try {
    const identity = await getIdentity(req.params.id);
    const admin = await isUserAdmin(identity.id);
    const csrf = csrfHiddenField(req, res);
    res.send(renderAdminUserDetail(toUserRow(identity, admin), session.email, csrf, identity.id === session.id));
  } catch (err: any) {
    console.error('Admin user detail error:');
    res.status(500).send(renderError('Error', 'Failed to load user.'));
  }
});

router.post('/users/:id', async (req: Request, res: Response) => {
  const { email, preferred_username, first_name, last_name } = req.body || {};

  if (!email || typeof email !== 'string') {
    res.status(400).send(renderError('Invalid Input', 'Email is required.'));
    return;
  }

  const traits: Record<string, any> = { email };
  if (preferred_username) {
    if (!isValidUsername(preferred_username) || isReservedUsername(preferred_username)) {
      res.status(400).send(renderError('Invalid Input', `Username "${preferred_username}" is reserved or invalid.`));
      return;
    }
    traits.preferred_username = preferred_username;
  }
  if (first_name || last_name) {
    traits.name = {};
    if (first_name) traits.name.first = first_name;
    if (last_name) traits.name.last = last_name;
  }

  try {
    await updateIdentityTraits(req.params.id, traits as any);
    res.redirect(`/admin/users/${req.params.id}`);
  } catch (err: any) {
    const detail = err?.response?.data?.error?.message
      || err?.response?.data?.error?.reason
      || err.message
      || 'Failed to update user.';
    console.error('Update user error:', detail);
    res.status(400).send(renderError('Error', detail));
  }
});

router.post('/users/:id/recovery', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const identity = await getIdentity(req.params.id);
    const admin = await isUserAdmin(identity.id);
    const recovery = await createRecoveryCodeForIdentity(identity.id);
    res.send(renderAdminRecoveryResult(
      toUserRow(identity, admin),
      recovery.recovery_link,
      recovery.recovery_code,
      recovery.expires_at,
      session.email,
    ));
  } catch (err: any) {
    console.error('Recovery code error:', err.message);
    res.status(500).send(renderError('Error', 'Failed to generate recovery code.'));
  }
});

router.post('/users/:id/role', async (req: Request, res: Response) => {
  const role = req.body?.role;
  if (role !== 'admin' && role !== 'user') {
    res.status(400).send(renderError('Invalid Role', 'Role must be admin or user.'));
    return;
  }

  // Don't let an admin demote themselves — the platform must always keep the
  // acting admin able to undo the change.
  if (role === 'user' && req.params.id === req.portalSession!.id) {
    res.status(400).send(renderError('Invalid Role', 'You cannot remove your own admin role.'));
    return;
  }

  try {
    await setUserAdmin(req.params.id, role === 'admin');
    // Drive Community Center template repo access from the role change:
    // promote → write collaborator, demote → removed. Best-effort and
    // non-throwing (the service logs on failure) so a Gitea hiccup never
    // fails the role change itself.
    await applyAdminRoleToRepo(req.params.id, role === 'admin');
    res.redirect(`/admin/users/${req.params.id}`);
  } catch (err: any) {
    console.error('Set role error:');
    res.status(500).send(renderError('Error', 'Failed to update role.'));
  }
});

// POST /users/:id/delete — permanently delete a user and everything attached to
// them (owned projects, groups, grants, API keys, admin role, paired .bot, and
// both Gitea accounts). Irreversible. See services/user-delete.ts.
router.post('/users/:id/delete', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const targetId = req.params.id;

  // An admin must never delete themselves — it could orphan the platform (no
  // path to undo) and races the acting session. Mirrors the role-demotion guard.
  if (targetId === session.id) {
    res.status(400).send(renderError('Invalid Target', 'You cannot delete your own account.'));
    return;
  }

  let identity;
  try {
    identity = await getIdentity(targetId);
  } catch {
    res.status(404).send(renderError('Not Found', 'User not found.'));
    return;
  }
  // Bots are deleted only as part of their human's cascade, never on their own.
  const meta = (identity.metadata_public ?? {}) as Record<string, any>;
  if (meta.type === 'bot') {
    res.status(400).send(renderError('Invalid Target', 'Bot identities are removed automatically when their owner is deleted.'));
    return;
  }

  try {
    const result = await deleteUserCascade(identity);
    const traits = (identity.traits ?? {}) as Record<string, any>;
    const who = traits.email || targetId;
    console.log(`[admin] user ${who} delete by ${session.email}: ` +
      `${result.projectsPurged} project(s), ${result.groupsDeleted} group(s), ${result.apiKeysRevoked} key(s), ` +
      `identityDeleted=${result.identityDeleted}` +
      (result.errors.length ? `; ${result.errors.length} error(s): ${result.errors.join('; ')}` : ''));
    // Don't report a clean success when teardown was partial — the admin must
    // know what's left and (if the identity was kept) that they can retry.
    if (result.errors.length) {
      const retryNote = result.identityDeleted
        ? 'The account was removed, but the listed resources may need manual cleanup.'
        : 'The account was KEPT so you can re-run the delete once the issue clears.';
      res.status(500).send(renderError(
        'User deletion incomplete',
        `Some teardown steps for ${who} did not complete:\n\n- ${result.errors.join('\n- ')}\n\n${retryNote}`,
      ));
      return;
    }
    res.redirect('/admin/users');
  } catch (err: any) {
    console.error('Delete user error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to delete user — see portal logs.'));
  }
});

// ── Apps / Services ────────────────────────────────────────

router.get('/apps', async (req: Request, res: Response) => {
  const session = req.portalSession!;

  try {
    const clients = await listClients();
    // Access lives in Keto: an admins-only tuple restricts the service,
    // absence means open to all signed-in users.
    const adminOnlyServices = new Set(
      (await listAllServices()).filter((s) => s.adminOnly).map((s) => s.name)
    );
    const apps: AppRow[] = clients
      .filter(c => {
        const meta = c.metadata as Record<string, string> | undefined;
        return meta?.type !== API_KEY_TYPE; // exclude user API keys
      })
      .map(c => ({
        clientId: c.client_id || '',
        clientName: c.client_name || c.client_id || '',
        adminOnly: adminOnlyServices.has(c.client_id || ''),
      }));

    apps.sort((a, b) => a.clientId.localeCompare(b.clientId));
    const csrf = csrfHiddenField(req, res);
    res.send(renderAdminApps(apps, session.email, csrf));
  } catch (err: any) {
    console.error('Admin apps error:');
    res.status(500).send(renderError('Error', 'Failed to load services.'));
  }
});

// First-party SSO clients the consent auto-trust + MCP denylist depend on.
// Deleting or re-gating these silently changes the platform's security posture,
// so the admin app routes refuse to touch them (same set as TRUSTED_CLIENT_IDS).
const PROTECTED_CLIENT_IDS = new Set(
  (process.env.TRUSTED_CLIENT_IDS || 'argocd,gitea').split(',').map((s) => s.trim()).filter(Boolean),
);

// Ensure :appId refers to a manageable service client — not a user's API key
// (managed only via the owner's /keys path) and not a protected SSO client. The
// /admin/apps listing already filters these out; the mutating routes must too.
// Returns the client on success, or null after sending an error response.
async function loadManageableServiceClient(appId: string, res: Response) {
  if (PROTECTED_CLIENT_IDS.has(appId)) {
    res.status(403).send(renderError('Protected client', `"${appId}" is a protected platform client and cannot be modified here.`));
    return null;
  }
  let client;
  try {
    client = await getClient(appId);
  } catch {
    res.status(404).send(renderError('Not Found', 'Service client not found.'));
    return null;
  }
  const meta = (client.metadata as Record<string, any>) || {};
  if (meta.type === API_KEY_TYPE) {
    res.status(403).send(renderError('Not a service', 'That client is a user API key; manage it from the owner\'s key page.'));
    return null;
  }
  return client;
}

router.post('/apps/:appId/access', async (req: Request, res: Response) => {
  const access = req.body?.access;
  if (access !== 'all' && access !== 'admin') {
    res.status(400).send(renderError('Invalid Access', 'Access must be all or admin.'));
    return;
  }

  try {
    const { appId } = req.params;
    if (!(await loadManageableServiceClient(appId, res))) return;
    await setServiceAdminOnly(appId, access === 'admin');
    res.redirect('/admin/apps');
  } catch (err: any) {
    console.error('Set app access error:');
    res.status(500).send(renderError('Error', 'Failed to update service access.'));
  }
});

router.get('/apps/register', async (req: Request, res: Response) => {
  const csrf = csrfHiddenField(req, res);
  res.send(renderAdminRegisterForm(req.portalSession!.email, csrf));
});

router.post('/apps/register', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const { appName, displayName, redirectUri, access } = req.body || {};
  const adminOnly = access === 'admin';

  // redirectUri is required — there is no sensible default to invent for an
  // arbitrary deployment's domain layout.
  if (!appName || !displayName || !redirectUri) {
    res.status(400).send(renderError('Invalid Input', 'App name, display name, and redirect URI are required.'));
    return;
  }

  try {
    const { client, secret } = await createClient({
      id: appName,
      name: displayName,
      redirectUris: [redirectUri],
      grantTypes: ['authorization_code', 'refresh_token'],
    });

    if (adminOnly) {
      try {
        await setServiceAdminOnly(appName, true);
      } catch (gateErr: any) {
        // Compensate: the Hydra client now exists (with a secret the admin never
        // saw) but is NOT admins-only as requested. Roll it back so a retry with
        // the same appName doesn't fail with a duplicate-client error and wedge
        // the admin — and so the service is never live with looser access than
        // the admin asked for.
        console.error('Register app: setServiceAdminOnly failed, rolling back client', appName, gateErr?.message);
        await deleteClient(appName).catch((delErr: any) =>
          console.error('Register app: rollback deleteClient failed', appName, delErr?.message));
        throw gateErr;
      }
    }

    res.send(renderAdminRegisterResult(client.client_id || appName, secret, adminOnly, session.email));
  } catch (err: any) {
    console.error('Register app error:');
    res.status(500).send(renderError('Error', 'Failed to register service.'));
  }
});

router.post('/apps/:appId/delete', async (req: Request, res: Response) => {
  try {
    if (!(await loadManageableServiceClient(req.params.appId, res))) return;
    await deleteClient(req.params.appId);
    res.redirect('/admin/apps');
  } catch (err: any) {
    console.error('Delete app error:');
    res.status(500).send(renderError('Error', 'Failed to delete service.'));
  }
});

// ── Community Center template ──────────────────────────────
//
// The Gitea template repo is admin-owned after the first seed; this page
// shows its state and offers the one destructive platform action on it:
// resetting it back to the baseline baked into the portal image.

router.get('/template', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const [status, access] = await Promise.all([
      communityCenterTemplateStatus(),
      communityCenterAccessOverview(),
    ]);
    res.send(renderAdminTemplate(status, null, session.email, csrfHiddenField(req, res), access, null));
  } catch (err: any) {
    console.error('Admin template status error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to load template status.'));
  }
});

router.post('/template/reset', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const result = await seedCommunityCenterTemplate({ force: true });
    console.log(`[template-seed] admin reset by ${session.email}: ${result.action}` +
      (result.written !== undefined ? ` (${result.written} written, ${result.deleted} deleted)` : ''));
    const [status, access] = await Promise.all([
      communityCenterTemplateStatus(),
      communityCenterAccessOverview(),
    ]);
    res.send(renderAdminTemplate(status, result, session.email, csrfHiddenField(req, res), access, null));
  } catch (err: any) {
    console.error('Admin template reset error:', err?.message);
    res.status(500).send(renderError('Error', 'Template reset failed — see portal logs.'));
  }
});

// Re-render the template page with the result of a manual repo-access change.
async function renderTemplateWithAccessResult(
  req: Request, res: Response,
  result: { ok: boolean; message: string },
  statusCode = 200,
) {
  const session = req.portalSession!;
  const [status, access] = await Promise.all([
    communityCenterTemplateStatus(),
    communityCenterAccessOverview(),
  ]);
  res.status(statusCode).send(
    renderAdminTemplate(status, null, session.email, csrfHiddenField(req, res), access, result),
  );
}

// Manually grant a non-admin user write access to the template repo.
router.post('/template/access/grant', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier : '';
  try {
    const result = await grantManualAccess(identifier);
    if (result.ok) {
      console.log(`[community-center] manual grant of ${result.username} by ${session.email}`);
    }
    await renderTemplateWithAccessResult(req, res, result, result.ok ? 200 : 400);
  } catch (err: any) {
    console.error('Community Center manual grant error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to grant access — see portal logs.'));
  }
});

// Manually remove a non-admin collaborator from the template repo.
router.post('/template/access/revoke', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  try {
    const result = await revokeManualAccess(username);
    if (result.ok) {
      console.log(`[community-center] manual revoke of ${result.username} by ${session.email}`);
    }
    await renderTemplateWithAccessResult(req, res, result, result.ok ? 200 : 400);
  } catch (err: any) {
    console.error('Community Center manual revoke error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to remove access — see portal logs.'));
  }
});

// ── Resource management (platform defaults + per-project overrides) ────────
//
// /admin/resources follows the cooldeps pattern: the chart values seed the
// platform defaults, the platform_tenant_defaults row is the source of truth
// once saved, and each project's bump lives on projects.resource_overrides.
// Saving defaults NEVER sweeps existing namespaces — that's the explicit
// "Apply defaults to all existing projects" button, or a project's own page.
// Overrides are UP-ONLY relative to the CURRENT defaults; Clear is the way
// down. Every save/clear/sweep appends a cv_resource_audit row.

type FieldKind = 'quantity' | 'count';
interface ResourceFieldSpec {
  key: keyof TenantDefaults;
  group: string;
  label: string;
  kind: FieldKind;
  help: string;
  // Exposed as a per-project override knob on the detail page. The LimitRange
  // default/defaultRequest pairs and the volume provision size are
  // defaults-page only — they shape NEW containers/volumes, not one project's
  // ceiling.
  perProject: boolean;
  // Where the detail page's "Live now" column reads this field from: a
  // ResourceQuota spec.hard key, or the LimitRange per-container max.
  liveSource?: { kind: 'quota'; key: string } | { kind: 'limitMax'; key: 'cpu' | 'memory' };
}

// Every operator-tunable field, in display order. PVC *size* is handled
// separately (it grows volumes, not the quota) — see the pvcSize handling in
// the per-project POST.
const RESOURCE_FIELDS: ResourceFieldSpec[] = [
  { key: 'max', group: 'Memory', label: 'Max memory (ResourceQuota limits.memory)', kind: 'quantity', perProject: true, liveSource: { kind: 'quota', key: 'limits.memory' }, help: 'Total memory across all the project\'s pods.' },
  { key: 'maxRequests', group: 'Memory', label: 'Memory request budget (requests.memory)', kind: 'quantity', perProject: true, liveSource: { kind: 'quota', key: 'requests.memory' }, help: 'Sum of pod memory requests.' },
  { key: 'maxPerContainer', group: 'Memory', label: 'Per-container memory ceiling (LimitRange max)', kind: 'quantity', perProject: true, liveSource: { kind: 'limitMax', key: 'memory' }, help: 'Most any single container may request.' },
  { key: 'default', group: 'Memory', label: 'Default container memory limit', kind: 'quantity', perProject: false, help: 'Applied to a container that declares no memory limit.' },
  { key: 'defaultRequest', group: 'Memory', label: 'Default container memory request', kind: 'quantity', perProject: false, help: 'Applied to a container that declares no memory request.' },
  { key: 'cpuMax', group: 'CPU', label: 'Max CPU (ResourceQuota limits.cpu)', kind: 'quantity', perProject: true, liveSource: { kind: 'quota', key: 'limits.cpu' }, help: 'Total CPU across all pods, in cores (4) or millicores (500m).' },
  { key: 'cpuMaxRequests', group: 'CPU', label: 'CPU request budget (requests.cpu)', kind: 'quantity', perProject: true, liveSource: { kind: 'quota', key: 'requests.cpu' }, help: 'Sum of pod CPU requests.' },
  { key: 'cpuMaxPerContainer', group: 'CPU', label: 'Per-container CPU ceiling (LimitRange max)', kind: 'quantity', perProject: true, liveSource: { kind: 'limitMax', key: 'cpu' }, help: 'Most any single container may request.' },
  { key: 'cpuDefault', group: 'CPU', label: 'Default container CPU limit', kind: 'quantity', perProject: false, help: 'Applied to a container that declares no CPU limit.' },
  { key: 'cpuDefaultRequest', group: 'CPU', label: 'Default container CPU request', kind: 'quantity', perProject: false, help: 'Applied to a container that declares no CPU request.' },
  { key: 'maxPods', group: 'Counts & storage', label: 'Max pods', kind: 'count', perProject: true, liveSource: { kind: 'quota', key: 'pods' }, help: 'Integer. Caps total pods in the namespace.' },
  { key: 'maxPvcs', group: 'Counts & storage', label: 'Max PersistentVolumeClaims', kind: 'count', perProject: true, liveSource: { kind: 'quota', key: 'persistentvolumeclaims' }, help: 'Integer. Caps total PVCs, including any added via the project repo.' },
  { key: 'maxStorage', group: 'Counts & storage', label: 'Max total storage (requests.storage)', kind: 'quantity', perProject: true, liveSource: { kind: 'quota', key: 'requests.storage' }, help: 'Sum of every PVC in the namespace. Raise this before growing a volume.' },
  { key: 'defaultStorage', group: 'Counts & storage', label: 'Data volume size at provision', kind: 'quantity', perProject: false, help: 'Size each capability data volume (Postgres/Garage PVC) is created at. Capped by the chart\'s per-volume admission bound.' },
];

const RESOURCE_GROUP_ORDER = ['Memory', 'CPU', 'Counts & storage'];

// Validate one submitted value against its field's kind, throwing the same
// admin-facing error shape everywhere.
function checkFieldValue(f: ResourceFieldSpec, v: string): void {
  const valid = f.kind === 'count' ? isCount(v) : isQuantity(v);
  if (!valid) {
    throw new TenantDefaultsError(f.kind === 'count'
      ? `"${v}" is not a valid integer for "${f.label}".`
      : `"${v}" is not a valid quantity for "${f.label}" (e.g. 512Mi, 2, 500m).`);
  }
}

// The override keys a project has set (in field display order, for the
// "customised" summary on the index).
function overriddenKeys(overrides: Record<string, string> | null): string[] {
  if (!overrides) return [];
  return RESOURCE_FIELDS.filter((f) => typeof overrides[f.key] === 'string').map((f) => f.key);
}

// Render a one-line summary of what a storage grow did, per volume.
function storageDetail(e: StorageReconcileEntry): string {
  switch (e.result) {
    case 'expanded': return `${e.capability} volume grown ${e.from ?? '?'} → ${e.to}`
      + (e.restarted ? ' (pod restarted to finish the filesystem resize)' : '');
    case 'noop': return `${e.capability} volume already ≥ ${e.to}, unchanged`;
    case 'absent': return `${e.capability} not enabled on this project, skipped`;
    case 'unsupported': return `${e.capability} volume: StorageClass does not support expansion — manual migration required`;
    case 'error': return `${e.capability} volume: could not grow (${e.note || 'see portal logs'})`;
  }
}

// Human summary of a cv_resource_audit change blob for the detail page.
function auditSummary(change: Record<string, unknown>): string {
  const action = typeof change.action === 'string' ? change.action : '';
  if (action === 'save-overrides') {
    const ov = (change.overrides ?? {}) as Record<string, string>;
    const parts = Object.entries(ov).map(([k, v]) => `${k}=${v}`);
    const set = parts.length ? `set ${parts.join(', ')}` : 'reset to platform defaults';
    return typeof change.pvcSize === 'string' ? `${set}; grow volumes to ${change.pvcSize}` : set;
  }
  if (action === 'clear-overrides') return 'cleared overrides (back to platform defaults)';
  if (action === 'apply-all') return `apply-all defaults sweep (${change.applied ?? '?'} applied, ${change.failures ?? 0} failed)`;
  if (action === 'save-defaults') return 'platform defaults saved';
  return JSON.stringify(change).slice(0, 200);
}

// Owner ids → emails for the projects table, best-effort (a Kratos hiccup
// falls back to the raw id rather than failing the page).
async function resolveOwnerEmails(projects: Project[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  await Promise.all([...new Set(projects.map((p) => p.owner_id))].map(async (id) => {
    try {
      const identity = await getIdentity(id);
      owners.set(id, ((identity.traits ?? {}) as Record<string, any>).email || id);
    } catch { owners.set(id, id); }
  }));
  return owners;
}

// Render the /admin/resources index. `form` (when given) carries the admin's
// raw defaults-card input back after a validation error; otherwise the card
// shows the current effective defaults.
async function renderResourcesIndex(
  req: Request, res: Response, status: number,
  result: ResourcesResultView | null, form?: Record<string, string>,
): Promise<void> {
  const record = await loadTenantDefaults();
  const groups: DefaultsGroupView[] = RESOURCE_GROUP_ORDER.map((title) => ({
    title,
    fields: RESOURCE_FIELDS.filter((f) => f.group === title).map((f) => ({
      key: f.key, label: f.label, help: f.help,
      value: form?.[f.key] ?? record.config[f.key],
      chartSeed: CHART_TENANT_DEFAULTS[f.key],
    })),
  }));
  const projects = await listAllProjects();
  const owners = await resolveOwnerEmails(projects);
  const rows: ResourceProjectRow[] = projects.map((p) => {
    const keys = overriddenKeys(p.resource_overrides);
    return {
      slug: p.slug, name: p.name,
      owner: owners.get(p.owner_id) || p.owner_id,
      customised: keys.length > 0,
      overriddenKeys: keys,
      updatedAt: p.resource_overrides_updated_at
        ? new Date(p.resource_overrides_updated_at).toISOString() : null,
      updatedBy: p.resource_overrides_updated_by,
    };
  });
  res.status(status).send(renderAdminResourcesIndex(
    groups, { persisted: record.persisted, updatedAt: record.updatedAt, updatedBy: record.updatedBy },
    rows, result, req.portalSession!.email, csrfHiddenField(req, res),
  ));
}

// Build the per-project detail view: platform default | stored override (or a
// live value worth capturing) | live now, with drift markers.
async function buildProjectResourceView(project: Project): Promise<ProjectResourceDetailView> {
  const defaults = tenantDefaults();
  const overrides = project.resource_overrides ?? {};
  const expected = effectiveForProject(overrides);
  let live: TenantQuotaState | null = null;
  try {
    live = await readTenantQuota(project.slug);
  } catch (err: any) {
    console.error(`[admin] readTenantQuota(${project.slug}) failed:`, err?.message);
  }

  const fields = RESOURCE_FIELDS.filter((f) => f.perProject).map((f) => {
    let liveVal: string | undefined;
    let used: string | null = null;
    if (live && f.liveSource) {
      if (f.liveSource.kind === 'quota') {
        liveVal = live.hard[f.liveSource.key];
        used = live.used[f.liveSource.key] ?? null;
      } else {
        liveVal = live.limitMax[f.liveSource.key];
      }
    }
    const drift = liveVal !== undefined
      && quantityToNumber(liveVal) !== quantityToNumber(expected[f.key]);
    const stored = typeof overrides[f.key] === 'string' ? overrides[f.key] : undefined;
    // Pre-fill priority: the stored override; else, when the live value has
    // drifted ABOVE the platform default with nothing stored (a bump made
    // before overrides were persisted), pre-fill from live so the admin can
    // capture it by saving. Below-default drift is only flagged — capturing it
    // would violate up-only.
    const prefill = stored === undefined && drift && liveVal !== undefined
      && quantityToNumber(liveVal) > quantityToNumber(defaults[f.key]);
    return {
      key: f.key, label: f.label, help: f.help,
      platformDefault: defaults[f.key],
      overrideValue: stored ?? (prefill ? liveVal! : ''),
      prefilledFromLive: !!prefill,
      live: liveVal ?? null,
      used,
      drift,
    };
  });

  const audit = (await listResourceAudit(project.slug, 10)).map((a) => ({
    createdAt: a.createdAt, actor: a.actorEmail, summary: auditSummary(a.change),
  }));

  return {
    slug: project.slug, name: project.name,
    customised: overriddenKeys(project.resource_overrides).length > 0,
    updatedAt: project.resource_overrides_updated_at
      ? new Date(project.resource_overrides_updated_at).toISOString() : null,
    updatedBy: project.resource_overrides_updated_by,
    fields,
    pvcSizeFloor: defaults.defaultStorage,
    pvcSizeMax: TENANT_MAX_PVC_SIZE,
    liveAvailable: live !== null,
    audit,
  };
}

// The old URL, kept as a redirect so bookmarks and stale nav links land right.
router.get('/projects/resources', (req: Request, res: Response) => {
  res.redirect(302, '/admin/resources');
});

router.get('/resources', async (req: Request, res: Response) => {
  try {
    await renderResourcesIndex(req, res, 200, null);
  } catch (err: any) {
    console.error('Admin resources index error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to load resource management.'));
  }
});

// Save the platform defaults. A blank field reverts that knob to the chart
// seed. NEVER touches existing namespaces — new projects pick the values up at
// provision time; existing ones via apply-all or their own page.
router.post('/resources/defaults', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const body = (req.body || {}) as Record<string, unknown>;
  const form: Record<string, string> = {};
  for (const f of RESOURCE_FIELDS) {
    const v = body[f.key];
    if (typeof v === 'string') form[f.key] = v.trim();
  }

  try {
    const config: TenantDefaults = { ...CHART_TENANT_DEFAULTS };
    for (const f of RESOURCE_FIELDS) {
      const v = form[f.key] ?? '';
      if (v === '') continue;
      checkFieldValue(f, v);
      config[f.key] = v;
    }
    validateTenantDefaults(config);

    const before = { ...tenantDefaults() };
    await saveTenantDefaults(config, session.email);
    await recordResourceAudit(session.email, 'defaults', {
      action: 'save-defaults', before, after: config,
    });
    console.log(`[admin] platform resource defaults saved by ${session.email}`);
    await renderResourcesIndex(req, res, 200, {
      ok: true,
      message: 'Platform defaults saved. Existing projects are unchanged until you apply them — per project, or via "Apply defaults to all existing projects".',
    });
  } catch (err: any) {
    if (err instanceof TenantDefaultsError) {
      await renderResourcesIndex(req, res, 400, { ok: false, message: err.message }, form)
        .catch(() => res.status(500).send(renderError('Error', 'Failed to render resource management.')));
      return;
    }
    console.error('Admin resource defaults save error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to save defaults — see portal logs.'));
  }
});

// Sweep EVERY existing project's quota/limits to the current defaults (plus
// each project's stored overrides). Explicit-only — never triggered by a
// defaults save. Sequential on purpose: parallel patches would hammer the
// apiserver and garble per-project reporting.
router.post('/resources/apply-all', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const projects = await listAllProjects();
    const details: string[] = [];
    let applied = 0;
    let failures = 0;
    let k8sDisabled = false;
    for (const p of projects) {
      try {
        const r = await reconcileTenantResources(
          p.slug, (p.resource_overrides ?? {}) as TenantResourceOverrides,
        );
        if (r === null) { k8sDisabled = true; break; }
        applied++;
        details.push(`${p.slug}: quota ${r.quota}, limits ${r.limits}`
          + (overriddenKeys(p.resource_overrides).length ? ' (kept its overrides)' : ''));
      } catch (err: any) {
        failures++;
        details.push(`${p.slug}: FAILED — ${err?.message || 'see portal logs'}`);
      }
    }
    if (k8sDisabled) {
      await renderResourcesIndex(req, res, 503, {
        ok: false, message: 'Kubernetes integration is disabled on this deployment — nothing applied.',
      });
      return;
    }
    await recordResourceAudit(session.email, 'defaults', {
      action: 'apply-all', projects: projects.length, applied, failures,
    });
    console.log(`[admin] apply-all resource sweep by ${session.email}: `
      + `${applied} applied, ${failures} failed of ${projects.length}`);
    await renderResourcesIndex(req, res, failures ? 500 : 200, {
      ok: failures === 0,
      message: failures
        ? `Applied defaults to ${applied} project(s); ${failures} failed — see below.`
        : `Applied defaults to ${applied} project(s).`,
      details,
    });
  } catch (err: any) {
    console.error('Admin apply-all resources error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to apply defaults — see portal logs.'));
  }
});

router.get('/resources/:slug', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const project = await getProjectBySlug(req.params.slug);
    if (!project) {
      res.status(404).send(renderError('Not Found', 'No project with that slug.'));
      return;
    }
    res.send(renderAdminProjectResourceDetail(
      await buildProjectResourceView(project), null, session.email, csrfHiddenField(req, res),
    ));
  } catch (err: any) {
    console.error('Admin project resources error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to load project resources.'));
  }
});

// Save & apply one project's overrides: persist the full override set (blank
// field = inherit), then reconcile the live quota/limits and optionally grow
// the data volumes.
router.post('/resources/:slug', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const body = (req.body || {}) as Record<string, unknown>;
  const csrf = csrfHiddenField(req, res);
  const project = await getProjectBySlug(req.params.slug).catch(() => null);
  if (!project) {
    res.status(404).send(renderError('Not Found', 'No project with that slug.'));
    return;
  }

  const fail = async (message: string, status = 400) => {
    const view = await buildProjectResourceView(project);
    res.status(status).send(renderAdminProjectResourceDetail(
      view, { ok: false, message }, session.email, csrf,
    ));
  };

  try {
    const defaults = tenantDefaults();

    // Build the override set. Blank → inherit. Each value must (a) be a valid
    // quantity/count and (b) be ABOVE the current platform default — up-only;
    // a value equal to the default is stored as "inherit" so the customised
    // badge stays truthful. Reject the whole request on any bad field so the
    // admin gets a clear error, not a half-applied patch.
    const overrides: TenantResourceOverrides = {};
    for (const f of RESOURCE_FIELDS) {
      if (!f.perProject) continue;
      const raw = body[f.key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string') { await fail(`Invalid value for "${f.label}".`); return; }
      const v = raw.trim();
      if (v === '') continue;
      checkFieldValue(f, v);
      if (quantityToNumber(v) < quantityToNumber(defaults[f.key])) {
        await fail(`"${v}" is below the platform default of ${defaults[f.key]} for "${f.label}" — overrides are up-only (Clear overrides is the way down).`);
        return;
      }
      if (quantityToNumber(v) === quantityToNumber(defaults[f.key])) continue;
      (overrides as Record<string, string>)[f.key] = v;
    }

    // Cross-field sanity on the EFFECTIVE result (defaults ⊕ overrides), so a
    // bump can't create an internally inconsistent quota (e.g. a request
    // budget above the limit budget).
    validateTenantDefaults(effectiveForProject(overrides));

    // PVC grow target (optional). Bounded below by the current default volume
    // size (grow-only) and above by the per-volume admission cap — exceeding
    // it would be denied by the cv-projects-*-bounds VAP, so reject up front
    // instead of half-applying.
    let pvcSize: string | undefined;
    const rawSize = typeof body.pvcSize === 'string' ? body.pvcSize.trim() : '';
    if (rawSize !== '') {
      if (!isQuantity(rawSize)) { await fail(`"${rawSize}" is not a valid storage quantity (e.g. 10Gi).`); return; }
      if (quantityToNumber(rawSize) < quantityToNumber(defaults.defaultStorage)) {
        await fail(`"${rawSize}" is below the platform default of ${defaults.defaultStorage} — storage is grow-only.`); return;
      }
      if (quantityToNumber(rawSize) > quantityToNumber(TENANT_MAX_PVC_SIZE)) {
        await fail(`"${rawSize}" exceeds the per-volume cap of ${TENANT_MAX_PVC_SIZE} (admission would reject it) — raise tenant.storage.maxPerVolume in the chart.`); return;
      }
      pvcSize = rawSize;
    }

    // Persist first — the DB row is the source of truth — then reconcile.
    // Quota/LimitRange before volumes, so a raised requests.storage ceiling is
    // in place before we try to grow a volume into it.
    const stored = overriddenKeys(overrides as Record<string, string>).length
      ? (overrides as Record<string, string>) : null;
    const before = project.resource_overrides ?? null;
    await setProjectResourceOverrides(project.id, stored, session.email);

    const result = await reconcileTenantResources(project.slug, overrides);

    const details: string[] = [];
    let helpLink = false;
    if (pvcSize && result !== null) {
      const entries = (await reconcileTenantStorage(project.slug, pvcSize)) || [];
      for (const e of entries) {
        details.push(storageDetail(e));
        if (e.result === 'unsupported') helpLink = true;
      }
    }

    await recordResourceAudit(session.email, project.slug, {
      action: 'save-overrides', before, overrides: stored ?? {},
      ...(pvcSize ? { pvcSize } : {}),
    });
    const summary = stored
      ? Object.entries(stored).map(([k, v]) => `${k}=${v}`).join(', ')
      : 'platform defaults';
    console.log(`[admin] resources for ${project.slug} saved by ${session.email}: ${summary}`
      + (pvcSize ? `; pvcSize=${pvcSize}` : '')
      + (result ? `; quota ${result.quota}, limits ${result.limits}` : '; NOT applied (k8s disabled)'));

    // Re-read so the page reflects the just-persisted overrides + stamps.
    const fresh = (await getProjectBySlug(project.slug)) ?? project;
    const message = result === null
      ? 'Overrides saved, but Kubernetes integration is disabled on this deployment — the live quota was not touched.'
      : `Saved and applied ${stored ? `overrides (${summary})` : 'the platform defaults'} — ResourceQuota ${result.quota}, LimitRange ${result.limits}.`;
    res.status(result === null ? 503 : 200).send(renderAdminProjectResourceDetail(
      await buildProjectResourceView(fresh),
      { ok: result !== null, message, details, helpLink },
      session.email, csrf,
    ));
  } catch (err: any) {
    if (err instanceof TenantDefaultsError) {
      await fail(err.message).catch(() =>
        res.status(500).send(renderError('Error', 'Failed to render project resources.')));
      return;
    }
    console.error('Save project resources error:', err?.message);
    await fail('Failed to apply — see portal logs.', 500).catch(() =>
      res.status(500).send(renderError('Error', 'Failed to apply — see portal logs.')));
  }
});

// Clear a project's overrides and reconcile it back to the platform defaults —
// the sanctioned way DOWN from a bump.
router.post('/resources/:slug/clear', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const csrf = csrfHiddenField(req, res);
  const project = await getProjectBySlug(req.params.slug).catch(() => null);
  if (!project) {
    res.status(404).send(renderError('Not Found', 'No project with that slug.'));
    return;
  }

  try {
    const before = project.resource_overrides ?? null;
    await setProjectResourceOverrides(project.id, null, session.email);
    const result = await reconcileTenantResources(project.slug, {});
    await recordResourceAudit(session.email, project.slug, { action: 'clear-overrides', before });
    console.log(`[admin] resources for ${project.slug} cleared by ${session.email}`
      + (result ? `; quota ${result.quota}, limits ${result.limits}` : '; NOT applied (k8s disabled)'));

    const fresh = (await getProjectBySlug(project.slug)) ?? project;
    const message = result === null
      ? 'Overrides cleared, but Kubernetes integration is disabled on this deployment — the live quota was not touched.'
      : `Overrides cleared — reconciled to the platform defaults (ResourceQuota ${result.quota}, LimitRange ${result.limits}). A quota below current usage only blocks NEW pods; nothing is evicted.`;
    res.status(result === null ? 503 : 200).send(renderAdminProjectResourceDetail(
      await buildProjectResourceView(fresh),
      { ok: result !== null, message },
      session.email, csrf,
    ));
  } catch (err: any) {
    console.error('Clear project resources error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to clear overrides — see portal logs.'));
  }
});

// Help page linked from the resource form when a volume's StorageClass can't be
// expanded online — describes the manual data-migration path.
router.get('/help/storage', (req: Request, res: Response) => {
  res.send(renderStorageHelp(req.portalSession!.email));
});

// ── cooldeps gating policy ─────────────────────────────────────────────────
// Only mounted when the deployment runs cooldeps; otherwise 404 so the page
// (and its nav link) don't exist.

router.get('/cooldeps', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  if (!cooldepsEnabled()) {
    res.status(404).send(renderError('Not found', 'cooldeps is not enabled on this deployment.'));
    return;
  }
  try {
    const record = await loadCooldepsConfig();
    res.send(renderAdminCooldeps(record, null, session.email, csrfHiddenField(req, res)));
  } catch (err: any) {
    console.error('Admin cooldeps load error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to load cooldeps configuration.'));
  }
});

router.post('/cooldeps', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  if (!cooldepsEnabled()) {
    res.status(404).send(renderError('Not found', 'cooldeps is not enabled on this deployment.'));
    return;
  }
  const csrf = csrfHiddenField(req, res);
  const body = (req.body || {}) as Record<string, unknown>;

  // Validate first so a bad field re-renders the form with the typed values and
  // a clear message, without touching the DB or the cluster.
  let config;
  try {
    config = parseCooldepsConfig(body);
  } catch (err: any) {
    if (err instanceof CooldepsConfigError) {
      // Re-render with what they submitted (parse failed, so show defaults merged
      // with valid fields is overkill — show the persisted record + the error).
      const record = await loadCooldepsConfig().catch(() => null);
      res.status(400).send(renderAdminCooldeps(
        record ?? { config: DEFAULT_COOLDEPS_CONFIG, updatedAt: null, updatedBy: null, persisted: false },
        { ok: false, message: err.message }, session.email, csrf,
      ));
      return;
    }
    throw err;
  }

  try {
    await saveCooldepsConfig(config, session.email);
    const reconcile = await reconcileCooldepsConfig(config);
    console.log(`[admin] cooldeps policy updated by ${session.email} (applied=${reconcile.applied})`);
    const message = reconcile.applied
      ? 'Saved. cooldeps is restarting with the new policy.'
      : `Saved to the portal, but not applied to the cluster: ${reconcile.reason}.`;
    const record = await loadCooldepsConfig();
    res.send(renderAdminCooldeps(record, { ok: true, message }, session.email, csrf));
  } catch (err: any) {
    console.error('Admin cooldeps save error:', err?.message);
    // It may have persisted but failed to reconcile — reload so the form is truthful.
    const record = await loadCooldepsConfig().catch(() => null);
    res.status(500).send(renderAdminCooldeps(
      record ?? { config, updatedAt: null, updatedBy: null, persisted: false },
      { ok: false, message: 'Saved state may be partial — failed to apply to the cluster. See portal logs.' },
      session.email, csrf,
    ));
  }
});

export default router;
