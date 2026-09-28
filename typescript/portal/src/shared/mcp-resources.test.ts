// MIRRORED FILE — keep byte-identical with the mcp-gateway copy (CI enforces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalMcpAudience, InvalidTargetError, isMcpAudience, projectSlugFromResource, resourceForSlug, selectMcpAudience,
} from './mcp-resources';

const PROJECTS_DOMAIN = 'projects.example.com';
const PLATFORM = 'https://mcp.example.com';
const opts = { projectsDomain: PROJECTS_DOMAIN, platformAudience: PLATFORM };

test('platform audience passes through unchanged', () => {
  assert.equal(canonicalMcpAudience(PLATFORM, opts), PLATFORM);
});

test('platform audience as the MCP TS SDK serialises it (trailing slash) is accepted and canonicalised', () => {
  // The SDK does `new URL(prm.resource).href` → a bare origin gains a slash.
  assert.equal(new URL(PLATFORM).href, PLATFORM + '/');
  assert.equal(canonicalMcpAudience(PLATFORM + '/', opts), PLATFORM);
  assert.equal(selectMcpAudience([new URL(PLATFORM).href], opts), PLATFORM);
});

test('canonical project resource round-trips through classifier and builder', () => {
  for (const slug of ['proj', 'a', 'my-project-1', 'x'.repeat(63)]) {
    const input = `https://${slug}.${PROJECTS_DOMAIN}/mcp`;
    const aud = canonicalMcpAudience(input, opts);
    assert.equal(aud, input);
    assert.equal(aud, resourceForSlug(projectSlugFromResource(aud, PROJECTS_DOMAIN)!, PROJECTS_DOMAIN));
    // A project resource is stable under the SDK's URL round-trip too.
    assert.equal(new URL(input).href, input);
  }
});

test('every accepted output is one of the two canonical forms (never an echo of odd input)', () => {
  for (const input of [PLATFORM, PLATFORM + '/', `https://p.${PROJECTS_DOMAIN}/mcp`]) {
    const out = canonicalMcpAudience(input, opts);
    const slug = projectSlugFromResource(out, PROJECTS_DOMAIN);
    assert.ok(out === PLATFORM || (slug !== null && out === resourceForSlug(slug, PROJECTS_DOMAIN)), out);
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
    'https://proj.projects.example.com./mcp',   // trailing-dot host
    'https://proj.projects.example.com/mcp?x=1',
    'https://proj.projects.example.com/mcp#f',
    'https://proj.projects.example.com/%6dcp',  // percent-encoded path
    'https://proj%2Eprojects.example.com/mcp',  // percent-encoded host
    'https://proj.projects.example.com\\mcp',   // backslash
    ' https://proj.projects.example.com/mcp',   // leading whitespace
    'https://proj.projects.example.com/mcp\t',
    'https://evil.com/?x=.projects.example.com',
    'https://projects.example.com/mcp',         // no slug at all
    'https://mcp.example.com/mcp',              // platform ENDPOINT, not the resource
    'https://MCP.example.com',                  // platform host case
    'https://mcp.example.com//',
    'not a url',
    '',
  ]) {
    assert.throws(() => canonicalMcpAudience(bad, opts), InvalidTargetError, bad);
  }
});

test('selection: absent → platform, one → canonical, several → invalid_target(multiple)', () => {
  const proj = `https://proj.${PROJECTS_DOMAIN}/mcp`;
  assert.equal(selectMcpAudience([], opts), PLATFORM);
  assert.equal(selectMcpAudience([PLATFORM], opts), PLATFORM);
  assert.equal(selectMcpAudience([proj], opts), proj);
  assert.throws(() => selectMcpAudience([PLATFORM, proj], opts), (e: any) => e instanceof InvalidTargetError && e.reason === 'multiple');
  assert.throws(() => selectMcpAudience([proj, proj], opts), (e: any) => e instanceof InvalidTargetError && e.reason === 'multiple');
  assert.throws(() => selectMcpAudience(['https://evil.example.com/mcp'], opts), (e: any) => e instanceof InvalidTargetError && e.reason === 'malformed');
});

test('classifier is lenient about paths but strict about labels', () => {
  assert.equal(projectSlugFromResource('https://proj.projects.example.com/mcp', PROJECTS_DOMAIN), 'proj');
  assert.equal(projectSlugFromResource('https://proj.projects.example.com/', PROJECTS_DOMAIN), 'proj');
  assert.equal(projectSlugFromResource(PLATFORM, PROJECTS_DOMAIN), null);
  assert.equal(projectSlugFromResource('https://a.b.projects.example.com/mcp', PROJECTS_DOMAIN), null);
  assert.equal(projectSlugFromResource('https://projects.example.com/mcp', PROJECTS_DOMAIN), null);
  assert.equal(projectSlugFromResource('garbage', PROJECTS_DOMAIN), null);
});

test('isMcpAudience recognises platform + project resources and nothing else', () => {
  assert.equal(isMcpAudience(PLATFORM, opts), true);
  assert.equal(isMcpAudience(`https://p.${PROJECTS_DOMAIN}/mcp`, opts), true);
  assert.equal(isMcpAudience(`https://p.${PROJECTS_DOMAIN}/`, opts), true); // classifier, lenient
  assert.equal(isMcpAudience('https://gitea.example.com', opts), false);
  assert.equal(isMcpAudience('', opts), false);
});
