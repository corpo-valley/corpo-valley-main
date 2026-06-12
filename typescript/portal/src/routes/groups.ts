// Self-serve groups (decision D1, docs/decisions/2026-06-12-…md): any member
// can create a group and manage its members; platform admins can manage any
// group. Groups are org-visible so project owners can grant them access.
// Group membership feeds the Gitea collaborator reconciler: changing members
// re-converges every project repo the group is granted on (best-effort, in
// the background — site permissions need no sync, they're resolved live).

import { Router, Request, Response } from 'express';
import { requireSession, requireVerifiedEmail } from '../middleware/session';
import { csrfHiddenField } from '../middleware/csrf';
import { isUserAdmin } from '../services/keto';
import {
  createGroup, getGroupById, listGroups, deleteGroup, isValidGroupName,
  listGroupMembers, addGroupMember, removeGroupMember, listProjectsGrantedToGroup,
} from '../services/access';
import { syncRepoAccess, syncProjectsForGroup, giteaUsernameForIdentity } from '../services/repo-access';
import { findIdentityByEmail, findIdentityByUsername } from '../services/kratos-admin';
import { renderGroups, renderGroupDetail, renderError } from '../templates';

const router = Router();

router.use(requireSession);

// GET /groups — every group, with owner/member-count context for grantors.
router.get('/groups', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const isAdmin = await isUserAdmin(session.id);
    const groups = await listGroups();
    const csrf = csrfHiddenField(req, res);
    res.send(renderGroups(session.email, isAdmin, session.id, groups, csrf));
  } catch (err: any) {
    console.error('Groups list error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to load groups.'));
  }
});

// POST /groups — create a group owned by the caller. Group mutations require a
// verified email (parity with project/provisioning routes): an unverified
// self-registered user must not be able to mutate real Gitea collaborators via
// group membership changes on projects a group is granted.
router.post('/groups', requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const name = String(req.body?.name || '').trim().toLowerCase();
  const fail = async (msg: string, status = 400) => {
    const isAdmin = await isUserAdmin(session.id).catch(() => false);
    const groups = await listGroups().catch(() => []);
    const csrf = csrfHiddenField(req, res);
    res.status(status).send(renderGroups(session.email, isAdmin, session.id, groups, csrf, msg));
  };
  if (!isValidGroupName(name)) {
    return fail('Group name must be lowercase letters, digits, dots, dashes, or underscores (max 64 chars), and not a reserved word.');
  }
  try {
    const group = await createGroup(name, session.id);
    res.redirect(`/groups/${group.id}`);
  } catch (err: any) {
    if (err?.code === '23505') return fail(`Group "${name}" already exists.`, 409);
    console.error('Group create error:', err?.message);
    fail('Failed to create group.', 500);
  }
});

// The creator manages their group; platform admins can manage any.
async function canManageGroup(group: { owner_id: string }, userId: string): Promise<boolean> {
  if (group.owner_id === userId) return true;
  return isUserAdmin(userId).catch(() => false);
}

// GET /groups/:id — members + management controls.
router.get('/groups/:id', async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const group = await getGroupById(req.params.id);
    if (!group) {
      res.status(404).send(renderError('Not Found', 'Group not found.'));
      return;
    }
    const isAdmin = await isUserAdmin(session.id);
    const members = await listGroupMembers(group.id);
    const csrf = csrfHiddenField(req, res);
    const manageable = group.owner_id === session.id || isAdmin;
    res.send(renderGroupDetail(session.email, isAdmin, group, members, manageable, csrf));
  } catch (err: any) {
    console.error('Group detail error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to load group.'));
  }
});

// POST /groups/:id/members — add a member by email or username.
router.post('/groups/:id/members', requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  const identifier = String(req.body?.identifier || '').trim();
  try {
    const group = await getGroupById(req.params.id);
    if (!group) {
      res.status(404).send(renderError('Not Found', 'Group not found.'));
      return;
    }
    if (!(await canManageGroup(group, session.id))) {
      res.status(403).send(renderError('Forbidden', 'Only the group owner or a platform admin can manage members.'));
      return;
    }
    if (!identifier || identifier.length > 254) {
      res.status(400).send(renderError('Invalid Input', 'Provide a member email or username.'));
      return;
    }
    const identity = identifier.includes('@')
      ? await findIdentityByEmail(identifier)
      : await findIdentityByUsername(identifier);
    if (!identity) {
      res.status(404).send(renderError('Not Found', `No Corpo Valley member matches "${identifier}".`));
      return;
    }
    const meta = (identity.metadata_public ?? {}) as Record<string, any>;
    if (meta.type === 'bot') {
      res.status(400).send(renderError('Invalid Member', 'Bot identities cannot be group members.'));
      return;
    }
    const traits = (identity.traits ?? {}) as Record<string, any>;
    await addGroupMember({
      groupId: group.id,
      userId: identity.id,
      username: giteaUsernameForIdentity(identity),
      email: traits.email || null,
    });
    // Membership changed → re-converge repos this group is granted on.
    syncProjectsForGroup(group.id).catch((e: any) =>
      console.error('[groups] repo sync after member add failed:', e?.message));
    res.redirect(`/groups/${group.id}`);
  } catch (err: any) {
    console.error('Group member add error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to add member.'));
  }
});

// POST /groups/:id/members/:userId/remove
router.post('/groups/:id/members/:userId/remove', requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const group = await getGroupById(req.params.id);
    if (!group) {
      res.status(404).send(renderError('Not Found', 'Group not found.'));
      return;
    }
    if (!(await canManageGroup(group, session.id))) {
      res.status(403).send(renderError('Forbidden', 'Only the group owner or a platform admin can manage members.'));
      return;
    }
    await removeGroupMember(group.id, String(req.params.userId || ''));
    syncProjectsForGroup(group.id).catch((e: any) =>
      console.error('[groups] repo sync after member remove failed:', e?.message));
    res.redirect(`/groups/${group.id}`);
  } catch (err: any) {
    console.error('Group member remove error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to remove member.'));
  }
});

// POST /groups/:id/delete — removes the group AND every grant that points at
// it. Affected repos are re-converged after the grants are gone.
router.post('/groups/:id/delete', requireVerifiedEmail, async (req: Request, res: Response) => {
  const session = req.portalSession!;
  try {
    const group = await getGroupById(req.params.id);
    if (!group) {
      res.status(404).send(renderError('Not Found', 'Group not found.'));
      return;
    }
    if (!(await canManageGroup(group, session.id))) {
      res.status(403).send(renderError('Forbidden', 'Only the group owner or a platform admin can delete a group.'));
      return;
    }
    // Snapshot the repo-granted projects BEFORE the grants are deleted, so we
    // know which repos to strip the (now former) members from.
    const affected = await listProjectsGrantedToGroup(group.id).catch(() => []);
    await deleteGroup(group.id);
    for (const project of affected) {
      syncRepoAccess(project).catch((e: any) =>
        console.error(`[groups] repo sync after group delete failed for ${project.slug}:`, e?.message));
    }
    res.redirect('/groups');
  } catch (err: any) {
    console.error('Group delete error:', err?.message);
    res.status(500).send(renderError('Error', 'Failed to delete group.'));
  }
});

export default router;
