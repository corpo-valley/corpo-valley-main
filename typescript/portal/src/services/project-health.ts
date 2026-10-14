// Project health — the data behind /admin/health. One snapshot per project,
// assembled from the project namespace (pods, warning events, ResourceQuota,
// metrics.k8s.io) and the project's ArgoCD Application, then scored
// red/amber/green by the pure rules at the bottom of this file.
//
// Every lookup is best-effort: a failing call records a line in
// `snapshot.warnings` and leaves that section empty, so one broken API (most
// likely metrics.k8s.io when the SA lacks the RBAC → 403) never takes down the
// page. Snapshots are cached per slug for CACHE_TTL_MS so a page load does not
// fan out to the API server on every request.
import {
  k8sEnabled, k8sListNamespaced, k8sGetRaw, k8sPodLogs, readTenantQuota, getArgoApplication,
  K8sApiError,
} from './k8s';
import { Project } from './projects';

export const CACHE_TTL_MS = 30_000;
export const RECENT_WINDOW_MS = 60 * 60 * 1000;
export const COLLECT_CONCURRENCY = 4;
export const QUOTA_AMBER_FRACTION = 0.8;

const CV_PROJECTS_ARGOCD_NAMESPACE = process.env.CV_PROJECTS_ARGOCD_NAMESPACE || 'cv-projects-argocd';

// ── Snapshot types ──────────────────────────────────────────────────────────

export interface ContainerHealth {
  name: string;
  image: string;
  imageTag: string;                 // the part after the last ':' (or 'latest' / digest marker)
  init: boolean;                    // from initContainerStatuses
  ready: boolean;
  state: 'running' | 'waiting' | 'terminated' | 'unknown';
  waitingReason: string | null;     // state.waiting.reason, e.g. CrashLoopBackOff
  restarts: number;                 // restartCount
  lastTerminatedReason: string | null;  // lastState.terminated.reason, e.g. OOMKilled
  lastTerminatedAt: string | null;      // lastState.terminated.finishedAt (ISO)
  terminatedReason: string | null;      // state.terminated.reason when the container is currently terminated
}

export interface PodHealth {
  name: string;
  phase: string;                    // Pending | Running | Succeeded | Failed | Unknown
  readyContainers: number;
  totalContainers: number;
  restarts: number;                 // sum of restartCount
  restartsLastHour: number;         // containers whose last termination finished within the window
  containers: ContainerHealth[];
  cpuMillicores: number | null;     // from metrics.k8s.io, summed over containers
  memoryBytes: number | null;
  startedAt: string | null;
}

export interface WarningEvent {
  reason: string;
  message: string;
  count: number;
  lastTimestamp: string | null;
  involvedKind: string;
  involvedName: string;
}

export interface QuotaUsage {
  cpuUsed: string | null;           // requests.cpu status.used
  cpuHard: string | null;
  cpuFraction: number | null;
  memoryUsed: string | null;        // requests.memory
  memoryHard: string | null;
  memoryFraction: number | null;
  podsUsed: string | null;
  podsHard: string | null;
}

export interface ArgoSummary {
  sync: string;                     // Synced | OutOfSync | Unknown
  health: string;                   // Healthy | Progressing | Degraded | Suspended | Missing | Unknown
  message: string | null;
  revision: string | null;
}

export interface ProjectHealthSnapshot {
  slug: string;
  name: string;
  projectStatus: string;            // provisioning | ready | failed
  pods: PodHealth[];
  events: WarningEvent[];           // Warning events in the window, newest first
  quota: QuotaUsage | null;
  metrics: { cpuMillicores: number; memoryBytes: number } | null;  // null = metrics unavailable
  argo: ArgoSummary | null;         // null = Application not found / not readable
  warnings: string[];               // lookups that failed, one line each
  collectedAt: string;              // ISO
}

export type HealthLevel = 'red' | 'amber' | 'green';
export interface HealthScore { level: HealthLevel; reasons: string[]; }

// ── Pure helpers ────────────────────────────────────────────────────────────

// Kubernetes quantity → number in base units (cores for cpu, bytes for memory,
// plain count otherwise). Accepts the decimal SI suffixes (n, u, m, k, M, G, T,
// P, E), the binary ones (Ki..Ei), exponents (1e3) and bare numbers. metrics.k8s.io
// reports cpu in nanocores ("733909n") — hence `n`/`u`, which the quota-side
// parser in platform-config does not need. NaN for anything unparseable.
const QTY_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))([eE][+-]?\d+|n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const QTY_SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3,
  k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};
