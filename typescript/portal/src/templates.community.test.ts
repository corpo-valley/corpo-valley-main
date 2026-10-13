import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCommunityFeed, renderCommunityUsers, renderPublicProfile,
  CommunityRow, CommunityUserRow,
} from './templates';

const feedRow: CommunityRow = {
  name: 'Garden <b>Planner</b>', slug: 'garden', creator: 'ana@example.com', sitePerm: 'read',
  createdAt: '1/1/2026', updatedAt: '1/2/2026', createdRel: '2d ago', updatedRel: '1d ago',
  creatorUsername: 'ana', visitors: 3, builds: 1, contributors: 0, trending: false,
};

test('community feed no longer shows user badges on project rows', () => {
  const html = renderCommunityFeed('me@example.com', [feedRow], false, 'created', 'desc');
  assert.ok(!html.includes('class="badge badge-achievement"'), 'badge chips must not appear on project rows');
  assert.ok(html.includes('href="/community/users"'), 'feed links to the Users tab');
  assert.ok(html.includes('class="cv-tab active" href="/community"'), 'Projects tab is active');
  assert.ok(html.includes('Garden &lt;b&gt;Planner&lt;/b&gt;'), 'project name is escaped');
  assert.ok(html.includes('colspan="6"'), 'no-match row spans every column');
});

test('users tab lists residents with badges and shared projects, escaped', () => {
  const rows: CommunityUserRow[] = [
    {
      displayName: 'Ana <Script>', username: 'ana',
      badges: [{ key: 'welcome', name: 'Welcome & Hello', emoji: '👋' }],
      projects: [{ name: 'Garden "Planner"', slug: 'garden' }],
    },
    { displayName: 'bob@example.com', badges: [], projects: [] },
  ];
  const html = renderCommunityUsers('me@example.com', rows, false, 'badges');
  assert.ok(html.includes('class="cv-tab active" href="/community/users"'), 'Users tab is active');
  assert.ok(html.includes('href="/achievements/u/ana"'), 'resident links to the public profile');
  assert.ok(html.includes('Ana &lt;Script&gt;'), 'display name is escaped');
  assert.ok(!html.includes('Ana <Script>'), 'raw display name must not leak');
  assert.ok(html.includes('class="badge badge-achievement"'), 'badge chips render on the Users tab');
  assert.ok(html.includes('Welcome &amp; Hello'), 'badge name is escaped');
  assert.ok(html.includes('Garden &quot;Planner&quot; ↗'), 'shared project renders as an escaped site link');
  assert.ok(html.includes('none yet') && html.includes('nothing shared'), 'empty states for a resident with nothing');
  assert.ok(html.includes('/community/users?sort=name'), 'quick sort links exist');
});

test('users tab empty state', () => {
  const html = renderCommunityUsers('me@example.com', [], false, 'badges');
  assert.ok(html.includes('No residents yet'));
});

test('public profile shows the shared projects section', () => {
  const html = renderPublicProfile('me@example.com', false, 'Ana', [], [{ name: 'Garden', slug: 'garden' }]);
  assert.ok(html.includes('Shared projects'));
  assert.ok(html.includes('https://garden.'), 'links to the project site');
  const none = renderPublicProfile('me@example.com', false, 'Ana', []);
  assert.ok(none.includes('Nothing shared with everyone yet.'));
});
