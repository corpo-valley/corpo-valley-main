// Platform-side provisioning for human identities: the EVERYONE membership
// grant, a paired `.bot` identity (+ BETA tier), and Gitea accounts.
//
// Self-service registration is disabled, so the only way an account is created
// is an admin via routes/admin.ts, which calls this synchronously at create
// time. ensureProvisioned operates ONLY on a canonical Kratos Identity (the
// admin-API create result) — never on request-body data.

import { Identity } from '@ory/client';
import { ensureBotForHuman } from './kratos-admin';
import { setUserTier, grantEveryone } from './keto';
import { provisionGiteaForIdentities } from './gitea';
import { isReservedUsername } from './reserved-names';

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

  try {
    await grantEveryone(identity.id);
  } catch (err: any) {
    console.error('[provision] grantEveryone failed', identity.id, err?.message);
  }

  let bot: Identity | null = null;
  try {
    bot = await ensureBotForHuman(identity);
    if (bot) await setUserTier(bot.id, 'BETA');
  } catch (err: any) {
    console.error('[provision] bot provisioning failed', identity.id, err?.message);
  }

  try {
    await provisionGiteaForIdentities(identity, bot);
  } catch (err: any) {
    console.error('[provision] Gitea provisioning failed', identity.id, err?.message);
  }
}