export function parseQuantity(s: string | null | undefined): number {
  if (typeof s !== 'string') return NaN;
  const m = QTY_RE.exec(s.trim());
  if (!m) return NaN;
  const tail = m[2];
  if (!tail) return Number(m[1]);
  if (tail[0] === 'e' || tail[0] === 'E') return Number(m[1] + tail);
  return Number(m[1]) * QTY_SUFFIX[tail];
}

// used/hard as a fraction (0.5 = 50 %). null when either side is missing,
// unparseable, or hard is zero.
export function quotaFraction(used: string | null | undefined, hard: string | null | undefined): number | null {
  const u = parseQuantity(used);
  const h = parseQuantity(hard);
  if (!Number.isFinite(u) || !Number.isFinite(h) || h <= 0) return null;
  return u / h;
}

// Is `ts` (ISO) within `windowMs` before `now` (ms epoch)? Future timestamps
// (clock skew) count as recent; missing/invalid never do.
export function isRecent(ts: string | null | undefined, now: number, windowMs: number): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return now - t <= windowMs;
}

export function imageTagOf(image: string): string {
  const at = image.indexOf('@');
  if (at >= 0) return 'digest';
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon > slash) return image.slice(colon + 1);
  return 'latest';
}

const RED_WAITING = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull']);
const AMBER_EVENT_REASONS = new Set(['FailedScheduling', 'BackOff', 'Unhealthy']);

// The scoring rules. `now` defaults to the snapshot's collection time so a
// cached snapshot scores the same way every time it is rendered.
export function scoreProject(s: ProjectHealthSnapshot, now?: number): HealthScore {
  const at = now ?? (Date.parse(s.collectedAt) || Date.now());
  const red: string[] = [];
  const amber: string[] = [];

  // The portal's own view of the project comes first: a failed provisioning
  // has nothing healthy to show, and a provisioning one is not settled yet.
  if (s.projectStatus === 'failed') red.push('project provisioning failed');
  else if (s.projectStatus === 'provisioning') amber.push('project still provisioning');

  for (const pod of s.pods) {
    if (pod.phase === 'Failed') red.push(`pod ${pod.name} is Failed`);
    for (const c of pod.containers) {
      if (c.waitingReason && RED_WAITING.has(c.waitingReason)) {
        // A project still on the template's `:bootstrap` placeholder tag has
        // simply not had its first successful build yet: the image does not
        // exist, so ImagePullBackOff is the expected state, not an outage.
        if (c.imageTag === 'bootstrap' && c.waitingReason !== 'CrashLoopBackOff') {
          amber.push(`${pod.name}/${c.name} awaiting first build (image :bootstrap not built yet)`);
        } else {
          red.push(`${pod.name}/${c.name} ${c.waitingReason}`);
        }
      }
      // OOMKilled either as the last termination (restarted since) or as the
      // current terminal state (restartPolicy Never/OnFailure).
      if (c.terminatedReason === 'OOMKilled') {
        red.push(`${pod.name}/${c.name} OOMKilled`);
      } else if (c.lastTerminatedReason === 'OOMKilled' && isRecent(c.lastTerminatedAt, at, RECENT_WINDOW_MS)) {
        red.push(`${pod.name}/${c.name} OOMKilled in the last hour`);
      }
    }
    if (pod.restartsLastHour > 0) {
      amber.push(`${pod.name}: ${pod.restartsLastHour} container${pod.restartsLastHour === 1 ? '' : 's'} restarted in the last hour`);
    }
  }

  if (s.argo) {
    if (s.argo.health === 'Degraded' || s.argo.health === 'Missing') red.push(`Argo health ${s.argo.health}`);
    else if (s.argo.health === 'Progressing') amber.push('Argo Progressing');
    if (s.argo.sync === 'OutOfSync') amber.push('Argo OutOfSync');
  }

  const eventReasons = new Map<string, number>();
  for (const e of s.events) {
    if (!AMBER_EVENT_REASONS.has(e.reason)) continue;
    if (!isRecent(e.lastTimestamp, at, RECENT_WINDOW_MS)) continue;
    eventReasons.set(e.reason, (eventReasons.get(e.reason) ?? 0) + 1);
  }
  for (const [reason, n] of eventReasons) amber.push(`${n} ${reason} event${n === 1 ? '' : 's'} in the last hour`);

  if (s.quota) {
    if (s.quota.cpuFraction !== null && s.quota.cpuFraction >= QUOTA_AMBER_FRACTION) {
      amber.push(`CPU requests at ${Math.round(s.quota.cpuFraction * 100)}% of quota`);
    }
    if (s.quota.memoryFraction !== null && s.quota.memoryFraction >= QUOTA_AMBER_FRACTION) {
      amber.push(`memory requests at ${Math.round(s.quota.memoryFraction * 100)}% of quota`);
    }
  }

  if (red.length) return { level: 'red', reasons: [...red, ...amber] };
  if (amber.length) return { level: 'amber', reasons: amber };
  return { level: 'green', reasons: [] };
}

