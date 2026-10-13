import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectTierFromGrants, tierAtLeast, tierRequiredMessage } from './project-tier';

const project = { owner_id: 'owner-1' };

test('owner and platform admins are always admin', () => {
  assert.equal(projectTierFromGrants(project, 'owner-1', false, []), 'admin');
  assert.equal(projectTierFromGrants(project, 'someone', true, []), 'admin');
});

test('no grants means no access', () => {
  assert.equal(projectTierFromGrants(project, 'someone', false, []), 'none');
});

test('tier is the highest level across both facets of every grant', () => {
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: 'read', repo_perm: null }]), 'read');
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: null, repo_perm: 'write' }]), 'write');
  assert.equal(projectTierFromGrants(project, 'u', false, [
    { site_perm: 'read', repo_perm: null },   // everyone grant
    { site_perm: null, repo_perm: 'admin' },  // direct grant
  ]), 'admin');
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: 'admin', repo_perm: 'read' }]), 'admin');
});

test('tierAtLeast follows none < read < write < admin', () => {
  assert.ok(tierAtLeast('admin', 'read'));
  assert.ok(tierAtLeast('write', 'write'));
  assert.ok(!tierAtLeast('write', 'admin'));
  assert.ok(!tierAtLeast('read', 'write'));
  assert.ok(!tierAtLeast('none', 'read'));
});

test('403 copy names the missing level', () => {
  assert.match(tierRequiredMessage('admin'), /project admins/);
  assert.match(tierRequiredMessage('write'), /write access/);
});
