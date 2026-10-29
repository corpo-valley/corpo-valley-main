import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIngressYaml, BROTLI_REJECT_SNIPPET } from './manifests';
import { PORTAL_INTERNAL_URL } from './platform-config';
import type { Capabilities } from './templates';

const BASE = { owner: 'alice', repo: 'shop', slug: 'shop' };
const WEB_ONLY: Capabilities = { website: true, database: false, storage: false, mcp: false, shared: false };
const ALL: Capabilities = { website: true, database: true, storage: true, mcp: true, shared: true };

const SNIPPET_KEY = 'nginx.ingress.kubernetes.io/configuration-snippet';

function annotationsBlock(yaml: string): string {
  const m = /^  annotations:\n((?:    .*\n|\n)*?)spec:/m.exec(yaml);
  assert.ok(m, 'annotations block present');
  return m![1];
}

test('project ingress refuses Brotli-encoded request bodies at the edge (CVE-2026-111497)', () => {
  const out = buildIngressYaml({ ...BASE, caps: ALL });
  const anns = annotationsBlock(out);
  // The snippet is a YAML block scalar: key on its own line, directive indented
  // beneath it, so nginx receives exactly one `if` directive.
  assert.match(anns, new RegExp(`^    ${SNIPPET_KEY.replace(/[.\/]/g, '\\$&')}: \\|\\n      ${BROTLI_REJECT_SNIPPET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`, 'm'));
  assert.equal(out.split(SNIPPET_KEY).length - 1, 1, 'exactly one snippet annotation');
  // What the directive does: match the raw request header case-insensitively
  // (also inside a list like `gzip, br`) and stop with 415 before proxying.
  assert.match(BROTLI_REJECT_SNIPPET, /^if \(\$http_content_encoding ~\* "br"\) \{ return 415; \}$/);
});

test('hardening is stamped regardless of capability set, alongside the auth gate', () => {
  for (const caps of [WEB_ONLY, ALL]) {
    const out = buildIngressYaml({ ...BASE, caps });
    const anns = annotationsBlock(out);
    assert.ok(anns.includes(SNIPPET_KEY), 'snippet present');
    // The auth-url gate (which the cv-projects-ingress-bounds VAP requires) is
    // untouched: still slug-bound, still exactly the portal access endpoint.
    assert.ok(anns.includes(`nginx.ingress.kubernetes.io/auth-url: "${PORTAL_INTERNAL_URL}/access/site/shop"`));
    assert.ok(anns.includes('nginx.ingress.kubernetes.io/auth-signin-redirect-param: "return_to"'));
  }
});

test('ingress stays a single document with the expected path routing', () => {
  const out = buildIngressYaml({ ...BASE, caps: ALL });
  assert.equal(out.split(/^---$/m).length - 1, 1, 'one YAML document');
  assert.equal(out.split('kind: Ingress').length - 1, 1, 'one Ingress');
  // /mcp is NOT routed here (the gateway Ingress is separate and must not carry
  // the snippet: the gateway strips content-encoding itself).
  assert.doesNotMatch(out, /path: \/mcp/);
  assert.match(out, /path: \/api\n/);
  assert.match(out, /path: \/files\n/);
  assert.match(out, /path: \/\n/);
  // Paths come after the annotation block; the snippet must not leak into spec.
  const specIdx = out.indexOf('\nspec:');
  assert.ok(out.lastIndexOf(SNIPPET_KEY) < specIdx);
});
