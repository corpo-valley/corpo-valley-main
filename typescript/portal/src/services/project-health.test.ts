import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreProject, quotaFraction, parseQuantity, isRecent, sortHealthRows, toHealthRow,
  podFrom, eventFrom, logsUrlFor, mapWithConcurrency, worstEvent,
  ProjectHealthSnapshot, PodHealth, ContainerHealth, HealthIndexRow,
} from './project-health';
import { renderAdminHealthIndex, renderAdminHealthDetail } from '../templates';

const NOW = Date.parse('2026-10-14T22:00:00Z');
const RECENT = '2026-10-14T21:40:00Z';   // 20 min ago
const OLD = '2026-10-14T19:00:00Z';      // 3 h ago

function container(over: Partial<ContainerHealth> = {}): ContainerHealth {
  return {
    name: 'web', image: 'registry/x/web:abc', imageTag: 'abc', init: false, ready: true,
    state: 'running', waitingReason: null, restarts: 0, lastTerminatedReason: null, lastTerminatedAt: null,
    ...over,
  };
}

function pod(over: Partial<PodHealth> = {}, containers: ContainerHealth[] = [container()]): PodHealth {
  return {
    name: 'web-1', phase: 'Running', readyContainers: containers.filter((c) => c.ready).length,
    totalContainers: containers.length, restarts: containers.reduce((n, c) => n + c.restarts, 0),
    restartsLastHour: 0, containers, cpuMillicores: null, memoryBytes: null, startedAt: null,
    ...over,
  };
}

