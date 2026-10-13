import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectDetail, ProjectRow } from './templates';

const project: ProjectRow = {
  id: '11111111-1111-1111-1111-111111111111', slug: 'garden', name: 'Garden',
  everyoneSite: 'read', everyoneRepo: 'none', createdAt: '1/1/2026',
  giteaRepo: 'ana/garden', postgresEnabled: true, storageEnabled: false, status: 'ready',
};
const secrets = [{ name: 'api-credentials' }];
const render = (tier: 'read' | 'write' | 'admin', isOwner = false, platformAdmin = false) =>
  renderProjectDetail('me@example.com', platformAdmin, project, '<input type="hidden" name="_csrf_token" value="t">',
    secrets, null, [], [], null, { tier, isOwner, platformAdmin });

test('owner/admin tier sees every control', () => {
  const html = render('admin', true);
  assert.ok(html.includes('Danger zone'));
  assert.ok(html.includes('/secrets/api-credentials/delete'));
  assert.ok(html.includes('action="/projects/11111111-1111-1111-1111-111111111111/secrets"'));
  assert.ok(html.includes('name="destroy_data"'));
  assert.ok(html.includes('Add people'));
  assert.ok(!html.includes('Your access:'), 'owners get no access line');
});

test('write tier can change secrets and capabilities but not delete, destroy data or share', () => {
  const html = render('write');
  assert.ok(!html.includes('Danger zone'));
  assert.ok(html.includes('/secrets/api-credentials/delete'));
  assert.ok(html.includes('action="/projects/11111111-1111-1111-1111-111111111111/secrets"'));
  assert.ok(html.includes('/postgres/disable'), 'can remove postgres (data kept)');
  assert.ok(!html.includes('name="destroy_data"'), 'destroy-data checkbox hidden');
  assert.ok(!html.includes('Add people'));
  assert.ok(html.includes('Sharing is managed by the project owner and project admins.'));
  assert.ok(html.includes('Your access:'));
  assert.ok(html.includes('shared with you by the owner'));
});

test('read tier is view-only', () => {
  const html = render('read');
  assert.ok(!html.includes('Danger zone'));
  assert.ok(!html.includes('/secrets/api-credentials/delete'));
  assert.ok(!html.includes('action="/projects/11111111-1111-1111-1111-111111111111/secrets"'));
  assert.ok(html.includes('You need write access on this project to add or remove secrets.'));
  assert.ok(!html.includes('/postgres/disable'));
  assert.ok(!html.includes('/storage/enable'));
  assert.ok(html.includes('You need write access on this project to change this.'));
  assert.ok(html.includes('api-credentials'), 'secret names are still listed');
});

test('platform admin viewing someone else\'s project is labelled as such', () => {
  const html = render('admin', false, true);
  assert.ok(html.includes('Danger zone'));
  assert.ok(html.includes('(platform admin)'));
});
