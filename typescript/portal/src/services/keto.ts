import { Tier, TIERS, highestTier, hasAccess } from './tiers';

const ketoReadUrl = process.env.KETO_READ_URL || 'http://localhost:4466';
const ketoWriteUrl = process.env.KETO_WRITE_URL || 'http://localhost:4467';

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

export async function getUserTier(userId: string): Promise<Tier> {
  const { relation_tuples } = await listRelations({
    namespace: 'groups',
    relation: 'members',
    subject_id: userId,
  });
  const tiers = relation_tuples
    .map((t) => t.object)
    .filter((obj): obj is Tier => TIERS.includes(obj as Tier));
  return highestTier(tiers);
}

export async function removeUserFromAllTiers(userId: string): Promise<void> {
  for (const tier of TIERS) {
    await deleteRelation({
      namespace: 'groups',
      object: tier,
      relation: 'members',
      subject_id: userId,
    });
  }
}

export async function setUserTier(userId: string, tier: Tier): Promise<void> {
  await removeUserFromAllTiers(userId);
  await createRelation({
    namespace: 'groups',
    object: tier,
    relation: 'members',
    subject_id: userId,
  });
}

// Grant the EVERYONE base tier without first wiping the user's other tiers.
// Used when bootstrapping a freshly-created human so they're a member of the
// EVERYONE group on top of whatever else admin assigns.
export async function grantEveryone(userId: string): Promise<void> {
  await createRelation({
    namespace: 'groups',
    object: 'EVERYONE',
    relation: 'members',
    subject_id: userId,
  });
}

export async function getServiceTier(appName: string): Promise<Tier | null> {
  const { relation_tuples } = await listRelations({
    namespace: 'services',
    object: appName,
    relation: 'access',
  });
  for (const tuple of relation_tuples) {
    if (tuple.subject_set?.namespace === 'groups') {
      const obj = tuple.subject_set.object;
      if (TIERS.includes(obj as Tier)) return obj as Tier;
    }
  }
  return null;
}

export async function setServiceTier(appName: string, tier: Tier): Promise<void> {
  // Remove existing service-tier relationships
  for (const t of TIERS) {
    await deleteRelation({
      namespace: 'services',
      object: appName,
      relation: 'access',
      'subject_set.namespace': 'groups',
      'subject_set.object': t,
      'subject_set.relation': 'members',
    });
  }
  await createRelation({
    namespace: 'services',
    object: appName,
    relation: 'access',
    subject_set: {
      namespace: 'groups',
      object: tier,
      relation: 'members',
    },
  });
}

export async function listAllServices(): Promise<{ name: string; tier: Tier }[]> {
  const { relation_tuples } = await listRelations({
    namespace: 'services',
    relation: 'access',
  });
  const services: { name: string; tier: Tier }[] = [];
  for (const tuple of relation_tuples) {
    if (tuple.subject_set?.namespace === 'groups') {
      const tierName = tuple.subject_set.object;
      if (TIERS.includes(tierName as Tier)) {
        services.push({ name: tuple.object, tier: tierName as Tier });
      }
    }
  }
  return services;
}

// Authoritative per-service access decision. Gates OAuth consent for
// admin-registered service clients (see routes/hydra.ts): a service's required
// tier is the `services/<app>/access -> groups:<tier>#members` tuple written by
// setServiceTier. Tiers are HIERARCHICAL (ADMIN > ALPHA > BETA > EVERYONE), so
// we compare the user's effective tier RANK against the service's required tier
// rather than testing literal Keto group membership — a Keto subject_id check
// would deny an ADMIN user a BETA-gated service because the user is only a
// literal member of their own tier group plus EVERYONE, not of every lower
// group. A service with no tier tuple is open to EVERYONE. Throws on a Keto
// error so callers fail closed (no token issued) rather than guessing.
export async function userCanAccessService(userId: string, appName: string): Promise<boolean> {
  const required = await getServiceTier(appName);
  if (!required) return true; // no tier configured → open to everyone
  const userTier = await getUserTier(userId);
  return hasAccess(userTier, required);
}