function snapshot(over: Partial<ProjectHealthSnapshot> = {}): ProjectHealthSnapshot {
  return {
    slug: 'shop', name: 'Shop', projectStatus: 'ready',
    pods: [pod()], events: [], quota: null, metrics: null,
    argo: { sync: 'Synced', health: 'Healthy', message: null, revision: 'abcdef12' },
    warnings: [], collectedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

// ── scoring ─────────────────────────────────────────────────────────────────

test('green when everything is quiet', () => {
  const s = snapshot({ quota: { cpuUsed: '200m', cpuHard: '2', cpuFraction: 0.1, memoryUsed: '640Mi', memoryHard: '2Gi', memoryFraction: 0.3125, podsUsed: '3', podsHard: '12' } });
  assert.deepEqual(scoreProject(s, NOW), { level: 'green', reasons: [] });
});

test('red: CrashLoopBackOff / ImagePullBackOff / ErrImagePull waiting reasons', () => {
  for (const reason of ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull']) {
    const s = snapshot({ pods: [pod({}, [container({ state: 'waiting', ready: false, waitingReason: reason })])] });
    const r = scoreProject(s, NOW);
    assert.equal(r.level, 'red', reason);
    assert.ok(r.reasons[0].includes(reason));
  }
});

test('red: OOMKilled only when the termination is within the last hour', () => {
  const recent = snapshot({ pods: [pod({}, [container({ restarts: 1, lastTerminatedReason: 'OOMKilled', lastTerminatedAt: RECENT })])] });
  assert.equal(scoreProject(recent, NOW).level, 'red');
  const old = snapshot({ pods: [pod({}, [container({ restarts: 1, lastTerminatedReason: 'OOMKilled', lastTerminatedAt: OLD })])] });
  assert.equal(scoreProject(old, NOW).level, 'green');
});

test('red: Failed pod phase; Argo Degraded or Missing', () => {
  assert.equal(scoreProject(snapshot({ pods: [pod({ phase: 'Failed' })] }), NOW).level, 'red');
  assert.equal(scoreProject(snapshot({ argo: { sync: 'Synced', health: 'Degraded', message: null, revision: null } }), NOW).level, 'red');
  assert.equal(scoreProject(snapshot({ argo: { sync: 'Synced', health: 'Missing', message: null, revision: null } }), NOW).level, 'red');
});

test('amber: restarts in the last hour', () => {
  const r = scoreProject(snapshot({ pods: [pod({ restartsLastHour: 2 })] }), NOW);
  assert.equal(r.level, 'amber');
  assert.match(r.reasons[0], /restarted 2×/);
});

test('amber: FailedScheduling / BackOff / Unhealthy warning events, but not other warnings or stale ones', () => {
  const ev = (reason: string, ts: string) => ({ reason, message: 'm', count: 1, lastTimestamp: ts, involvedKind: 'Pod', involvedName: 'web-1' });
  for (const reason of ['FailedScheduling', 'BackOff', 'Unhealthy']) {
    assert.equal(scoreProject(snapshot({ events: [ev(reason, RECENT)] }), NOW).level, 'amber', reason);
  }
  assert.equal(scoreProject(snapshot({ events: [ev('Unhealthy', OLD)] }), NOW).level, 'green', 'stale event ignored');
  assert.equal(scoreProject(snapshot({ events: [ev('FailedMount', RECENT)] }), NOW).level, 'green', 'other reasons do not score');
});

test('amber: cpu or memory requests at or above 80 % of quota', () => {
  const q = { cpuUsed: '1600m', cpuHard: '2', cpuFraction: 0.8, memoryUsed: '1Gi', memoryHard: '2Gi', memoryFraction: 0.5, podsUsed: null, podsHard: null };
  const r = scoreProject(snapshot({ quota: q }), NOW);
  assert.equal(r.level, 'amber');
  assert.match(r.reasons[0], /CPU requests at 80%/);
  assert.equal(scoreProject(snapshot({ quota: { ...q, cpuFraction: 0.79, memoryFraction: 0.81 } }), NOW).reasons[0], 'memory requests at 81% of quota');
  assert.equal(scoreProject(snapshot({ quota: { ...q, cpuFraction: 0.79, memoryFraction: null } }), NOW).level, 'green');
});

test('amber: Argo OutOfSync or Progressing; red reasons are listed before amber ones', () => {
  assert.equal(scoreProject(snapshot({ argo: { sync: 'OutOfSync', health: 'Healthy', message: null, revision: null } }), NOW).level, 'amber');
  assert.equal(scoreProject(snapshot({ argo: { sync: 'Synced', health: 'Progressing', message: null, revision: null } }), NOW).level, 'amber');
  const both = scoreProject(snapshot({
    pods: [pod({ phase: 'Failed', restartsLastHour: 1 })],
    argo: { sync: 'OutOfSync', health: 'Healthy', message: null, revision: null },
  }), NOW);
  assert.equal(both.level, 'red');
  assert.match(both.reasons[0], /Failed/);
  assert.ok(both.reasons.includes('Argo OutOfSync'));
});

// ── quantities / recency ────────────────────────────────────────────────────

test('parseQuantity handles cpu, memory, counts, nanocores and exponents', () => {
  assert.equal(parseQuantity('500m'), 0.5);
  assert.equal(parseQuantity('2'), 2);
  assert.equal(parseQuantity('256Mi'), 256 * 1024 * 1024);
  assert.equal(parseQuantity('1Gi'), 1024 ** 3);
  assert.equal(parseQuantity('1k'), 1000);
  assert.equal(parseQuantity('733909n'), 733909e-9);        // metrics.k8s.io cpu
  assert.equal(parseQuantity('20612Ki'), 20612 * 1024);     // metrics.k8s.io memory
  assert.equal(parseQuantity('1e3'), 1000);
  assert.ok(Number.isNaN(parseQuantity('lots')));
  assert.ok(Number.isNaN(parseQuantity(undefined)));
});

test('quotaFraction divides used by hard across unit families', () => {
  assert.equal(quotaFraction('500m', '2'), 0.25);
  assert.equal(quotaFraction('1Gi', '2Gi'), 0.5);
  assert.equal(quotaFraction('640Mi', '2Gi'), 0.3125);
  assert.equal(quotaFraction('3', '12'), 0.25);
  assert.equal(quotaFraction('1500m', '1'), 1.5);
  assert.equal(quotaFraction(null, '2'), null);
  assert.equal(quotaFraction('1', '0'), null);
  assert.equal(quotaFraction('1', 'x'), null);
});

test('isRecent honours the window and rejects missing or garbage timestamps', () => {
  const hour = 60 * 60 * 1000;
  assert.equal(isRecent(RECENT, NOW, hour), true);
  assert.equal(isRecent(OLD, NOW, hour), false);
  assert.equal(isRecent(new Date(NOW - hour).toISOString(), NOW, hour), true, 'boundary is inclusive');
  assert.equal(isRecent(new Date(NOW + 60_000).toISOString(), NOW, hour), true, 'clock skew → still recent');
  assert.equal(isRecent(null, NOW, hour), false);
  assert.equal(isRecent('yesterday', NOW, hour), false);
});

// ── rows + sorting ──────────────────────────────────────────────────────────

function row(over: Partial<HealthIndexRow>): HealthIndexRow {
  return {
    slug: 'x', name: 'X', level: 'green', reasons: [], podsReady: 1, podsTotal: 1, restartsLastHour: 0,
    worstEvent: null, cpuPct: null, memPct: null, argoSync: 'Synced', argoHealth: 'Healthy', warnings: [],
    collectedAt: new Date(NOW).toISOString(), ...over,
  };
}

test('sortHealthRows orders red → amber → green, then by name, without mutating the input', () => {
  const input = [
    row({ slug: 'zeta', name: 'Zeta', level: 'green' }),
    row({ slug: 'beta', name: 'beta', level: 'amber' }),
    row({ slug: 'alpha', name: 'Alpha', level: 'green' }),
    row({ slug: 'omega', name: 'Omega', level: 'red' }),
    row({ slug: 'acme', name: 'acme', level: 'amber' }),
  ];
  const copy = [...input];
  const out = sortHealthRows(input);
  assert.deepEqual(out.map((r) => r.slug), ['omega', 'acme', 'beta', 'alpha', 'zeta']);
  assert.deepEqual(input, copy, 'input untouched');
});

test('toHealthRow summarises pods, restarts, quota percentages and the worst event', () => {
  const s = snapshot({
    pods: [
      pod({ name: 'a', restartsLastHour: 1 }),
      pod({ name: 'b', phase: 'Pending', readyContainers: 0 }, [container({ ready: false, state: 'waiting', waitingReason: 'ContainerCreating' })]),
    ],
    events: [
      { reason: 'FailedMount', message: 'x', count: 9, lastTimestamp: RECENT, involvedKind: 'Pod', involvedName: 'b' },
      { reason: 'BackOff', message: 'y', count: 3, lastTimestamp: OLD, involvedKind: 'Pod', involvedName: 'a' },
    ],
    quota: { cpuUsed: '1', cpuHard: '2', cpuFraction: 0.5, memoryUsed: '1Gi', memoryHard: '4Gi', memoryFraction: 0.25, podsUsed: '2', podsHard: '12' },
  });
  const r = toHealthRow(s, scoreProject(s, NOW));
  assert.equal(r.podsReady, 1);
  assert.equal(r.podsTotal, 2);
  assert.equal(r.restartsLastHour, 1);
  assert.equal(r.cpuPct, 50);
  assert.equal(r.memPct, 25);
  assert.equal(r.worstEvent, 'BackOff ×3 Pod/a', 'amber-rule reasons outrank newer plain warnings');
  assert.equal(worstEvent([]), null);
});

// ── object folding (shapes taken from a live cluster) ───────────────────────

test('podFrom folds a live Pod: ready/total, restarts, last termination, recent-restart window, image tag', () => {
  const raw = {
    metadata: { name: 'shop-6d9b9f6b47-n4w9j' },
    spec: { containers: [{ name: 'web' }, { name: 'database' }] },
    status: {
      phase: 'Running', startTime: '2026-06-17T18:15:32Z',
      containerStatuses: [
        {
          name: 'web', image: 'registry.cv-registry.svc.cluster.local:5000/demouser/shop:20260614225534', ready: true,
          restartCount: 20, state: { running: { startedAt: '2026-10-02T13:56:12Z' } },
          lastState: { terminated: { exitCode: 1, finishedAt: RECENT, reason: 'Error' } },
        },
        {
          name: 'database', image: 'postgres:16-alpine', ready: false, restartCount: 5,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
          lastState: { terminated: { exitCode: 137, finishedAt: OLD, reason: 'OOMKilled' } },
        },
      ],
    },
  };
  const p = podFrom(raw, NOW);
  assert.equal(p.readyContainers, 1);
  assert.equal(p.totalContainers, 2);
  assert.equal(p.restarts, 25);
  assert.equal(p.restartsLastHour, 1, 'only the container whose last termination is within the hour');
  assert.equal(p.containers[0].imageTag, '20260614225534');
  assert.equal(p.containers[1].imageTag, '16-alpine');
  assert.equal(p.containers[1].waitingReason, 'CrashLoopBackOff');
  assert.equal(p.containers[1].lastTerminatedReason, 'OOMKilled');
  assert.equal(podFrom({ status: {} }, NOW).phase, 'Unknown');
});

test('eventFrom keeps core/v1 Warning events inside the window and drops older ones', () => {
  const raw = {
    reason: 'Unhealthy', message: 'Readiness probe failed', count: 4, type: 'Warning',
    lastTimestamp: RECENT, firstTimestamp: OLD, eventTime: null,
    involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'shop' },
  };
  const e = eventFrom(raw, NOW)!;
  assert.equal(e.reason, 'Unhealthy');
  assert.equal(e.count, 4);
  assert.equal(e.involvedKind, 'Pod');
  assert.equal(e.involvedName, 'web-1');
  assert.equal(eventFrom({ ...raw, lastTimestamp: OLD }, NOW), null);
  // events.k8s.io-shaped (eventTime + series + regarding + note)
  const v1 = eventFrom({ reason: 'BackOff', note: 'n', eventTime: OLD, series: { count: 7, lastObservedTime: RECENT }, regarding: { kind: 'Pod', name: 'p' } }, NOW)!;
  assert.equal(v1.count, 7);
  assert.equal(v1.message, 'n');
});

test('logsUrlFor substitutes {slug} or appends ?namespace=, and is null when unset or not http(s)', () => {
  assert.equal(logsUrlFor('shop', undefined), null);
  assert.equal(logsUrlFor('shop', ''), null);
  assert.equal(logsUrlFor('shop', 'javascript:alert(1)'), null);
  assert.equal(logsUrlFor('a b', 'https://logs.example/logs?ns={slug}'), 'https://logs.example/logs?ns=a%20b');
  assert.equal(logsUrlFor('shop', 'https://logs.example/logs'), 'https://logs.example/logs?namespace=shop');
  assert.equal(logsUrlFor('shop', 'https://logs.example/logs?x=1'), 'https://logs.example/logs?x=1&namespace=shop');
});

test('mapWithConcurrency never exceeds the limit and preserves order', async () => {
  let active = 0; let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
});

// ── templates ───────────────────────────────────────────────────────────────

test('health index renders the red row first and escapes a hostile project name', () => {
  const rows = sortHealthRows([
    row({ slug: 'calm', name: 'Calm <i>site</i>', level: 'green' }),
    row({ slug: 'evil', name: '<script>alert(1)</script>', level: 'red', reasons: ['web-1/web CrashLoopBackOff'], cpuPct: 85, memPct: 12, argoSync: 'OutOfSync', argoHealth: 'Degraded' }),
  ]);
  const html = renderAdminHealthIndex(rows, 'admin@example.com', (slug) => `https://logs.example/?namespace=${slug}`);
  const red = html.indexOf('href="/admin/health/evil"');
  const green = html.indexOf('href="/admin/health/calm"');
  assert.ok(red > 0 && green > red, 'red project row precedes the green one');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'hostile name is escaped');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw name must not leak');
  assert.ok(html.includes('web-1/web CrashLoopBackOff'), 'first reason shown');
  assert.ok(html.includes('>85%<'), 'cpu percent');
  assert.ok(html.includes('href="https://logs.example/?namespace=evil"'), 'SigNoz link uses the resolver');
  assert.ok(html.includes('href="/admin/resources/evil"'), 'Resources link');
  assert.ok(html.includes('class="active"'), 'Health nav link active');
  assert.ok(html.includes('>1 red<') && html.includes('>1 green<'), 'summary counts');
});

