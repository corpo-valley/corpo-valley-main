// MIRRORED FILE — keep byte-identical with the mcp-gateway copy (CI enforces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMcpAudience, InvalidTargetError, projectSlugFromResource, resourceForSlug, selectMcpAudience } from './mcp-resources';

const PROJECTS_DOMAIN = 'projects.example.com';
const opts = { projectsDomain: PROJECTS_DOMAIN, platformAudience: 'https://mcp.example.com' };

test('platform audience passes through unchanged', () => {
  assert.equal(canonicalMcpAudience('https://mcp.example.com', opts), 'https://mcp.example.com');
});

test('canonical project resource round-trips through classifier and builder', () => {
  for (const slug of ['proj', 'a', 'my-project-1', 'x'.repeat(63)]) {
    const input = `https://${slug}.${PROJECTS_DOMAIN}/mcp`;
    const aud = canonicalMcpAudience(input, opts);
    assert.equal(aud, input);
    assert.equal(aud, resourceForSlug(projectSlugFromResource(aud, PROJECTS_DOMAIN)!, PROJECTS_DOMAIN));
  }
});

test('strict validator rejects every non-canonical spelling', () => {
  for (const bad of [
    'https://proj.projects.example.com',        // no /mcp
    'https://proj.projects.example.com/',       // bare origin with slash
    'https://proj.projects.example.com/mcp/',   // trailing slash
    'https://proj.projects.example.com:443/mcp', // explicit default port
    'https://proj.projects.example.com:8443/mcp',
    'https://user@proj.projects.example.com/mcp',
    'https://user:pw@proj.projects.example.com/mcp',
    'http://proj.projects.example.com/mcp',     // wrong scheme
    'https://PROJ.projects.example.com/mcp',    // host case
    'https://proj.projects.example.com/MCP',    // path case
    'https://a.b.projects.example.com/mcp',     // slug with a dot
    'https://-proj.projects.example.com/mcp',   // invalid label
    'https://proj.projects.example.com/mcp?x=1',
    'https://proj.projects.example.com/mcp#f',
    'https://evil.com/?x=.projects.example.com',
    'https://projects.example.com/mcp',         // no slug at all
    'https://mcp.example.com/mcp',              // platform endpoint, not the resource
    'https://mcp.example.com/',                 // platform with trailing slash
    'not a url',
    '',
  ]) {
    assert.throws(() => canonicalMcpAudience(bad, opts), InvalidTargetError, bad);
  }
});

test('selection: absent → platform, one → canonical, several → invalid_target(multiple)', () => {
  const proj = `https://proj.${PROJECTS_DOMAIN}/mcp`;
  assert.equal(selectMcpAudience([], opts), opts.platformAudience);
  assert.equal(selectMcpAudience([opts.platformAudience], opts), opts.platformAudience);
  assert.equal(selectMcpAudience([proj], opts), proj);
  assert.throws(() => selectMcpAudience([opts.platformAudience, proj], opts), (e: any) => e instanceof InvalidTargetError && e.reason === 'multiple');
  assert.throws(() => selectMcpAudience([proj, proj], opts), (e: any) => e instanceof InvalidTargetError && e.reason === 'multiple');
  assert.throws(() => selectMcpAudience(['https://evil.example.com/mcp'], opts), (e: any) => e instanceof InvalidTargetError && e.reason === 'malformed');
});

test('classifier is lenient about paths but strict about labels', () => {
  assert.equal(projectSlugFromResource('https://proj.projects.example.com/mcp', PROJECTS_DOMAIN), 'proj');
  assert.equal(projectSlugFromResource('https://proj.projects.example.com/', PROJECTS_DOMAIN), 'proj');
  assert.equal(projectSlugFromResource('https://mcp.example.com', PROJECTS_DOMAIN), null);
  assert.equal(projectSlugFromResource('https://a.b.projects.example.com/mcp', PROJECTS_DOMAIN), null);
  assert.equal(projectSlugFromResource('https://projects.example.com/mcp', PROJECTS_DOMAIN), null);
  assert.equal(projectSlugFromResource('garbage', PROJECTS_DOMAIN), null);
});
