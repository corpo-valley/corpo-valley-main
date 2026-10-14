import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Identity } from '@ory/client';
import type { Project } from './projects';
import {
  planOwnershipTransfer, summarizeTransferAudit, executeOwnershipTransfer,
  describeIdentity, TransferDeps, TransferTarget, CV_PROJECTS_ARGOCD_NAMESPACE,
} from './ownership-transfer';

const project: Project = {
  id: 'p-1', slug: 'shop', name: 'Shop', owner_id: 'u-alice', created_at: '2026-01-01T00:00:00Z',
  status: 'ready', gitea_repo: 'alice/shop', postgres_password: null, garage_creds: null,
  pin_token_hash: null, resource_overrides: null, resource_overrides_updated_at: null,
  resource_overrides_updated_by: null,
};

function identity(id: string, traits: Record<string, unknown>, meta: Record<string, unknown> = {}, state = 'active'): Identity {
  return { id, traits, metadata_public: meta, state } as unknown as Identity;
}
const bob = identity('u-bob', { email: 'bob@example.com', preferred_username: 'bob' });
const alice = identity('u-alice', { email: 'alice@example.com', preferred_username: 'alice' });

const okTarget: TransferTarget = { id: 'u-bob', email: 'bob@example.com', username: 'bob', isBot: false, state: 'active' };

// ── planOwnershipTransfer ────────────────────────────────────────────────

test('plan: accepts a ready project, a human target and a matching confirm slug', () => {
  assert.deepEqual(planOwnershipTransfer(project, okTarget, ' shop '), { ok: true });
});

test('plan: rejects a wrong confirm slug first', () => {
  const r = planOwnershipTransfer(project, okTarget, 'shpo');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /slug/);
});

test('plan: rejects target == current owner', () => {
  const r = planOwnershipTransfer(project, { ...okTarget, id: 'u-alice' }, 'shop');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /already owns/);
});

test('plan: rejects bots, inactive accounts and targets without an email', () => {
  for (const [t, re] of [
    [{ ...okTarget, isBot: true }, /Bot/],
    [{ ...okTarget, state: 'inactive' }, /inactive/],
    [{ ...okTarget, email: null }, /no email/],
  ] as Array<[TransferTarget, RegExp]>) {
    const r = planOwnershipTransfer(project, t, 'shop');
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, re);
  }
});

test('plan: rejects projects that are not ready or have no repo', () => {
  const r1 = planOwnershipTransfer({ ...project, status: 'provisioning' }, okTarget, 'shop');
  assert.equal(r1.ok, false);
  assert.match((r1 as { reason: string }).reason, /provisioning/);
  const r2 = planOwnershipTransfer({ ...project, gitea_repo: null }, okTarget, 'shop');
  assert.equal(r2.ok, false);
  assert.match((r2 as { reason: string }).reason, /no Gitea repository/);
});

test('describeIdentity flags bots and missing traits', () => {
  assert.equal(describeIdentity(identity('b', { email: 'x@y' }, { type: 'bot' })).isBot, true);
  const d = describeIdentity(identity('n', {}));
  assert.equal(d.email, null);
  assert.equal(d.username, null);
});

// ── summarizeTransferAudit ───────────────────────────────────────────────

test('audit summary names both owners, repos and the keep-admin choice', () => {
  const s = summarizeTransferAudit({
    action: 'transfer-ownership', fromEmail: 'alice@example.com', toEmail: 'bob@example.com',
    giteaFrom: 'alice/shop', giteaTo: 'bob/shop', keptPreviousOwnerAsAdmin: true,
  });
  assert.equal(s, 'ownership transferred alice@example.com → bob@example.com (Gitea alice/shop → bob/shop); previous owner kept as admin');
});