test('health index without a logs resolver omits the SigNoz link; empty list shows the help text', () => {
  const html = renderAdminHealthIndex([row({ slug: 'calm', name: 'Calm' })], 'a@b');
  assert.ok(!html.includes('Logs in SigNoz'));
  assert.ok(html.includes('n/a'), 'missing quota percentages render as n/a');
  assert.ok(renderAdminHealthIndex([], 'a@b').includes('<p class="help">No projects yet.</p>'));
});

test('health detail renders pods, events, quota bars, Argo, warnings and an escaped log snippet', () => {
  const s = snapshot({
    name: 'Shop & <Co>',
    pods: [pod({ name: 'web-1', cpuMillicores: 12, memoryBytes: 50 * 1024 * 1024 }, [container({ restarts: 3, lastTerminatedReason: 'OOMKilled', lastTerminatedAt: RECENT })])],
    events: [{ reason: 'Unhealthy', message: 'probe <failed>', count: 2, lastTimestamp: RECENT, involvedKind: 'Pod', involvedName: 'web-1' }],
    quota: { cpuUsed: '200m', cpuHard: '2', cpuFraction: 0.1, memoryUsed: '640Mi', memoryHard: '2Gi', memoryFraction: 0.3125, podsUsed: '3', podsHard: '12' },
    metrics: { cpuMillicores: 12, memoryBytes: 50 * 1024 * 1024 },
    warnings: ['metrics (metrics.k8s.io): forbidden (portal ServiceAccount lacks RBAC)'],
  });
  const html = renderAdminHealthDetail({
    snapshot: s, score: scoreProject(s, NOW),
    logs: { pod: 'web-1', container: 'web', text: 'line 1\n<b>not html</b>', error: null },
    logsUrl: null,
  }, 'admin@example.com');
  assert.ok(html.includes('Health — shop'), 'title carries the slug');
  assert.ok(html.includes('OOMKilled'), 'last terminated reason shown');
  assert.ok(html.includes('?pod=web-1&amp;container=web'), 'per-container logs link');
  assert.ok(html.includes('probe &lt;failed&gt;'), 'event message escaped');
  assert.ok(html.includes('640Mi / 2Gi · 31%'), 'memory quota bar with percent');
  assert.ok(html.includes('<pre class="snippet">line 1\n&lt;b&gt;not html&lt;/b&gt;</pre>'), 'log text escaped');
  assert.ok(html.includes('lacks RBAC'), 'warnings surfaced');
  assert.ok(html.includes('Synced</span> / <span'), 'Argo block');
  assert.ok(html.includes('cached for 30 s'));
  assert.ok(!html.includes('Logs in SigNoz'), 'no CV_LOGS_URL → no link');
});

test('health detail reports a refused log fetch instead of a snippet', () => {
  const s = snapshot();
  const html = renderAdminHealthDetail({
    snapshot: s, score: scoreProject(s, NOW),
    logs: { pod: '../etc', container: 'x', text: null, error: 'Unknown pod or container for this project.' },
    logsUrl: 'https://logs.example/?namespace=shop',
  }, 'a@b');
  assert.ok(html.includes('Unknown pod or container for this project.'));
  assert.ok(!html.includes('<pre class="snippet">'));
  assert.ok(html.includes('href="https://logs.example/?namespace=shop"'));
});
