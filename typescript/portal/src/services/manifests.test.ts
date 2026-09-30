import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDeploymentYaml, extractPinnedTag, projectImageLineRe } from './manifests';
import { CV_REGISTRY } from './platform-config';
import type { Capabilities } from './templates';

const BASE = { owner: 'alice', repo: 'shop', slug: 'shop' };
const WEB_ONLY: Capabilities = { website: true, database: false, storage: false, mcp: false, shared: false };
const WEB_DB: Capabilities = { ...WEB_ONLY, database: true };
const ALL: Capabilities = { website: true, database: true, storage: true, mcp: true, shared: true };
const TAG = '20260101120000';
const IMG = `${CV_REGISTRY}/alice/shop`;

function imageLines(yaml: string): string[] {
  return yaml.split('\n').filter((l) => /^\s*image:/.test(l)).map((l) => l.trim());
}
// What the Build workflow's pin endpoint does (routes/internal.ts).
function pin(yaml: string, tag: string): string {
  return yaml.replace(projectImageLineRe(), `$1:${tag}`);
}

test('no existing deployment: every container on bootstrap', () => {
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_DB });
  assert.deepEqual(imageLines(out), [`image: ${IMG}:bootstrap`, `image: ${IMG}:bootstrap`]);
});

test('pinned tag is kept on every container, including a newly enabled one', () => {
  const existing = pin(buildDeploymentYaml({ ...BASE, caps: WEB_ONLY }), TAG);
  assert.deepEqual(imageLines(existing), [`image: ${IMG}:${TAG}`]);
  const out = buildDeploymentYaml({ ...BASE, caps: ALL, existingDeployment: existing });
  const lines = imageLines(out);
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l === `image: ${IMG}:${TAG}`), lines.join('\n'));
});

test('off-registry image lines: bootstrap fallback', () => {
  const existing = buildDeploymentYaml({ ...BASE, caps: WEB_ONLY }).replace(`${IMG}:bootstrap`, `ghcr.io/alice/shop:${TAG}`);
  assert.deepEqual(imageLines(existing), [`image: ghcr.io/alice/shop:${TAG}`]);
  assert.equal(extractPinnedTag(existing), null);
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_ONLY, existingDeployment: existing });
  assert.deepEqual(imageLines(out), [`image: ${IMG}:bootstrap`]);
});

test('owner-tuned resources are preserved alongside the tag; a new container gets defaults', () => {
  const generated = pin(buildDeploymentYaml({ ...BASE, caps: WEB_ONLY }), TAG);
  const existing = generated.replace(/(requests:\n\s+cpu:) \S+/, '$1 750m');
  assert.notEqual(existing, generated);
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: existing });
  assert.ok(imageLines(out).every((l) => l === `image: ${IMG}:${TAG}`));
  const [site, db] = out.split(/^\s+- name: database$/m);
  assert.match(site, /requests:\n\s+cpu: 750m/);
  assert.doesNotMatch(db, /cpu: 750m/);
});

test('mixed tags: first non-bootstrap tag in file order wins', () => {
  const two = pin(buildDeploymentYaml({ ...BASE, caps: WEB_DB }), TAG);
  let i = 0;
  const mixed = two.replace(projectImageLineRe(), (_m, head) => `${head}:${i++ === 0 ? TAG : '20260202120000'}`);
  assert.deepEqual(imageLines(mixed), [`image: ${IMG}:${TAG}`, `image: ${IMG}:20260202120000`]);
  assert.equal(extractPinnedTag(mixed), TAG);
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: mixed });
  assert.ok(imageLines(out).every((l) => l === `image: ${IMG}:${TAG}`));

  i = 0;
  const partial = two.replace(projectImageLineRe(), (_m, head) => `${head}:${i++ === 0 ? 'bootstrap' : TAG}`);
  assert.equal(extractPinnedTag(partial), TAG);
  assert.ok(imageLines(buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: partial }))
    .every((l) => l === `image: ${IMG}:${TAG}`));
});

test('regeneration with unchanged capabilities is byte-identical', () => {
  const existing = pin(buildDeploymentYaml({ ...BASE, caps: ALL }), TAG);
  assert.equal(buildDeploymentYaml({ ...BASE, caps: ALL, existingDeployment: existing }), existing);
});

test('extractPinnedTag: absent / empty / no image line', () => {
  assert.equal(extractPinnedTag(null), null);
  assert.equal(extractPinnedTag(undefined), null);
  assert.equal(extractPinnedTag(''), null);
  assert.equal(extractPinnedTag('apiVersion: apps/v1\nkind: Deployment\n'), null);
});

test('pin rewrite moves every project image and leaves other images alone', () => {
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

test('extractPinnedTag rejects tags outside the tag class', () => {
  for (const bad of ['abc def', 'a:b', 'x#y', 'tag"quoted', 'a'.repeat(129)]) {
    const doc = `      containers:\n        - name: static-site\n          image: ${IMG}:${bad}\n`;
    assert.equal(extractPinnedTag(doc), null, JSON.stringify(bad));
  }
  assert.equal(extractPinnedTag(`          image: ${IMG}:v1\n  evil: true\n`), 'v1');
  assert.equal(extractPinnedTag(`          image: ${IMG}:v1.2.3_rc-4   \n`), 'v1.2.3_rc-4');
});

test('seeded template (unrendered and rendered) stays on bootstrap', () => {
  const template = readFileSync(resolve(__dirname, '../../../../community-center/k8s/deployment.yaml'), 'utf8');
  assert.equal(imageLines(template).length, 4);
  assert.ok(imageLines(template).every((l) => l === 'image: {{CV_REGISTRY}}/{{OWNER}}/{{REPO}}:bootstrap'), imageLines(template).join('\n'));
  assert.equal(extractPinnedTag(template), null);
  assert.ok(imageLines(buildDeploymentYaml({ ...BASE, caps: ALL, existingDeployment: template }))
    .every((l) => l === `image: ${IMG}:bootstrap`));

  const rendered = template.replace(/\{\{CV_REGISTRY\}\}/g, CV_REGISTRY).replace(/\{\{OWNER\}\}/g, 'alice').replace(/\{\{REPO\}\}/g, 'shop');
  assert.ok(imageLines(rendered).every((l) => l === `image: ${IMG}:bootstrap`));
  assert.equal(extractPinnedTag(rendered), null);
  assert.ok(imageLines(buildDeploymentYaml({ ...BASE, caps: WEB_DB, existingDeployment: rendered }))
    .every((l) => l === `image: ${IMG}:bootstrap`));
});

test('digest-form image lines are ignored by the generator and the pin rewrite', () => {
  const digestLine = `          image: ${IMG}@sha256:${'a'.repeat(64)}`;
  assert.equal(extractPinnedTag(digestLine + '\n'), null);
  assert.equal(pin(digestLine, TAG), digestLine);
  const out = buildDeploymentYaml({ ...BASE, caps: WEB_ONLY, existingDeployment: digestLine + '\n' });
  assert.deepEqual(imageLines(out), [`image: ${IMG}:bootstrap`]);
  assert.equal(extractPinnedTag(`${digestLine}\n          image: ${IMG}:${TAG}\n`), TAG);
});