// One row of the /admin/health table — a view model the template renders.
export interface HealthIndexRow {
  slug: string;
  name: string;
  level: HealthLevel;
  reasons: string[];
  podsReady: number;
  podsTotal: number;
  restartsLastHour: number;
  worstEvent: string | null;        // "<reason> ×<count> <kind>/<name>" or null
  cpuPct: number | null;            // requests.cpu used/hard, 0–100+
  memPct: number | null;
  argoSync: string | null;
  argoHealth: string | null;
  warnings: string[];
  collectedAt: string;
}

const LEVEL_ORDER: Record<HealthLevel, number> = { red: 0, amber: 1, green: 2 };

// red → amber → green, then by name (case-insensitive), then slug. Returns a
// new array; the input is left alone.
export function sortHealthRows<T extends { level: HealthLevel; name: string; slug: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
    || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
    || a.slug.localeCompare(b.slug));
}

// The event we surface in the overview: an amber-rule reason wins over any
// other Warning, then the most recent.
export function worstEvent(events: WarningEvent[]): WarningEvent | null {
  if (!events.length) return null;
  const ranked = [...events].sort((a, b) =>
    (AMBER_EVENT_REASONS.has(a.reason) ? 0 : 1) - (AMBER_EVENT_REASONS.has(b.reason) ? 0 : 1)
    || (Date.parse(b.lastTimestamp || '') || 0) - (Date.parse(a.lastTimestamp || '') || 0));
  return ranked[0];
}

export function toHealthRow(s: ProjectHealthSnapshot, score: HealthScore = scoreProject(s)): HealthIndexRow {
  const pct = (f: number | null) => (f === null ? null : Math.round(f * 100));
  const ev = worstEvent(s.events);
  return {
    slug: s.slug,
    name: s.name,
    level: score.level,
    reasons: score.reasons,
    podsReady: s.pods.filter((p) => p.phase === 'Running' && p.readyContainers === p.totalContainers).length,
    // Completed Jobs/hooks (Succeeded) are not unready pods; leave them out.
    podsTotal: s.pods.filter((p) => p.phase !== 'Succeeded').length,
    restartsLastHour: s.pods.reduce((n, p) => n + p.restartsLastHour, 0),
    worstEvent: ev ? `${ev.reason}${ev.count > 1 ? ` ×${ev.count}` : ''} ${ev.involvedKind}/${ev.involvedName}` : null,
    cpuPct: pct(s.quota?.cpuFraction ?? null),
    memPct: pct(s.quota?.memoryFraction ?? null),
    argoSync: s.argo?.sync ?? null,
    argoHealth: s.argo?.health ?? null,
    warnings: s.warnings,
    collectedAt: s.collectedAt,
  };
}

// Optional deep link into the operator's log store (SigNoz etc.). CV_LOGS_URL
// is a template: `{slug}` is replaced with the project namespace; without the
// placeholder the slug is appended as a `namespace` query parameter. Unset →
// null → the templates omit the link.
export function logsUrlFor(slug: string, template: string | undefined = process.env.CV_LOGS_URL): string | null {
  const t = (template || '').trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  const enc = encodeURIComponent(slug);
  if (t.includes('{slug}')) return t.split('{slug}').join(enc);
  return `${t}${t.includes('?') ? '&' : '?'}namespace=${enc}`;
}

// ── Collection ──────────────────────────────────────────────────────────────

function errLine(what: string, err: unknown): string {
  if (err instanceof K8sApiError) {
    if (err.status === 403) return `${what}: forbidden (portal ServiceAccount lacks RBAC)`;
    if (err.status === 404) return `${what}: not found`;
    return `${what}: API ${err.status}`;
  }
  return `${what}: ${(err as any)?.message || String(err)}`;
}

