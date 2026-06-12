// Admin user-delete cascade. Tears down a human identity and everything the
// platform attached to it:
//   - owned projects   → full external purge (repo + namespace + Argo app) + DB row
//   - owned groups     → deleted (drops their grants); projects that granted the
//                        group are re-converged so its other members lose access
//   - memberships      → stripped from every group the user belonged to
//   - direct grants    → every user-subject grant naming them is deleted
//   - API keys         → revoked (Hydra clients)
//   - admin role       → Keto tuple removed
//   - paired .bot       → Kratos identity + Gitea account deleted
//   - the human itself → Kratos identity + Gitea account deleted
//
// Best-effort and idempotent per step (mirrors the project cascade): a partial
// failure is collected and surfaced, never aborting the rest, so a retry of the
// same delete completes the teardown. The acting admin must never reach here for
// their OWN id, and bot identities are deleted only as part of their human's
// cascade — both guarded by the caller (routes/admin.ts).

import { Identity } from '@ory/client';
import { listProjectsByOwner, deleteProject } from './projects';
import {
  listGroupsByOwner, deleteGroup, listProjectsGrantedToGroup,
  removeUserFromAllGroups, deleteUserGrants,
} from './access';
import { syncRepoAccess, giteaUsernameForIdentity } from './repo-access';
import { purgeProjectResources } from './project-purge';
import { deleteGiteaUser } from './gitea';
import { deleteIdentity, findBotForHuman } from './kratos-admin';
import { setUserAdmin } from './keto';
import { listUserApiKeys, deleteClient } from './hydra-admin';

export interface UserDeleteResult {
  projectsPurged: number;
  groupsDeleted: number;
  apiKeysRevoked: number;
  errors: string[];
  // True iff the Kratos identity (the login + the only handle the cascade can
  // be retried from) was actually deleted. False means a credential-bearing
  // teardown step failed and the identity was deliberately KEPT so the admin can
  // re-run the delete — see the gate on step 7.
  identityDeleted: boolean;
}

export async function deleteUserCascade(human: Identity): Promise<UserDeleteResult> {
  const result: UserDeleteResult = {
    projectsPurged: 0, groupsDeleted: 0, apiKeysRevoked: 0, errors: [], identityDeleted: false,
  };
  const userId = human.id;
  const humanUsername = giteaUsernameForIdentity(human);
  // Tracks whether every CREDENTIAL-bearing teardown (API keys, Gitea accounts —
  // the things that grant access independently of the Kratos identity, e.g. a
  // Gitea PAT the user minted) succeeded. We only delete the Kratos identity if
  // it did: deleting the identity is the irreversible step that loses the handle
  // the cascade re-derives usernames from, so doing it while a Gitea account
  // still lives would orphan that account (and its PATs) with no way to retry.
  let credentialTeardownOk = true;

  // 1. Owned projects — full external purge, then DB row.
  try {
    for (const project of await listProjectsByOwner(userId)) {
      try {
        const purge = await purgeProjectResources(project);
        if (purge.errors.length) result.errors.push(`project ${project.slug}: ${purge.errors.join('; ')}`);
        await deleteProject(project.id);
        result.projectsPurged++;
      } catch (e: any) { result.errors.push(`project ${project.slug}: ${e?.message}`); }
    }
  } catch (e: any) { result.errors.push(`list owned projects: ${e?.message}`); }

  // 2. Owned groups — delete each (drops its grants too), then re-converge the
  //    other projects that granted the group so its remaining members lose the
  //    access that group conferred.
  try {
    for (const group of await listGroupsByOwner(userId)) {
      try {
        const affected = await listProjectsGrantedToGroup(group.id).catch(() => []);
        await deleteGroup(group.id);
        result.groupsDeleted++;
        for (const project of affected) {
          syncRepoAccess(project).catch((e: any) =>
            console.error(`[user-delete] repo sync after group delete failed for ${project.slug}:`, e?.message));
        }
      } catch (e: any) { result.errors.push(`group ${group.name}: ${e?.message}`); }
    }
  } catch (e: any) { result.errors.push(`list owned groups: ${e?.message}`); }

  // 3. Memberships in others' groups + direct user grants (DB cleanup; the Gitea
  //    account purge in step 6 drops the corresponding collaborator rows).
  try { await removeUserFromAllGroups(userId); }
  catch (e: any) { result.errors.push(`remove memberships: ${e?.message}`); }
  try { await deleteUserGrants(userId); }
  catch (e: any) { result.errors.push(`delete grants: ${e?.message}`); }

  // 4. API keys (Hydra clients).
  try {
    for (const key of await listUserApiKeys(userId)) {
      try { await deleteClient(key.client_id || ''); result.apiKeysRevoked++; }
      catch (e: any) { result.errors.push(`api key ${key.client_id}: ${e?.message}`); credentialTeardownOk = false; }
    }
  } catch (e: any) { result.errors.push(`list api keys: ${e?.message}`); credentialTeardownOk = false; }

  // 5. Admin role tuple (no-op for a regular user).
  try { await setUserAdmin(userId, false); }
  catch (e: any) { result.errors.push(`revoke admin role: ${e?.message}`); }

  // 6. Gitea accounts — bot first, then human (purge reaps any straggler repos).
  //    The bot's login comes straight off its trait (giteaUsernameForIdentity
  //    refuses `.bot` names); deleteGiteaUser(allowBot) permits exactly it.
  const bot = await findBotForHuman(human).catch(() => null);
  const botTraits = (bot?.traits ?? {}) as Record<string, any>;
  const botUsername = typeof botTraits.preferred_username === 'string' ? botTraits.preferred_username : null;
  if (botUsername) {
    try { await deleteGiteaUser(botUsername, { allowBot: true }); }
    catch (e: any) { result.errors.push(`gitea bot ${botUsername}: ${e?.message}`); credentialTeardownOk = false; }
  }
  if (humanUsername) {
    try { await deleteGiteaUser(humanUsername); }
    catch (e: any) { result.errors.push(`gitea user ${humanUsername}: ${e?.message}`); credentialTeardownOk = false; }
  }

  // 7. Kratos identities — bot first (its human_id points back here), then human.
  //    ONLY if the credential-bearing teardown succeeded: otherwise we keep the
  //    identity so the admin can re-run the cascade (a retry re-derives the
  //    Gitea username from it). Deleting it now would strand a live Gitea
  //    account + its PATs with no handle to reap them — a zombie-access window.
  if (credentialTeardownOk) {
    if (bot) {
      try { await deleteIdentity(bot.id); }
      catch (e: any) { result.errors.push(`delete bot identity: ${e?.message}`); }
    }
    try {
      await deleteIdentity(userId);
      result.identityDeleted = true;
    } catch (e: any) { result.errors.push(`delete identity: ${e?.message}`); }
  } else {
    result.errors.push('kept the Kratos identity for retry: credential teardown (API keys / Gitea accounts) did not fully succeed');
  }

  return result;
}
