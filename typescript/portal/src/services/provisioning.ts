// Platform-side provisioning for human identities: the EVERYONE membership
// grant, a paired `.bot` identity (+ BETA tier), and Gitea accounts.
//
// This used to be driven by a Kratos after-registration web_hook calling the
// portal. That coupling forced a shared secret into Kratos's config (which
// Kratos can't deliver cleanly for a nested hook list). Instead the portal — which
// already holds Kratos-admin, Keto, and Gitea-admin credentials — provisions the
// user itself, idempotently, the first time it sees them authenticated:
//   - admin-created users: synchronously at create time (routes/admin.ts), and
//   - self-service registrants: on their first authenticated request, via the
//     once-per-process trigger below (middleware/session.ts).
//
// Security note: ensureProvisioned operates ONLY on a canonical Kratos Identity
// (from a validated session or an admin-API create/lookup) — never on
// request-body data — so the login/registration path takes no untrusted input.

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

// Run ensureProvisioned at most once per (user, process). Safe to call on every
// authenticated request: after the first successful run it is a single Set
// membership check with no Kratos/Gitea round-trip. Fire-and-forget — the caller
// is NOT blocked (provisioning isn't needed to serve the current request; by the
// time a freshly-registered user navigates to anything that needs their bot/repo,
// the background pass has finished).
const provisioned = new Set<string>();   // completed this process
const inFlight = new Set<string>();       // currently running (dedupe concurrent first-hits)

export function provisionOncePerProcess(identity: Identity | undefined | null): void {
  const id = identity?.id;
  if (!id || provisioned.has(id) || inFlight.has(id)) return;
  inFlight.add(id);
  // identity is non-null here (id derived from it).
  ensureProvisioned(identity!)
    .then(() => { provisioned.add(id); })
    // On failure DON'T mark provisioned, so the user's next request retries.
    .catch((err: any) => { console.error('[provision] ensure failed', id, err?.message); })
    .finally(() => { inFlight.delete(id); });
}
