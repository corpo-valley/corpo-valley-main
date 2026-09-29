import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDeploymentYaml, extractPinnedTag, projectImageLineRe } from './manifests';
import { CV_REGISTRY } from './platform-config';
import type { Capabilities } from './templates';

// Fixtures go through the real generator so they track the emitted shape, and
// a "pinned" file is produced the way the Build workflow's pin endpoint does
// it: rewrite every platform-registry image line's tag with the shared regex.
const BASE = { owner: 'alice', repo: 'shop', slug: 'shop' };
const WEB_ONLY: Capabilities = { website: true, database: false, storage: false, mcp: false, shared: false };
const WEB_DB: Capabilities = { ...WEB_ONLY, database: true };
const ALL: Capabilities = { website: true, database: true, storage: true, mcp: true, shared: true };
const TAG = '20260101120000';
const IMG = `${CV_REGISTRY}/alice/shop`;

function imageLines(yaml: string): string[] {
  return yaml.split('\n').filter((l) => /^\s*image:/.test(l)).map((l) => l.trim());
}
function pin(yaml: string, tag: string): string {
  return yaml.replace(projectImageLineRe(), `$1:${tag}`);
}

test('no existing deployment → every container on the bootstrap placeholder', () => {
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_DB });
  assert.deepEqual(imageLines(out), [`image: ${IMG}:bootstrap`, `image: ${IMG}:bootstrap`]);
});

test('existing pinned to a timestamp tag → tag preserved on ALL containers, incl. a newly enabled capability', () => {
  const existing = pin(buildDeploymentYaml({ ...BASE, caps: WEB_ONLY }), TAG);
  assert.deepEqual(imageLines(existing), [`image: ${IMG}:${TAG}`]); // fixture sanity
  const out = buildDeploymentYaml({ ...BASE, caps: ALL, existingDeployment: existing });
  const lines = imageLines(out);
  assert.equal(lines.length, 4, 'static-site + database + storage + mcp');
  assert.ok(lines.every((l) => l === `image: ${IMG}:${TAG}`), lines.join('\n'));
  assert.ok(!out.includes(':bootstrap'));
});

test('existing still on bootstrap → stays bootstrap (first provision over the seeded template)', () => {
  const existing = buildDeploymentYaml({ ...BASE, caps: WEB_ONLY });
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: existing });
  assert.ok(imageLines(out).every((l) => l === `image: ${IMG}:bootstrap`));
});

test('existing whose image lines are not on the platform registry → bootstrap fallback', () => {
  const existing = buildDeploymentYaml({ ...BASE, caps: WEB_ONLY })
    .replace(new RegExp(`${CV_REGISTRY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/alice/shop:bootstrap`, 'g'), `ghcr.io/alice/shop:${TAG}`);
  assert.deepEqual(imageLines(existing), [`image: ghcr.io/alice/shop:${TAG}`]); // fixture sanity
  assert.equal(extractPinnedTag(existing), null);
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_ONLY, existingDeployment: existing });
  assert.deepEqual(imageLines(out), [`image: ${IMG}:bootstrap`]);
});

test('owner-tuned resources are still preserved alongside the tag; new container gets defaults', () => {
  const generated = pin(buildDeploymentYaml({ ...BASE, caps: WEB_ONLY }), TAG);
  // Hand-tune the static-site container's requests.cpu the way an owner would.
  const existing = generated.replace(/(requests:\n\s+cpu:) \S+/, '$1 750m');
  assert.notEqual(existing, generated);
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: existing });
  assert.ok(imageLines(out).every((l) => l === `image: ${IMG}:${TAG}`));
  const [site, db] = out.split(/^\s+- name: database$/m);
  assert.match(site, /requests:\n\s+cpu: 750m/);
  assert.doesNotMatch(db, /cpu: 750m/, 'the new container must not inherit a sibling\'s tuning');
});

test('mixed tags: the first non-bootstrap tag in file order is normalised onto every container', () => {
  const two = pin(buildDeploymentYaml({ ...BASE, caps: WEB_DB }), TAG);
  // Hand-edit the second (database) container onto a different tag.
  let i = 0;
  const mixed = two.replace(projectImageLineRe(), (_m, head) => `${head}:${i++ === 0 ? TAG : '20260202120000'}`);
  assert.deepEqual(imageLines(mixed), [`image: ${IMG}:${TAG}`, `image: ${IMG}:20260202120000`]);
  assert.equal(extractPinnedTag(mixed), TAG);
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: mixed });
  assert.ok(imageLines(out).every((l) => l === `image: ${IMG}:${TAG}`));

  // A leading container left on bootstrap while a sibling is pinned is lifted
  // onto the sibling's real tag rather than dragging everything to bootstrap.
  i = 0;
  const partial = two.replace(projectImageLineRe(), (_m, head) => `${head}:${i++ === 0 ? 'bootstrap' : TAG}`);
  assert.equal(extractPinnedTag(partial), TAG);
  assert.ok(imageLines(buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: partial }))
    .every((l) => l === `image: ${IMG}:${TAG}`));
});

test('regeneration with unchanged capabilities is byte-identical (composeProjectManifests skips the commit)', () => {
  const existing = pin(buildDeploymentYaml({ ...BASE, caps: ALL }), TAG);
  assert.equal(buildDeploymentYaml({ ...BASE, caps: ALL, existingDeployment: existing }), existing);
});

