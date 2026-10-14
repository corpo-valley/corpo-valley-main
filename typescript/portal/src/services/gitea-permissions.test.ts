import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseCollaboratorPermission, roleNameToPermission } from './gitea';

test('inline permissions collapse to admin/write/read', () => {
  assert.equal(collapseCollaboratorPermission({ admin: true, push: true, pull: true }), 'admin');
  assert.equal(collapseCollaboratorPermission({ admin: false, push: true, pull: true }), 'write');
  assert.equal(collapseCollaboratorPermission({ admin: false, push: false, pull: true }), 'read');
});

test('absent permissions (Gitea 1.22 list) is null, not read', () => {
  assert.equal(collapseCollaboratorPermission(undefined), null);
  assert.equal(collapseCollaboratorPermission(null), null);
});

test('per-collaborator role names map to our levels', () => {
  assert.equal(roleNameToPermission('owner'), 'admin');
  assert.equal(roleNameToPermission('admin'), 'admin');
  assert.equal(roleNameToPermission('write'), 'write');
  assert.equal(roleNameToPermission('read'), 'read');
  assert.equal(roleNameToPermission('none'), null);
  assert.equal(roleNameToPermission(undefined), null);
});