test('audit summary lists partial failures', () => {
  const s = summarizeTransferAudit({
    fromEmail: 'a', toEmail: 'b', giteaFrom: 'a/x', giteaTo: 'b/x', keptPreviousOwnerAsAdmin: false,
    partial: ['argo not repointed'],
  });
  assert.match(s, /previous owner access removed; 1 step\(s\) need attention: argo not repointed/);
});

// ── executeOwnershipTransfer (fake deps) ────────────────────────────────

function fakeDeps(overrides: Partial<TransferDeps> = {}) {
  const calls: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const deps: TransferDeps = {
    giteaEnabled: () => true,
    k8sEnabled: () => true,
    getIdentity: async (id) => { calls.push(`getIdentity:${id}`); return alice; },
    ensureProvisioned: async (i) => { calls.push(`ensureProvisioned:${i.id}`); },
    giteaUsernameFor: (i) => ((i.traits as any).preferred_username as string) || null,
    getGiteaUser: async (u) => { calls.push(`getGiteaUser:${u}`); return { login: u, email: `${u}@example.com` }; },
    transferRepo: async (o) => { calls.push(`transferRepo:${o.owner}/${o.repo}->${o.newOwner}`); return { fullName: `${o.newOwner}/${o.repo}` }; },
    setProjectOwner: async (id, owner, repo) => { calls.push(`setProjectOwner:${id}:${owner}:${repo}`); },
    findGrantBySubject: async (_p, _t, s) => { calls.push(`findGrant:${s}`); return s === 'u-bob' ? { id: 'g-bob' } : null; },
    deleteGrant: async (id) => { calls.push(`deleteGrant:${id}`); },
    setGrantFacet: async (i) => { calls.push(`setGrantFacet:${i.subjectId}:${i.facet}:${i.level}:${i.giteaUsername}`); return {}; },
    syncRepoAccess: async (p) => { calls.push(`syncRepoAccess:${p.gitea_repo}:${p.owner_id}`); return { skipped: false, added: ['alice:admin'], removed: [], errors: [] }; },
    patchArgoRepoUrl: async (o) => { calls.push(`patchArgo:${o.namespace}/${o.name}:${o.repoUrl}`); },
    recordAudit: async (_a, scope, change) => { calls.push(`audit:${scope}`); audits.push(change); },
    log: () => {}, error: () => {},
    ...overrides,
  };
  return { deps, calls, audits };
}

const input = { project, target: bob, actorEmail: 'admin@example.com', keepPreviousOwnerAsAdmin: true, confirmSlug: 'shop' };

test('execute: happy path runs the steps in order and audits once', async () => {
  const { deps, calls, audits } = fakeDeps();
  const out = await executeOwnershipTransfer(input, deps);
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.project.owner_id, 'u-bob');
  assert.equal(out.project.gitea_repo, 'bob/shop');
  const order = calls.filter((c) => !c.startsWith('getIdentity') && !c.startsWith('getGiteaUser'));
  assert.deepEqual(order, [
    'ensureProvisioned:u-bob',
    'transferRepo:alice/shop->bob',
    'setProjectOwner:p-1:u-bob:bob/shop',
    'findGrant:u-bob',
    'deleteGrant:g-bob',
    'setGrantFacet:u-alice:site:admin:alice',
    'setGrantFacet:u-alice:repo:admin:alice',
    'syncRepoAccess:bob/shop:u-bob',
    `patchArgo:${CV_PROJECTS_ARGOCD_NAMESPACE}/shop:http://gitea.cv-gitea.svc.cluster.local/bob/shop.git`,
    'audit:shop',
  ]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'transfer-ownership');
  assert.equal(audits[0].toOwnerId, 'u-bob');
  assert.equal(audits[0].giteaTo, 'bob/shop');
  assert.equal(audits[0].keptPreviousOwnerAsAdmin, true);
  assert.equal(audits[0].partial, undefined);
  assert.ok(out.details.some((d) => /next build pushes .*bob\/shop/.test(d)), 'image-path note present');
});

