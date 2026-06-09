import { Router, Request, Response } from 'express';
import { requireSession } from '../middleware/session';
import { requireAdmin } from '../middleware/requireAdmin';
import { csrfHiddenField } from '../middleware/csrf';
import { getUserTier, setUserTier, setServiceTier } from '../services/keto';
import {
  listIdentities, getIdentity, createIdentity, updateIdentityTraits,
  createRecoveryCodeForIdentity,
} from '../services/kratos-admin';
import { listClients, getClient, getClientTier, createClient, deleteClient, updateClientMetadata, API_KEY_TYPE } from '../services/hydra-admin';
import { ensureProvisioned } from '../services/provisioning';
import { isReservedUsername, isValidUsername } from '../services/reserved-names';
import { isTier, Tier } from '../services/tiers';
import {
  renderAdminUsers, renderAdminUserDetail, renderAdminUserCreate,
  renderAdminRecoveryResult, renderAdminApps,
  renderAdminRegisterForm, renderAdminRegisterResult, renderError,
  UserRow, AppRow,
} from '../templates';

const router = Router();

// All admin routes require session + admin
router.use(requireSession, requireAdmin);

// ── Users ──────────────────────────────────────────────────

function toUserRow(identity: { id: string; state?: string; traits?: any }, tier: string): UserRow {
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
    tier,
  };
}

router.get('/users', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const page = parseInt(req.query.page as string) || 0;

  try {
    const { identities, hasMore } = await listIdentities(page, 25);

    const users: UserRow[] = await Promise.all(
      identities.map(async (identity) => {
        let tier = 'EVERYONE';
        try { tier = await getUserTier(identity.id); } catch { /* default */ }
        return toUserRow(identity, tier);
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
    // Provision EVERYONE grant + paired .bot identity + Gitea accounts. Shared,
    // idempotent, best-effort — same path self-service registrants hit on first
    // login (services/provisioning.ts). Awaited here so the admin sees a fully
    // provisioned user on redirect.
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
    const tier = await getUserTier(identity.id);
    const csrf = csrfHiddenField(req, res);
    res.send(renderAdminUserDetail(toUserRow(identity, tier), session.email, csrf));
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
    const tier = await getUserTier(identity.id);
    const recovery = await createRecoveryCodeForIdentity(identity.id);
    res.send(renderAdminRecoveryResult(
      toUserRow(identity, tier),
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

router.post('/users/:id/tier', async (req: Request, res: Response) => {
  const tier = req.body?.tier;
  if (!tier || !isTier(tier)) {
    res.status(400).send(renderError('Invalid Tier', 'Tier must be EVERYONE, BETA, ALPHA, or ADMIN.'));
    return;
  }

  try {
    await setUserTier(req.params.id, tier as Tier);
    res.redirect(`/admin/users/${req.params.id}`);
  } catch (err: any) {
    console.error('Set tier error:');
    res.status(500).send(renderError('Error', 'Failed to update tier.'));
  }
});

// ── Apps / Services ────────────────────────────────────────

router.get('/apps', async (req: Request, res: Response) => {
  const session = req.portalSession!;

  try {
    const clients = await listClients();
    const apps: AppRow[] = clients
      .filter(c => {
        const meta = c.metadata as Record<string, string> | undefined;
        return meta?.type !== API_KEY_TYPE; // exclude user API keys
      })
      .map(c => ({
        clientId: c.client_id || '',
        clientName: c.client_name || c.client_id || '',
        tier: getClientTier(c),
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
// Deleting or re-tiering these silently changes the platform's security posture,
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

router.post('/apps/:appId/tier', async (req: Request, res: Response) => {
  const tier = req.body?.tier;
  if (!tier || !isTier(tier)) {
    res.status(400).send(renderError('Invalid Tier', 'Tier must be EVERYONE, BETA, ALPHA, or ADMIN.'));
    return;
  }

  try {
    const { appId } = req.params;
    if (!(await loadManageableServiceClient(appId, res))) return;
    await setServiceTier(appId, tier as Tier);
    await updateClientMetadata(appId, { tier });
    res.redirect('/admin/apps');
  } catch (err: any) {
    console.error('Set app tier error:');
    res.status(500).send(renderError('Error', 'Failed to update service tier.'));
  }
});

router.get('/apps/register', async (req: Request, res: Response) => {
  const csrf = csrfHiddenField(req, res);
  res.send(renderAdminRegisterForm(req.portalSession!.email, csrf));
});

router.post('/apps/register', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const { appName, displayName, tier, redirectUri } = req.body || {};

  if (!appName || !displayName || !tier || !isTier(tier)) {
    res.status(400).send(renderError('Invalid Input', 'App name, display name, and valid tier are required.'));
    return;
  }

  try {
    const redirectUris = redirectUri
      ? [redirectUri]
      : [`https://${appName}.corpo-valley.com/auth/callback`];

    const { client, secret } = await createClient({
      id: appName,
      name: displayName,
      tier,
      redirectUris,
      grantTypes: ['authorization_code', 'refresh_token'],
      metadata: { tier },
    });

    await setServiceTier(appName, tier as Tier);

    res.send(renderAdminRegisterResult(client.client_id || appName, secret, tier, session.email));
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

export default router;
