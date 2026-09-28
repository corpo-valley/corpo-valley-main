import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceFilter, hasProjectAudience, type SitePerm } from './audience-filter';

const D = 'projects.example.com';
const PLATFORM = 'https://mcp.example.com';
const A = 'https://a.projects.example.com/mcp';
const B = 'https://b.projects.example.com/mcp';
const GHOST = 'https://ghost.projects.example.com/mcp';

function filterWith(perms: Record<string, SitePerm>, opts: { throwOn?: string } = {}) {
  const warnings: string[] = [];
  const filter = createAudienceFilter<{ slug: string }>({
    projectsDomain: D,
    async getProjectBySlug(slug) { if (slug === opts.throwOn) throw new Error('db down'); return slug in perms ? { slug } : null; },
    async effectiveSitePerm(p) { return perms[p.slug]; },
    warn: (m) => warnings.push(m),
  });
  return { filter, warnings };
}

test('keeps non-project audiences untouched', async () => {
  const { filter } = filterWith({});
  assert.deepEqual(await filter([PLATFORM, 'https://other.example.com'], 'u'), [PLATFORM, 'https://other.example.com']);
});

test('keeps project audiences with read+ access, drops none', async () => {
  const { filter, warnings } = filterWith({ a: 'read', b: 'none' });
  assert.deepEqual(await filter([PLATFORM, A, B], 'u'), [PLATFORM, A]);
  assert.equal(warnings.length, 1);
});

test('drops unknown projects (fail closed)', async () => {
  const { filter } = filterWith({ a: 'admin' });
  assert.deepEqual(await filter([A, GHOST], 'u'), [A]);
});

test('drops on a thrown lookup error and continues with the rest (fail closed)', async () => {
  const { filter, warnings } = filterWith({ a: 'write', b: 'write' }, { throwOn: 'a' });
  assert.deepEqual(await filter([A, B], 'u'), [B]);
  assert.match(warnings[0], /fail closed/);
});

test('hasProjectAudience distinguishes project from platform audiences', () => {
  assert.equal(hasProjectAudience([PLATFORM], D), false);
  assert.equal(hasProjectAudience([PLATFORM, A], D), true);
  assert.equal(hasProjectAudience([], D), false);
});