test('extractPinnedTag: absent / empty / no image line → null', () => {
  assert.equal(extractPinnedTag(null), null);
  assert.equal(extractPinnedTag(undefined), null);
  assert.equal(extractPinnedTag(''), null);
  assert.equal(extractPinnedTag('apiVersion: apps/v1\nkind: Deployment\n'), null);
});

test('projectImageLineRe: pin-style rewrite moves every project image and leaves off-registry images alone', () => {
  const doc = [
    `          image: ${IMG}:bootstrap`,
    `          image: ${IMG}:${TAG}`,
    `          image: postgres:16-alpine`,
    `          image: ghcr.io/corpo-valley/corpo-valley-garage:v1.0.1`,
    `          image: registry.cv-registry.svc.cluster.local:5000-evil.example.com/alice/shop:${TAG}`,
    `  # image: ${IMG}:${TAG} in a comment is not an image line`,
  ].join('\n');
  const pinned = pin(doc, '20260303120000');
  assert.deepEqual(imageLines(pinned).slice(0, 5), [
    `image: ${IMG}:20260303120000`,
    `image: ${IMG}:20260303120000`,
    `image: postgres:16-alpine`,
    `image: ghcr.io/corpo-valley/corpo-valley-garage:v1.0.1`,
    `image: registry.cv-registry.svc.cluster.local:5000-evil.example.com/alice/shop:${TAG}`,
  ]);
  assert.ok(pinned.includes(`# image: ${IMG}:${TAG} in a comment`));
});

test('projectImageLineRe: the registry host\'s port colon is not mistaken for the tag separator', () => {
  const m = projectImageLineRe().exec(`          image: ${IMG}:${TAG}`);
  assert.ok(m);
  assert.equal(m![1], `          image: ${IMG}`);
  assert.equal(m![2], TAG);
});

test('extractPinnedTag never returns a tag that could inject YAML structure', () => {
  for (const bad of ['abc def', 'a:b', 'x#y', 'tag"quoted', 'a'.repeat(129)]) {
    const doc = `      containers:\n        - name: static-site\n          image: ${IMG}:${bad}\n`;
    assert.equal(extractPinnedTag(doc), null, JSON.stringify(bad));
  }
  // A multi-line payload after the tag is just the next YAML line; only the
  // single-line tag itself is ever returned.
  assert.equal(extractPinnedTag(`          image: ${IMG}:v1\n  evil: true\n`), 'v1');
  assert.equal(extractPinnedTag(`          image: ${IMG}:v1.2.3_rc-4   \n`), 'v1.2.3_rc-4', 'trailing whitespace tolerated');
});

test('the seeded template (unrendered {{CV_REGISTRY}}/{{OWNER}}/{{REPO}}:bootstrap on all 4 lines) → null, bootstrap fallback', () => {
  // The real reference copy the portal seeds into a new repo, read from disk so
  // the fixture can't drift from what the template actually ships.
  const template = readFileSync(resolve(__dirname, '../../../../community-center/k8s/deployment.yaml'), 'utf8');
  assert.equal(imageLines(template).length, 4);
  assert.ok(imageLines(template).every((l) => l === 'image: {{CV_REGISTRY}}/{{OWNER}}/{{REPO}}:bootstrap'), imageLines(template).join('\n'));
  assert.equal(extractPinnedTag(template), null, 'unrendered placeholders are not platform-registry lines');
  assert.ok(imageLines(buildDeploymentYaml({ ...BASE, caps: ALL, existingDeployment: template }))
    .every((l) => l === `image: ${IMG}:bootstrap`));
  // And the rendered form (what actually lands in the repo): placeholders
  // substituted, still on the placeholder tag → same fallback.
  const rendered = template.replace(/\{\{CV_REGISTRY\}\}/g, CV_REGISTRY).replace(/\{\{OWNER\}\}/g, 'alice').replace(/\{\{REPO\}\}/g, 'shop');
  assert.ok(imageLines(rendered).every((l) => l === `image: ${IMG}:bootstrap`));
  assert.equal(extractPinnedTag(rendered), null);
  assert.ok(imageLines(buildDeploymentYaml({ ...BASE, caps: ALL, existingDeployment: rendered }))
    .every((l) => l === `image: ${IMG}:bootstrap`));
});

test('digest-form image lines are ignored by both the generator and the pin rewrite', () => {
  // Hand-edit-only shape. Never treat `@sha256` as a path and the hex as a tag.
  const hex = 'a'.repeat(64);
  const digestLine = `          image: ${IMG}@sha256:${hex}`;
  assert.equal(extractPinnedTag(digestLine + '\n'), null);
  assert.equal(pin(digestLine, TAG), digestLine, 'pin must not corrupt a digest reference');
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_ONLY, existingDeployment: digestLine + '\n' });
  assert.deepEqual(imageLines(out), [`image: ${IMG}:bootstrap`]);
  // A digest line alongside a normally pinned sibling: the sibling's tag wins.
  assert.equal(extractPinnedTag(`${digestLine}\n          image: ${IMG}:${TAG}\n`), TAG);
});
