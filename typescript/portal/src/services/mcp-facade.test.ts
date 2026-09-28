import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMcpAuthorize, type FacadeDeps } from './mcp-facade';

const PLATFORM = 'https://mcp.example.com';
const D = 'projects.example.com';
const PROJ = `https://proj.${D}/mcp`;

function deps(over: Partial<FacadeDeps> = {}) {
  const ensured: Array<[string, string]> = [];
  const d: FacadeDeps = {
    projectsDomain: D,
    platformAudience: PLATFORM,
    hydraPublicUrl: 'https://oauth.example.com',
    projectExists: async (slug) => slug === 'proj',
    ensureClientAudience: async (c, a) => { ensured.push([c, a]); },
    log: { warn() {}, error() {} },
    ...over,
  };
  return { d, ensured };
}

function qsOf(plan: any): URLSearchParams {
  assert.equal(plan.kind, 'redirect', JSON.stringify(plan));
  const u = new URL(plan.location);
  assert.equal(u.origin + u.pathname, 'https://oauth.example.com/oauth2/auth');
  return u.searchParams;
}

test('no resource → platform audience, client audience stripped, other params forwarded verbatim', async () => {
  const { d, ensured } = deps();
  const plan = await planMcpAuthorize('client_id=c1&response_type=code&audience=https%3A%2F%2Fevil.example.com&state=xyz&code_challenge=abc', d);
  const q = qsOf(plan);
  assert.deepEqual(q.getAll('audience'), [PLATFORM]);
  assert.equal(q.get('state'), 'xyz');
  assert.equal(q.get('code_challenge'), 'abc');
  assert.equal(q.get('prompt'), null, 'platform audience does not force consent');
  assert.deepEqual(ensured, [['c1', PLATFORM]]);
});

test('SDK-shaped platform resource (trailing slash) → canonical platform audience', async () => {
  const { d } = deps();
  const q = qsOf(await planMcpAuthorize(`client_id=c1&resource=${encodeURIComponent(PLATFORM + '/')}`, d));
  assert.deepEqual(q.getAll('audience'), [PLATFORM]);
});

test('project resource → that audience, prompt=consent, allowlisted', async () => {
  const { d, ensured } = deps();
  const q = qsOf(await planMcpAuthorize(`client_id=c1&resource=${encodeURIComponent(PROJ)}`, d));
  assert.deepEqual(q.getAll('audience'), [PROJ]);
  assert.equal(q.get('prompt'), 'consent');
  assert.deepEqual(ensured, [['c1', PROJ]]);
});

test('client prompt=login is preserved alongside the forced consent', async () => {
  const { d } = deps();
  const q = qsOf(await planMcpAuthorize(`client_id=c1&prompt=login&resource=${encodeURIComponent(PROJ)}`, d));
  assert.equal(q.get('prompt'), 'login consent');
  const q2 = qsOf(await planMcpAuthorize(`client_id=c1&prompt=none&resource=${encodeURIComponent(PROJ)}`, d));
  assert.equal(q2.get('prompt'), 'consent', 'prompt=none cannot suppress consent for a project audience');
});

test('missing / malformed client_id → 400 invalid_request, nothing touched', async () => {
  const { d, ensured } = deps();
  for (const qs of ['', 'client_id=', 'client_id=has%20space', `client_id=${'x'.repeat(129)}`]) {
    const plan = await planMcpAuthorize(qs, d);
    assert.deepEqual(plan, { kind: 'error', status: 400, body: { error: 'invalid_request', error_description: 'client_id is required' } });
  }
  assert.equal(ensured.length, 0);
});

test('malformed resource → 400 invalid_target, NO fallback to platform, nothing allowlisted', async () => {
  const { d, ensured } = deps();
  for (const r of [`https://proj.${D}/mcp/`, `https://proj.${D}`, 'https://evil.example.com/mcp', 'garbage']) {
    const plan = await planMcpAuthorize(`client_id=c1&resource=${encodeURIComponent(r)}`, d);
    assert.equal(plan.kind, 'error'); assert.equal((plan as any).status, 400);
    assert.equal((plan as any).body.error, 'invalid_target');
  }
  assert.equal(ensured.length, 0);
});

test('two resources → 400 invalid_target (exactly one audience per token)', async () => {
  const { d, ensured } = deps();
  const plan = await planMcpAuthorize(`client_id=c1&resource=${encodeURIComponent(PLATFORM)}&resource=${encodeURIComponent(PROJ)}`, d);
  assert.deepEqual(plan, { kind: 'error', status: 400, body: { error: 'invalid_target', error_description: 'exactly one resource may be requested' } });
  assert.equal(ensured.length, 0);
});

test('canonical resource for a project that does not exist → 400, allowlist untouched', async () => {
  const { d, ensured } = deps();
  const plan = await planMcpAuthorize(`client_id=c1&resource=${encodeURIComponent(`https://ghost.${D}/mcp`)}`, d);
  assert.equal(plan.kind, 'error'); assert.equal((plan as any).status, 400);
  assert.equal((plan as any).body.error, 'invalid_target');
  assert.equal(ensured.length, 0, 'unauthenticated callers must not be able to grow a client allowlist');
});

test('allowlist patch failure → 502 temporarily_unavailable (fail closed, no redirect)', async () => {
  const { d } = deps({ ensureClientAudience: async () => { throw new Error('hydra down'); } });
  const plan = await planMcpAuthorize(`client_id=c1&resource=${encodeURIComponent(PROJ)}`, d);
  assert.deepEqual(plan, { kind: 'error', status: 502, body: { error: 'temporarily_unavailable', error_description: 'could not prepare client for MCP authorization' } });
});