test('execute: unchecked keep-previous-owner grants nothing to the old owner', async () => {
  const { deps, calls } = fakeDeps();
  const out = await executeOwnershipTransfer({ ...input, keepPreviousOwnerAsAdmin: false }, deps);
  assert.equal(out.ok, true);
  assert.ok(!calls.some((c) => c.startsWith('setGrantFacet')));
  assert.ok(out.details.some((d) => /no longer has access/.test(d)));
});

test('execute: a validation failure changes nothing', async () => {
  const { deps, calls } = fakeDeps();
  const out = await executeOwnershipTransfer({ ...input, confirmSlug: 'nope' }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.changed, false);
  assert.deepEqual(calls, []);
});

test('execute: a Gitea refusal leaves the DB untouched', async () => {
  const { deps, calls } = fakeDeps({ transferRepo: async () => { throw new Error('403 forbidden'); } });
  const out = await executeOwnershipTransfer(input, deps);
  assert.equal(out.ok, false);
  assert.equal(out.changed, false);
  assert.match(out.message, /403 forbidden/);
  assert.ok(!calls.some((c) => c.startsWith('setProjectOwner') || c.startsWith('audit')));
});

test('execute: a Gitea account with a different email is refused before any transfer', async () => {
  const { deps, calls } = fakeDeps({ getGiteaUser: async (u) => ({ login: u, email: 'someone-else@example.com' }) });
  const out = await executeOwnershipTransfer(input, deps);
  assert.equal(out.ok, false);
  assert.match(out.message, /different email/);
  assert.ok(!calls.some((c) => c.startsWith('transferRepo')));
});

test('execute: a DB failure after the Gitea transfer is reported with the manual fix', async () => {
  const { deps, calls, audits } = fakeDeps({ setProjectOwner: async () => { throw new Error('db down'); } });
  const out = await executeOwnershipTransfer(input, deps);
  assert.equal(out.ok, false);
  assert.equal(out.changed, true);
  assert.match(out.message, /bob\/shop/);
  assert.ok(out.details.some((d) => d.includes("UPDATE projects SET gitea_repo = 'bob/shop' WHERE id = 'p-1';")));
  assert.ok(!calls.some((c) => c.startsWith('setGrantFacet') || c.startsWith('patchArgo')), 'later steps skipped');
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].partial, ['portal row not updated: db down']);
});

test('execute: an ArgoCD failure is a partial result with the kubectl fix, still audited', async () => {
  const { deps, audits } = fakeDeps({ patchArgoRepoUrl: async () => { throw new Error('forbidden'); } });
  const out = await executeOwnershipTransfer(input, deps);
  assert.equal(out.ok, false);
  assert.equal(out.changed, true);
  assert.equal(out.project.owner_id, 'u-bob');
  const attention = out.details.filter((d) => d.startsWith('Needs attention:'));
  assert.equal(attention.length, 1);
  assert.match(attention[0], /kubectl -n \S+ patch application shop/);
  assert.equal((audits[0].partial as string[]).length, 1);
});

test('execute: with k8s disabled the Argo step is reported as manual, not skipped silently', async () => {
  const { deps, calls } = fakeDeps({ k8sEnabled: () => false });
  const out = await executeOwnershipTransfer(input, deps);
  assert.equal(out.ok, false);
  assert.ok(!calls.some((c) => c.startsWith('patchArgo')));
  assert.ok(out.details.some((d) => /Kubernetes integration is disabled/.test(d)));
});

test('execute: a repo already under the target skips the Gitea transfer but fixes the row', async () => {
  const { deps, calls } = fakeDeps();
  const out = await executeOwnershipTransfer({ ...input, project: { ...project, gitea_repo: 'bob/shop' } }, deps);
  assert.equal(out.ok, true);
  assert.ok(!calls.some((c) => c.startsWith('transferRepo')));
  assert.ok(calls.includes('setProjectOwner:p-1:u-bob:bob/shop'));
});
