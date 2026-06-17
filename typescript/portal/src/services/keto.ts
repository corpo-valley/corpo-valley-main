// Role model: a user is either an ADMIN or a regular user. The marker is a
// single Keto tuple — `groups:ADMIN#members@<userId>` — written by the chart's
// bootstrap-admin.sh for the first admin and by the portal's Admin → Users
// toggle for everyone else. Regular users carry NO tuple at all.
//
// Services (admin-registered OAuth clients) are either open to every signed-in
// user (no tuple) or admins-only (`services:<app>#access → groups:ADMIN#members`).
//
// This replaces the legacy four-level tier hierarchy (EVERYONE/BETA/ALPHA/
// ADMIN). Tuples for the retired groups may still exist in older deployments;
// they are ignored everywhere and deleted opportunistically when a user's
// role or a service's access is changed.

const ketoReadUrl = process.env.KETO_READ_URL || 'http://localhost:4466';
const ketoWriteUrl = process.env.KETO_WRITE_URL || 'http://localhost:4467';

const ADMIN_GROUP = 'ADMIN';
// Retired tier groups — only referenced for opportunistic tuple cleanup.
const LEGACY_GROUPS = ['EVERYONE', 'BETA', 'ALPHA'];

interface RelationTuple {
  namespace: string;
  object: string;
  relation: string;
  subject_id?: string;
  subject_set?: {
    namespace: string;
    object: string;
    relation: string;
  };
}

async function listRelations(params: Record<string, string>): Promise<{ relation_tuples: RelationTuple[] }> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${ketoReadUrl}/relation-tuples?${qs}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keto list failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<{ relation_tuples: RelationTuple[] }>;
}

// Same query as listRelations but surfaces Keto's pagination cursor so callers
// that need the FULL relation set (not just "does ≥1 exist") can page through
// it. Keto returns `next_page_token: ""` on the last page.
async function listRelationsPaged(
  params: Record<string, string>
): Promise<{ relation_tuples: RelationTuple[]; next_page_token?: string }> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${ketoReadUrl}/relation-tuples?${qs}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keto list failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { relation_tuples: RelationTuple[]; next_page_token?: string };
  return {
    relation_tuples: json.relation_tuples || [],
    next_page_token: json.next_page_token ? json.next_page_token : undefined,
  };
}

async function createRelation(tuple: RelationTuple): Promise<void> {
  const res = await fetch(`${ketoWriteUrl}/admin/relation-tuples`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tuple),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keto create failed (${res.status}): ${body}`);
  }
}

async function deleteRelation(params: Record<string, string>): Promise<void> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${ketoWriteUrl}/admin/relation-tuples?${qs}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Keto delete failed (${res.status}): ${body}`);
  }
}

// Every user id that carries the admin role. Mirrors isUserAdmin's query but
// lists the whole `groups:ADMIN#members` relation instead of filtering to one
// subject. Pages through Keto's relation-tuple list (default page size is
// small) so a large admin set isn't silently truncated; bots/groups never
// appear here because the admin marker is only ever written with a subject_id.
export async function listAdminUserIds(): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const params: Record<string, string> = {
      namespace: 'groups',
      object: ADMIN_GROUP,
      relation: 'members',
      'page_size': '500',
    };
    if (pageToken) params['page_token'] = pageToken;
    const { relation_tuples, next_page_token } = await listRelationsPaged(params);
    for (const t of relation_tuples) {
      if (t.subject_id && !seen.has(t.subject_id)) {
        seen.add(t.subject_id);
        ids.push(t.subject_id);
      }
    }
    if (!next_page_token) break;
    pageToken = next_page_token;
  }
  return ids;
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  const { relation_tuples } = await listRelations({
    namespace: 'groups',
    object: ADMIN_GROUP,
    relation: 'members',
    subject_id: userId,
  });
  return relation_tuples.length > 0;
}

// Grant or revoke the admin role. Also strips any legacy tier tuples the user
// still carries from before the admin/user model, so toggling a role leaves
// Keto clean.
export async function setUserAdmin(userId: string, admin: boolean): Promise<void> {
  if (admin) {
    await createRelation({
      namespace: 'groups',
      object: ADMIN_GROUP,
      relation: 'members',
      subject_id: userId,
    });
  } else {
    await deleteRelation({
      namespace: 'groups',
      object: ADMIN_GROUP,
      relation: 'members',
      subject_id: userId,
    });
  }
  for (const group of LEGACY_GROUPS) {
    await deleteRelation({
      namespace: 'groups',
      object: group,
      relation: 'members',
      subject_id: userId,
    });
  }
}

// True iff the service is restricted to admins. Legacy tier gates
// (EVERYONE/BETA/ALPHA subject sets) read as open.
export async function isServiceAdminOnly(appName: string): Promise<boolean> {
  const { relation_tuples } = await listRelations({
    namespace: 'services',
    object: appName,
    relation: 'access',
  });
  return relation_tuples.some(
    (t) => t.subject_set?.namespace === 'groups' && t.subject_set.object === ADMIN_GROUP
  );
}

// Restrict a service to admins (or open it to all signed-in users). Clears
// any legacy tier gate either way.
export async function setServiceAdminOnly(appName: string, adminOnly: boolean): Promise<void> {
  for (const group of [ADMIN_GROUP, ...LEGACY_GROUPS]) {
    if (adminOnly && group === ADMIN_GROUP) continue;
    await deleteRelation({
      namespace: 'services',
      object: appName,
      relation: 'access',
      'subject_set.namespace': 'groups',
      'subject_set.object': group,
      'subject_set.relation': 'members',
    });
  }
  if (adminOnly) {
    await createRelation({
      namespace: 'services',
      object: appName,
      relation: 'access',
      subject_set: {
        namespace: 'groups',
        object: ADMIN_GROUP,
        relation: 'members',
      },
    });
  }
}

export async function listAllServices(): Promise<{ name: string; adminOnly: boolean }[]> {
  const { relation_tuples } = await listRelations({
    namespace: 'services',
    relation: 'access',
  });
  const services = new Map<string, boolean>();
  for (const tuple of relation_tuples) {
    if (tuple.subject_set?.namespace !== 'groups') continue;
    const adminOnly = tuple.subject_set.object === ADMIN_GROUP;
    services.set(tuple.object, (services.get(tuple.object) ?? false) || adminOnly);
  }
  return [...services.entries()].map(([name, adminOnly]) => ({ name, adminOnly }));
}

// Authoritative per-service access decision. Gates OAuth consent for
// admin-registered service clients (see routes/hydra.ts): a service with no
// access tuple (or only a legacy tier tuple) is open to every signed-in user;
// an admins-only service requires the ADMIN role. Throws on a Keto error so
// callers fail closed (no token issued) rather than guessing.
export async function userCanAccessService(userId: string, appName: string): Promise<boolean> {
  if (!(await isServiceAdminOnly(appName))) return true;
  return isUserAdmin(userId);
}