function containerFrom(cs: any, init: boolean): ContainerHealth {
  const state = cs?.state || {};
  const kind: ContainerHealth['state'] = state.running ? 'running'
    : state.waiting ? 'waiting'
    : state.terminated ? 'terminated'
    : 'unknown';
  const image = String(cs?.image || '');
  return {
    name: String(cs?.name || ''),
    image,
    imageTag: imageTagOf(image),
    init,
    ready: Boolean(cs?.ready),
    state: kind,
    waitingReason: state.waiting?.reason || null,
    restarts: Number(cs?.restartCount) || 0,
    lastTerminatedReason: cs?.lastState?.terminated?.reason || null,
    lastTerminatedAt: cs?.lastState?.terminated?.finishedAt || null,
    terminatedReason: state.terminated?.reason || null,
  };
}

// Exported for tests: fold a raw Pod object into PodHealth.
export function podFrom(pod: any, now: number): PodHealth {
  const statuses: any[] = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : [];
  const initStatuses: any[] = Array.isArray(pod?.status?.initContainerStatuses) ? pod.status.initContainerStatuses : [];
  const containers = [
    ...initStatuses.map((c) => containerFrom(c, true)),
    ...statuses.map((c) => containerFrom(c, false)),
  ];
  const specTotal = Array.isArray(pod?.spec?.containers) ? pod.spec.containers.length : statuses.length;
  const main = containers.filter((c) => !c.init);
  return {
    name: String(pod?.metadata?.name || ''),
    phase: String(pod?.status?.phase || 'Unknown'),
    readyContainers: main.filter((c) => c.ready).length,
    totalContainers: specTotal,
    restarts: containers.reduce((n, c) => n + c.restarts, 0),
    restartsLastHour: containers.filter((c) => c.restarts > 0 && isRecent(c.lastTerminatedAt, now, RECENT_WINDOW_MS)).length,
    containers,
    cpuMillicores: null,
    memoryBytes: null,
    startedAt: pod?.status?.startTime || null,
  };
}

// Exported for tests: fold a core/v1 Event into WarningEvent (null when it is
// outside the window). Core events carry lastTimestamp; events written through
// events.k8s.io land in core/v1 with eventTime + series instead, so fall back.
export function eventFrom(ev: any, now: number): WarningEvent | null {
  const last: string | null = ev?.lastTimestamp || ev?.series?.lastObservedTime || ev?.eventTime
    || ev?.firstTimestamp || ev?.metadata?.creationTimestamp || null;
  if (!isRecent(last, now, RECENT_WINDOW_MS)) return null;
  return {
    reason: String(ev?.reason || 'Unknown'),
    message: String(ev?.message || ev?.note || ''),
    count: Number(ev?.count ?? ev?.series?.count) || 1,
    lastTimestamp: last,
    involvedKind: String(ev?.involvedObject?.kind || ev?.regarding?.kind || '?'),
    involvedName: String(ev?.involvedObject?.name || ev?.regarding?.name || '?'),
  };
}

