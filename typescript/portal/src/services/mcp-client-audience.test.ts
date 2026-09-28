import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnsureClientAudience, MAX_CLIENT_AUDIENCES, type HydraClientAdmin } from './mcp-client-audience';

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

test('refuses to grow an allowlist past the cap', async () => {
  const full = Array.from({ length: MAX_CLIENT_AUDIENCES }, (_, i) => `https://p${i}.projects.example.com/mcp`);
  const { admin, patches } = fakeAdmin({ c1: full });
  const ensure = createEnsureClientAudience(admin);
  await assert.rejects(() => ensure('c1', PROJ), /at capacity/);
  assert.equal(patches.length, 0);
  // An already-present audience is still fine at capacity.
  await ensure('c1', full[0]);
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
