// Canonical Gitea login resolution for a human identity.
//
// The naive derivation — `preferred_username`, else the email local part — is
// NOT unique per identity: an admin-created user `bob` and a Google self-signup
// `bob@workspace.com` derive the same login `bob`. Gitea 409s the second create,
// and if a repo grant then stored that shared login, the grant would land on the
// FIRST identity's account (privilege misassignment — finding F2).
//
// resolveGiteaUsername picks the first login (base, then base-2, base-3, …) that
// is either free in Gitea or already owned by THIS identity's email, and writes
// it back to the identity's Kratos `preferred_username`. Provisioning runs at
// every account-creation path (admin create, Google webhook, lazy first
// dashboard hit), so by the time anyone can be granted access, their stored
// username addresses exactly one Gitea account. Every later reader
// (giteaUsernameForIdentity, the grant pickers, the collaborator reconciler)
// then reads that same canonical `preferred_username`.

import { Identity } from '@ory/client';
import { getGiteaUser, giteaEnabled } from './gitea';
import { updateIdentityTraits } from './kratos-admin';
import { isValidUsername, isReservedUsername } from './reserved-names';

// The base login candidate from an identity's traits (preferred_username, else
// the email local part). Null when neither yields a usable, non-reserved name.
export function deriveCandidateUsername(identity: { traits?: any }): string | null {
  const traits = (identity.traits ?? {}) as Record<string, any>;
  const candidate = traits.preferred_username
    || (typeof traits.email === 'string' && traits.email.includes('@') ? traits.email.split('@')[0] : null);
  if (!candidate || !isValidUsername(candidate) || isReservedUsername(candidate)) return null;
  return candidate;
}

// Resolve and persist the canonical, Gitea-unique login. Returns the chosen
// username, or null if no usable name can be derived. Best-effort on the Kratos
// write-back (a failure there is logged; ensureUser's collision check is the
// backstop that still prevents a wrong-account grant).
export async function resolveGiteaUsername(identity: Identity): Promise<string | null> {
  const traits = (identity.traits ?? {}) as Record<string, any>;
  const base = deriveCandidateUsername(identity);
  if (!base) return null;
  const current = typeof traits.preferred_username === 'string' ? traits.preferred_username : undefined;
  const email = typeof traits.email === 'string' ? traits.email.toLowerCase() : undefined;

  // Without Gitea wired up there are no accounts to collide with, so the base is
  // canonical; still persist it (when absent) so it stays stable later.
  let chosen: string | null = base;
  if (giteaEnabled()) {
    chosen = null;
    for (let n = 0; n <= 64; n++) {
      const candidate = n === 0 ? base : `${base}-${n}`;
      if (!isValidUsername(candidate) || isReservedUsername(candidate)) continue;
      let existing;
      try {
        existing = await getGiteaUser(candidate);
      } catch (e: any) {
        // Gitea hiccup mid-resolve: keep the existing/base name rather than
        // spinning. The collision-safe ensureUser is the create-time backstop.
        chosen = current || base;
        break;
      }
      if (!existing) { chosen = candidate; break; }                                  // free
      if (email && existing.email && existing.email.toLowerCase() === email) { chosen = candidate; break; } // already ours
      // taken by a DIFFERENT account → try the next suffix
    }
  }
  if (!chosen) return null;

  // Persist the canonical login so every later read agrees. The admin API
  // REPLACES /traits (not merges), so include email + name.
  if (chosen !== current) {
    try {
      await updateIdentityTraits(identity.id, {
        email: traits.email,
        preferred_username: chosen,
        ...(traits.name ? { name: traits.name } : {}),
      });
      // Keep the in-memory identity consistent for the rest of provisioning
      // (bot derivation + Gitea account creation read traits.preferred_username).
      (identity.traits as any).preferred_username = chosen;
    } catch (e: any) {
      console.warn('[gitea-identity] could not persist canonical username for', identity.id, e?.message);
    }
  }
  return chosen;
}
