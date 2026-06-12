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
  renderError,
  UserRow, AppRow,
} from '../templates';
import {
  seedCommunityCenterTemplate, communityCenterTemplateStatus,
} from '../services/template-seed';

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
    console.log(`[admin] user ${traits.email || targetId} deleted by ${session.email}: ` +
      `${result.projectsPurged} project(s), ${result.groupsDeleted} group(s), ${result.apiKeysRevoked} key(s)` +
      (result.errors.length ? `; ${result.errors.length} non-fatal error(s): ${result.errors.join('; ')}` : ''));
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
    const status = await communityCenterTemplateStatus();
    res.send(renderAdminTemplate(status, null, session.email, csrfHiddenField(req, res)));
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
    const status = await communityCenterTemplateStatus();
    res.send(renderAdminTemplate(status, result, session.email, csrfHiddenField(req, res)));
  } catch (err: any) {
    console.error('Admin template reset error:', err?.message);
    res.status(500).send(renderError('Error', 'Template reset failed — see portal logs.'));
  }
});

export default router;
