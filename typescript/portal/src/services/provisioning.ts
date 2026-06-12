// Platform-side provisioning for human identities: a paired `.bot` identity
// and Gitea accounts. Roles need no provisioning — a regular user carries no
// Keto tuple at all; admins are granted explicitly (bootstrap-admin.sh or the
// Admin → Users toggle).
//
// Accounts come to exist three ways, all funneling here:
//   1. an admin via routes/admin.ts (synchronous at create time),
//   2. Google Workspace self-signup via the Kratos after-registration webhook
//      (routes/internal.ts → ensureProvisionedById), and
//   3. lazily on first dashboard request (ensureProvisionedLazy), the backstop
//      for a webhook that flaked while Gitea/Kratos was briefly down.
// ensureProvisioned operates ONLY on a canonical Kratos Identity (fetched from
// the admin API) — never on request-body data.

import { Identity } from '@ory/client';
import { ensureBotForHuman, getIdentity } from './kratos-admin';
import { provisionGiteaForIdentities } from './gitea';
import { isReservedUsername } from './reserved-names';
import { addMemberToDefaultWriteRepos, giteaUsernameForIdentity } from './repo-access';

// Idempotent. Best-effort: each step is wrapped so a downstream hiccup (Gitea
// outage, Keto blip) can't abort the others or bubble out to the caller.
export async function ensureProvisioned(identity: Identity): Promise<void> {
  const meta = (identity.metadata_public ?? {}) as Record<string, any>;
  // Bots are created via the admin API and never need provisioning of their own.
  if (meta.type === 'bot') return;

  // Refuse reserved/admin names. Check the preferred_username trait AND the email
  // local-part, since the bot username is derived from the email when no
  // preferred_username is set (see deriveBotUsername). The Gitea-mint backstop
  // in services/gitea.ts is the load-bearing guard; this limits blast radius.
  const traits = (identity.traits ?? {}) as Record<string, any>;
  const emailLocalPart = typeof traits.email === 'string' && traits.email.includes('@')
    ? traits.email.split('@')[0]
    : undefined;
  if (isReservedUsername(traits.preferred_username) || isReservedUsername(emailLocalPart)) {
    console.warn('[provision] refusing reserved username', traits.preferred_username || emailLocalPart, identity.id);
    return;
  }

  let bot: Identity | null = null;
  try {
    bot = await ensureBotForHuman(identity);
  } catch (err: any) {
    console.error('[provision] bot provisioning failed', identity.id, err?.message);
  }

  try {
    await provisionGiteaForIdentities(identity, bot);
  } catch (err: any) {
    console.error('[provision] Gitea provisioning failed', identity.id, err?.message);
  }

  // Default-`write` repos advertise "any member can push"; Gitea has no such
  // switch, so each new member is fanned out as a write collaborator.
  try {
    const username = giteaUsernameForIdentity(identity);
    if (username) await addMemberToDefaultWriteRepos(username, identity.id);
  } catch (err: any) {
    console.error('[provision] default-write repo fan-out failed', identity.id, err?.message);
  }
}

// Re-fetch the canonical identity from the Kratos admin API and provision it.
// This is the webhook entrypoint (routes/internal.ts): the caller only names
// an identity id, everything else is verified against Kratos — so the hook
// needs no shared secret (a forged call can at worst trigger idempotent
// provisioning of a real identity).
export async function ensureProvisionedById(identityId: string): Promise<void> {
  const identity = await getIdentity(identityId);
  await ensureProvisioned(identity);
}

// Lazy backstop: provision on first sight of a session whose identity hasn't
// been through ensureProvisioned this process lifetime. Cheap (one Set lookup)
// on the hot path; the actual work runs at most once per user per process and
// is idempotent across processes.
const lazyProvisioned = new Set<string>();
export function ensureProvisionedLazy(identityId: string): void {
  if (!identityId || lazyProvisioned.has(identityId)) return;
  lazyProvisioned.add(identityId);
  ensureProvisionedById(identityId).catch((err: any) =>
    console.error('[provision] lazy provisioning failed', identityId, err?.message));
}
