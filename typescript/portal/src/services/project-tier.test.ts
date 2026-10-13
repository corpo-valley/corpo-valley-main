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

test('read and write come from the repo facet, like the MCP tools', () => {
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: null, repo_perm: 'read', subject_type: 'user' }]), 'read');
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: null, repo_perm: 'write', subject_type: 'group' }]), 'write');
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: 'write', repo_perm: null, subject_type: 'user' }]), 'none',
    'site write is an app-level class, not project management');
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: 'read', repo_perm: 'write', subject_type: 'user' }]), 'write');
});

test('admin on either facet makes a project admin', () => {
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: 'admin', repo_perm: null, subject_type: 'user' }]), 'admin');
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: null, repo_perm: 'admin', subject_type: 'group' }]), 'admin');
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: 'admin', repo_perm: 'read', subject_type: 'user' }]), 'admin');
});

test('everyone grants never confer a portal tier', () => {
  assert.equal(projectTierFromGrants(project, 'u', false, [{ site_perm: 'write', repo_perm: 'write', subject_type: 'everyone' }]), 'none');
  assert.equal(projectTierFromGrants(project, 'u', false, [
    { site_perm: 'write', repo_perm: 'read', subject_type: 'everyone' },
    { site_perm: null, repo_perm: 'read', subject_type: 'user' },
  ]), 'read', 'an explicit grant still counts alongside an everyone row');
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
