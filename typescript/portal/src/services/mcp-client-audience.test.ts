import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnsureClientAudience, type HydraClientAdmin } from './mcp-client-audience';

function fakeAdmin(initial: Record<string, string[] | undefined>) {
  const clients = new Map(Object.entries(initial));
  const patches: Array<{ id: string; jsonPatch: any[] }> = [];
  const admin: HydraClientAdmin = {
    async getOAuth2Client({ id }) { return { data: { audience: clients.get(id) } }; },
    async patchOAuth2Client({ id, jsonPatch }) {
      patches.push({ id, jsonPatch });
      for (const p of jsonPatch) {
        if (p.path === '/audience') clients.set(id, [...(p.value as string[])]);
        else if (p.path === '/audience/-') clients.set(id, [...(clients.get(id) || []), p.value as string]);
      }
      return {};
    },
  };
  return { admin, patches, clients };
}

const PLATFORM = 'https://mcp.example.com';
const PROJ = 'https://proj.projects.example.com/mcp';
const PROJ2 = 'https://proj2.projects.example.com/mcp';

test('patches once PER (client, audience) pair, not per client', async () => {
  const { admin, patches } = fakeAdmin({ c1: [] });
  const ensure = createEnsureClientAudience(admin);
  await ensure('c1', PLATFORM);
  await ensure('c1', PROJ);
  assert.equal(patches.length, 2);
  await ensure('c1', PLATFORM);
  await ensure('c1', PROJ);
  assert.equal(patches.length, 2, 'memoised after first patch');
});

test('appends with /audience/- when an array exists, seeds with /audience when absent', async () => {
  const { admin, patches, clients } = fakeAdmin({ fresh: undefined, seeded: [PLATFORM] });
  const ensure = createEnsureClientAudience(admin);
  await ensure('fresh', PLATFORM);
  assert.deepEqual(patches[0].jsonPatch, [{ op: 'add', path: '/audience', value: [PLATFORM] }]);
  await ensure('seeded', PROJ);
  assert.deepEqual(patches[1].jsonPatch, [{ op: 'add', path: '/audience/-', value: PROJ }]);
  assert.deepEqual(clients.get('seeded'), [PLATFORM, PROJ]);
});

test('does not patch (but memoises) when the audience is already allowlisted', async () => {
  const { admin, patches } = fakeAdmin({ c1: [PLATFORM] });
  const ensure = createEnsureClientAudience(admin);
  await ensure('c1', PLATFORM);
  await ensure('c1', PLATFORM);
  assert.equal(patches.length, 0);
});

test('at capacity: prunes stale audiences with a replace patch, else hard error', async () => {
  const full = Array.from({ length: 4 }, (_, i) => `https://p${i}.projects.example.com/mcp`);
  // No isStale → hard error, nothing patched.
  {
    const { admin, patches } = fakeAdmin({ c1: full });
    const ensure = createEnsureClientAudience(admin, { maxAudiences: 4 });
    await assert.rejects(() => ensure('c1', PROJ), /at capacity/);
    assert.equal(patches.length, 0);
    await ensure('c1', full[0]); // already present is still fine at capacity
  }
  // isStale prunes p1 and p3 → replace with kept + new.
  {
    const { admin, patches, clients } = fakeAdmin({ c1: full });
    const ensure = createEnsureClientAudience(admin, { maxAudiences: 4, isStale: async (a) => a.includes('p1') || a.includes('p3') });
    await ensure('c1', PROJ);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].jsonPatch[0].op, 'replace');
    assert.deepEqual(clients.get('c1'), [full[0], full[2], PROJ]);
  }
  // Nothing stale → still a hard error.
  {
    const { admin } = fakeAdmin({ c1: full });
    const ensure = createEnsureClientAudience(admin, { maxAudiences: 4, isStale: async () => false });
    await assert.rejects(() => ensure('c1', PROJ), /at capacity/);
  }
});

test('a failed patch is not memoised, so the next call retries', async () => {
  let fail = true;
  const { admin, patches } = fakeAdmin({ c1: [] });
  const flaky: HydraClientAdmin = {
    getOAuth2Client: admin.getOAuth2Client,
    async patchOAuth2Client(req) { if (fail) { fail = false; throw new Error('hydra down'); } return admin.patchOAuth2Client(req); },
  };
  const ensure = createEnsureClientAudience(flaky);
  await assert.rejects(() => ensure('c1', PROJ), /hydra down/);
  await ensure('c1', PROJ);
  assert.equal(patches.length, 1);
});

test('memo expires after the TTL and re-checks Hydra (self-heals a replaced allowlist)', async () => {
  let t = 1_000_000;
  const { admin, patches, clients } = fakeAdmin({ c1: [] });
  const ensure = createEnsureClientAudience(admin, { memoTtlMs: 1000, now: () => t });
  await ensure('c1', PROJ);
  assert.equal(patches.length, 1);
  clients.set('c1', [PLATFORM]); // an RFC 7592 PUT wiped the project audience behind our back
  await ensure('c1', PROJ);
  assert.equal(patches.length, 1, 'still memoised inside the TTL');
  t += 1001;
  await ensure('c1', PROJ);
  assert.equal(patches.length, 2, 're-patched after expiry');
  assert.deepEqual(clients.get('c1'), [PLATFORM, PROJ]);
});

test('invalidate(clientId) forgets only that client', async () => {
  const { admin, patches, clients } = fakeAdmin({ c1: [], c2: [] });
  const ensure = createEnsureClientAudience(admin);
  await ensure('c1', PROJ);
  await ensure('c1', PROJ2);
  await ensure('c2', PROJ);
  assert.equal(patches.length, 3);
  clients.set('c1', []);
  ensure.invalidate('c1');
  await ensure('c1', PROJ);
  await ensure('c2', PROJ);
  assert.equal(patches.length, 4, 'c1 re-patched, c2 still memoised');
});
