import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewritePinnedImageLines } from './pin-image';

const HOST = 'registry.cv-registry.svc.cluster.local:5000';
const yaml = [
  'spec:',
  '  containers:',
  '    - name: web',
  `      image: ${HOST}/alice/shop:bootstrap`,
  '    - name: database',
  '      image: postgres:16-alpine',
  '    - name: mcp',
  `      image: ${HOST}/alice/shop:20260101000000`,
].join('\n');

test('pins every registry image line to the tag', () => {
  const out = rewritePinnedImageLines(yaml, { owner: 'alice', repo: 'shop', tag: '20260202030405' });
  assert.equal((out.match(/20260202030405/g) || []).length, 2);
  assert.ok(!out.includes('bootstrap'));
  assert.ok(out.includes('image: postgres:16-alpine'), 'non-registry images untouched');
});

test('rewrites the owner path after an ownership transfer', () => {
  const out = rewritePinnedImageLines(yaml, { owner: 'bob', repo: 'shop', tag: '20260202030405' });
  assert.ok(out.includes(`image: ${HOST}/bob/shop:20260202030405`));
  assert.ok(!out.includes('/alice/'), 'old owner path fully replaced');
  assert.ok(out.includes(`${HOST}/bob/shop`), 'registry host preserved verbatim (port included)');
});

test('is a no-op when already pinned to the same owner and tag', () => {
  const pinned = rewritePinnedImageLines(yaml, { owner: 'alice', repo: 'shop', tag: 'x1' });
  assert.equal(rewritePinnedImageLines(pinned, { owner: 'alice', repo: 'shop', tag: 'x1' }), pinned);
});

test('anchors on the configured registry host, not a hard-coded one', () => {
  const other = 'registry.acme-registry.svc:5000';
  const y = `      image: ${other}/alice/shop:bootstrap\n      image: ${HOST}/alice/shop:bootstrap`;
  const out = rewritePinnedImageLines(y, { owner: 'alice', repo: 'shop', tag: 'v1' }, other);
  assert.ok(out.includes(`${other}/alice/shop:v1`), 'configured host is pinned');
  assert.ok(out.includes(`${HOST}/alice/shop:bootstrap`), 'other hosts are left alone');
});

test('leaves digest-pinned image lines alone', () => {
  const y = `      image: ${HOST}/alice/shop@sha256:0123456789abcdef`;
  assert.equal(rewritePinnedImageLines(y, { owner: 'bob', repo: 'shop', tag: 'v1' }), y);
});