export async function collectProjectHealth(project: Project, now: number = Date.now()): Promise<ProjectHealthSnapshot> {
  const snap: ProjectHealthSnapshot = {
    slug: project.slug,
    name: project.name,
    projectStatus: project.status,
    pods: [],
    events: [],
    quota: null,
    metrics: null,
    argo: null,
    warnings: [],
    collectedAt: new Date(now).toISOString(),
  };
  if (project.status !== 'ready') {
    snap.warnings.push(`project is ${project.status} — no namespace to inspect`);
    return snap;
  }
  if (!k8sEnabled()) {
    snap.warnings.push('Kubernetes integration disabled');
    return snap;
  }
  const ns = project.slug;

  const podsP = k8sListNamespaced<any>({ apiGroup: '', version: 'v1', plural: 'pods', namespace: ns })
    .then((list) => { snap.pods = (list?.items || []).map((p: any) => podFrom(p, now)); })
    .catch((err) => { snap.warnings.push(errLine('pods', err)); });

  const eventsP = k8sListNamespaced<any>(
    { apiGroup: '', version: 'v1', plural: 'events', namespace: ns },
    { fieldSelector: 'type=Warning' },
  )
    .then((list) => {
      snap.events = (list?.items || [])
        .map((e: any) => eventFrom(e, now))
        .filter((e: WarningEvent | null): e is WarningEvent => e !== null)
        .sort((a: WarningEvent, b: WarningEvent) => (Date.parse(b.lastTimestamp || '') || 0) - (Date.parse(a.lastTimestamp || '') || 0));
    })
    .catch((err) => { snap.warnings.push(errLine('events', err)); });

  const quotaP = readTenantQuota(ns)
    .then((q) => {
      if (!q) return;
      const used = q.used || {};
      const hard = q.hard || {};
      snap.quota = {
        cpuUsed: used['requests.cpu'] ?? null,
        cpuHard: hard['requests.cpu'] ?? null,
        cpuFraction: quotaFraction(used['requests.cpu'], hard['requests.cpu']),
        memoryUsed: used['requests.memory'] ?? null,
        memoryHard: hard['requests.memory'] ?? null,
        memoryFraction: quotaFraction(used['requests.memory'], hard['requests.memory']),
        podsUsed: used['pods'] ?? null,
        podsHard: hard['pods'] ?? null,
      };
    })
    .catch((err) => { snap.warnings.push(errLine('quota', err)); });

  // Per-pod usage, attached to the pod list once both lookups have settled.
  let perPod: Map<string, { cpu: number; mem: number }> | null = null;
  const metricsP = k8sGetRaw<any>(`/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(ns)}/pods`)
    .then((list) => {
      perPod = new Map<string, { cpu: number; mem: number }>();
      for (const item of list?.items || []) {
        let cpu = 0; let mem = 0;
        for (const c of item?.containers || []) {
          const cc = parseQuantity(c?.usage?.cpu);
          const mm = parseQuantity(c?.usage?.memory);
          if (Number.isFinite(cc)) cpu += cc;
          if (Number.isFinite(mm)) mem += mm;
        }
        perPod.set(String(item?.metadata?.name || ''), { cpu, mem });
      }
      const all = [...perPod.values()];
      snap.metrics = {
        cpuMillicores: Math.round(all.reduce((n, v) => n + v.cpu, 0) * 1000),
        memoryBytes: Math.round(all.reduce((n, v) => n + v.mem, 0)),
      };
    })
    .catch((err) => { snap.warnings.push(errLine('metrics (metrics.k8s.io)', err)); });

  const argoP = getArgoApplication({ name: ns, namespace: CV_PROJECTS_ARGOCD_NAMESPACE })
    .then((app) => {
      if (!app) { snap.warnings.push('Argo Application not found'); return; }
      snap.argo = {
        sync: app.sync.status,
        health: app.health.status,
        message: app.health.message || app.operationState?.message || null,
        revision: app.sync.revision ? app.sync.revision.slice(0, 8) : null,
      };
    })
    .catch((err) => { snap.warnings.push(errLine('Argo Application', err)); });

  await Promise.all([podsP, eventsP, quotaP, metricsP, argoP]);

  if (perPod) {
    const usage: Map<string, { cpu: number; mem: number }> = perPod;
    for (const pod of snap.pods) {
      const u = usage.get(pod.name);
      if (u) { pod.cpuMillicores = Math.round(u.cpu * 1000); pod.memoryBytes = Math.round(u.mem); }
    }
  }
  return snap;
}

// ── Cache + fan-out ─────────────────────────────────────────────────────────

interface CacheEntry { snapshot: ProjectHealthSnapshot; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProjectHealthSnapshot>>();

export function clearHealthCache(): void { cache.clear(); inflight.clear(); }

// Cached snapshot for one project; collects on a miss. Concurrent callers for
// the same slug share one collection.
export async function getProjectHealth(project: Project, opts: { force?: boolean } = {}): Promise<ProjectHealthSnapshot> {
  const now = Date.now();
  const hit = cache.get(project.slug);
  if (!opts.force && hit && hit.expiresAt > now) return hit.snapshot;
  const pending = inflight.get(project.slug);
  if (pending) return pending;
  const p = collectProjectHealth(project, now)
    .then((snapshot) => {
      cache.set(project.slug, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
      return snapshot;
    })
    .finally(() => { inflight.delete(project.slug); });
  inflight.set(project.slug, p);
  return p;
}

// Run `fn` over `items` with at most `limit` in flight. Exported for tests.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export async function collectAllProjectHealth(projects: Project[]): Promise<ProjectHealthSnapshot[]> {
  return mapWithConcurrency(projects, COLLECT_CONCURRENCY, (p) => getProjectHealth(p));
}

// Last `tailLines` of one container's log, only for a pod/container that the
// snapshot knows about — the route never passes raw query input to the API.
export async function readContainerLog(
  snap: ProjectHealthSnapshot, pod: string, container: string, tailLines = 200,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const p = snap.pods.find((x) => x.name === pod);
  const c = p?.containers.find((x) => x.name === container);
  if (!p || !c) return { ok: false, error: 'Unknown pod or container for this project.' };
  try {
    const text = await k8sPodLogs({ namespace: snap.slug, pod: p.name, container: c.name, tailLines });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: errLine('logs', err) };
  }
}
