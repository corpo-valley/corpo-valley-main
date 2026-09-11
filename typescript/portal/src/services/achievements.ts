// Achievements & badges — the town's "pride board".
//
// Design (see docs/decisions/2026-07-23-achievements-and-badges.md):
//  • cv_activity_events is a lightweight append-only ledger of town activity the
//    other tables don't already capture (PRs, merges, interactions, builds,
//    capability enables, secrets, key connects, CLI tokens). Everything else is
//    derived on read from projects / project_grants / groups.
//  • "Clean slate": every badge is gated on the qualifying row's created_at >=
//    ACHIEVEMENTS_EPOCH, so the feature earns forward from ship day.
//  • recordActivity is best-effort and NEVER throws — a DB hiccup must never
//    break a core action (mirrors the portal's fire-and-forget rule).
//  • Awarded badges are cached in cv_achievement_grants; that cache drives the
//    one-time toast and the cheap "other people's badges" lookup on the feed.
import { pool } from './projects';

// Ship-day cutoff. Overridable per-deploy; defaults to the v0.12.0 ship date.
export const ACHIEVEMENTS_EPOCH = new Date(
  process.env.CV_ACHIEVEMENTS_EPOCH || '2026-07-23T00:00:00.000Z',
);

// The activity kinds the ledger records. `project_interaction` and `pr_authored`
// are "neighbor" events (only stored when the actor is NOT the target owner);
// the rest are self-events describing something you did to your own project.
export type ActivityKind =
  | 'pr_authored'
  | 'project_interaction'
  | 'pr_merged'
  | 'build_shipped'
  | 'capability_enabled'
  | 'secret_added'
  | 'key_connected'
  | 'cli_token'
  | 'project_view';

// Neighbor kinds are only recorded when the actor is NOT the target owner.
const NEIGHBOR_KINDS = new Set<ActivityKind>(['pr_authored', 'project_interaction', 'project_view']);
// Day-capped kinds record at most one row per (actor, project, UTC day).
// project_view (site visits, popularity) and project_interaction (meaningful
// engagement, achievements) are both high-volume, so both are capped. NB they
// are SEPARATE kinds: only project_interaction feeds achievement metrics, so
// counting raw site views doesn't change Town Reporter et al.
const DAY_CAPPED_KINDS = new Set<ActivityKind>(['project_interaction', 'project_view']);

export type BadgeCategory =
  | 'Founding' | 'Shipping' | 'Neighbors' | 'Teams' | 'Contributions'
  | 'Exploration' | 'Capabilities' | 'Craft' | 'Milestones';

export const CATEGORY_ORDER: BadgeCategory[] = [
  'Founding', 'Shipping', 'Contributions', 'Exploration', 'Neighbors',
  'Teams', 'Capabilities', 'Craft', 'Milestones',
];

export interface Badge {
  key: string;
  name: string;
  emoji: string;
  rule: string;
  category: BadgeCategory;
  need: number;
  have: number;
  earned: boolean;
  since?: string;
}

interface CatalogEntry {
  key: string; name: string; emoji: string; rule: string;
  category: BadgeCategory; metric: string; need: number;
}

// The catalog. `metric` names a value computed in computeMetrics(); a badge is
// earned when that value >= need. Order here is the render order within a
// category.
const CATALOG: CatalogEntry[] = [
  // ── Founding (own projects) ──────────────────────────────────────────────
  { key: 'first_post',       name: 'First Post',        emoji: '🌱', category: 'Founding', metric: 'owned', need: 1,  rule: 'Plant your first project.' },
  { key: 'homesteader',      name: 'Homesteader',       emoji: '🏠', category: 'Founding', metric: 'owned', need: 3,  rule: 'Own 3 projects.' },
  { key: 'serial_founder',   name: 'Serial Founder',    emoji: '🏗️', category: 'Founding', metric: 'owned', need: 5,  rule: 'Own 5 projects.' },
  { key: 'land_baron',       name: 'Land Baron',        emoji: '🏰', category: 'Founding', metric: 'owned', need: 10, rule: 'Own 10 projects.' },
  { key: 'valley_tycoon',    name: 'Valley Tycoon',     emoji: '👑', category: 'Founding', metric: 'owned', need: 25, rule: 'Own 25 projects.' },
  // ── Shipping (deploys & builds) ──────────────────────────────────────────
  { key: 'shipped_it',       name: 'Shipped It',        emoji: '🚀', category: 'Shipping', metric: 'ready', need: 1,  rule: 'Get a project to a successful deploy.' },
  { key: 'launch_party',     name: 'Launch Party',      emoji: '🎉', category: 'Shipping', metric: 'ready', need: 3,  rule: 'Have 3 projects deployed.' },
  { key: 'fleet_commander',  name: 'Fleet Commander',   emoji: '🛰️', category: 'Shipping', metric: 'ready', need: 10, rule: 'Have 10 projects deployed.' },
  { key: 'first_build',      name: 'First Build',       emoji: '🔨', category: 'Shipping', metric: 'buildsShipped', need: 1,  rule: 'Ship your first build.' },
  { key: 'ship_shape',       name: 'Ship Shape',        emoji: '📦', category: 'Shipping', metric: 'buildsShipped', need: 10, rule: 'Ship 10 builds.' },
  { key: 'build_baron',      name: 'Build Baron',       emoji: '🏭', category: 'Shipping', metric: 'buildsShipped', need: 50, rule: 'Ship 50 builds.' },
  // ── Contributions (PRs to others) ────────────────────────────────────────
  { key: 'contributor',          name: 'Contributor',          emoji: '🔧', category: 'Contributions', metric: 'prAuthoredTotal', need: 1,  rule: "Open a PR against a repo you don't own." },
  { key: 'prolific_contributor', name: 'Prolific Contributor', emoji: '🛠️', category: 'Contributions', metric: 'prAuthoredRepos', need: 5,  rule: "Open PRs to 5 repos you don't own." },
  { key: 'open_source_hero',     name: 'Open Source Hero',     emoji: '🦸', category: 'Contributions', metric: 'prAuthoredRepos', need: 15, rule: "Open PRs to 15 repos you don't own." },
  { key: 'merge_master',         name: 'Merge Master',         emoji: '🔀', category: 'Contributions', metric: 'prMergedTotal',   need: 1,  rule: 'Merge a pull request.' },
  { key: 'merge_machine',        name: 'Merge Machine',        emoji: '⚙️', category: 'Contributions', metric: 'prMergedTotal',   need: 10, rule: 'Merge 10 pull requests.' },
  { key: 'peer_reviewer',        name: 'Peer Reviewer',        emoji: '👓', category: 'Contributions', metric: 'prMergedNonOwned', need: 1, rule: "Merge a PR on a repo you don't own." },
  // ── Exploration (interacting across the town) ────────────────────────────
  { key: 'neighborly',         name: 'Neighborly',         emoji: '👋', category: 'Exploration', metric: 'interDistinct', need: 1,  rule: "Interact with a project you don't own." },
  { key: 'neighborhood_watch', name: 'Neighborhood Watch', emoji: '👀', category: 'Exploration', metric: 'interDistinct', need: 5,  rule: "Interact with 5 different projects you don't own." },
  { key: 'explorer',           name: 'Explorer',           emoji: '🧭', category: 'Exploration', metric: 'interDistinct', need: 10, rule: "Interact with 10 different projects you don't own." },
  { key: 'cartographer',       name: 'Cartographer',       emoji: '🗺️', category: 'Exploration', metric: 'interDistinct', need: 25, rule: "Interact with 25 different projects you don't own." },
  { key: 'town_reporter',      name: 'Town Reporter',      emoji: '📰', category: 'Exploration', metric: 'reporters',     need: 20, rule: "Interact 3+ times with each of 20 projects you don't own." },
  { key: 'town_crier',         name: 'Town Crier',         emoji: '📣', category: 'Exploration', metric: 'reporters',     need: 40, rule: "Interact 3+ times with each of 40 projects you don't own." },
  { key: 'busybody',           name: 'Busybody',           emoji: '🐝', category: 'Exploration', metric: 'interTotal',    need: 100, rule: 'Rack up 100 town interactions.' },
  // ── Neighbors (sharing your work) ────────────────────────────────────────
  { key: 'good_neighbor',  name: 'Good Neighbor', emoji: '🤝', category: 'Neighbors', metric: 'sharedProjects', need: 1, rule: 'Share one of your projects.' },
  { key: 'open_door',      name: 'Open Door',     emoji: '🚪', category: 'Neighbors', metric: 'everyoneShares', need: 1, rule: 'Make a project internal (shared with everyone).' },
  { key: 'philanthropist', name: 'Philanthropist',emoji: '🎁', category: 'Neighbors', metric: 'sharedProjects', need: 5, rule: 'Share 5 of your projects.' },
  // ── Teams (groups) ───────────────────────────────────────────────────────
  { key: 'team_builder',     name: 'Team Builder',     emoji: '👥', category: 'Teams', metric: 'maxMembers',  need: 1,  rule: 'Create a group and add a member.' },
  { key: 'guild_leader',     name: 'Guild Leader',     emoji: '🛡️', category: 'Teams', metric: 'maxMembers',  need: 5,  rule: 'Grow a group to 5 members.' },
  { key: 'kingmaker',        name: 'Kingmaker',        emoji: '🤴', category: 'Teams', metric: 'maxMembers',  need: 10, rule: 'Grow a group to 10 members.' },
  { key: 'joiner',           name: 'Joiner',           emoji: '🧩', category: 'Teams', metric: 'groupsJoined',need: 1,  rule: "Join someone else's group." },
  { key: 'social_butterfly', name: 'Social Butterfly', emoji: '🦋', category: 'Teams', metric: 'groupsJoined',need: 3,  rule: 'Be a member of 3 groups.' },
  // ── Capabilities (what you build with) ───────────────────────────────────
  { key: 'data_wrangler', name: 'Data Wrangler', emoji: '🗄️', category: 'Capabilities', metric: 'hasDb',       need: 1, rule: 'Enable a database on a project.' },
  { key: 'pack_rat',      name: 'Pack Rat',      emoji: '📦', category: 'Capabilities', metric: 'hasStorage',  need: 1, rule: 'Enable object storage on a project.' },
  { key: 'tool_maker',    name: 'Tool Maker',    emoji: '🔌', category: 'Capabilities', metric: 'hasMcp',      need: 1, rule: 'Give a project an MCP endpoint.' },
  { key: 'full_stack',    name: 'Full Stack',    emoji: '🍔', category: 'Capabilities', metric: 'fullStack',   need: 1, rule: 'Run one project with both a database and storage.' },
  { key: 'triple_threat', name: 'Triple Threat', emoji: '🎯', category: 'Capabilities', metric: 'capsDistinct',need: 3, rule: 'Use all three capabilities (database, storage, MCP).' },
  // ── Craft (secrets, keys, tools) ─────────────────────────────────────────
  { key: 'secret_keeper', name: 'Secret Keeper', emoji: '🔐', category: 'Craft', metric: 'secretsProjects', need: 1, rule: 'Add a sealed secret to a project.' },
  { key: 'locksmith',     name: 'Locksmith',     emoji: '🗝️', category: 'Craft', metric: 'secretsProjects', need: 3, rule: 'Add secrets to 3 projects.' },
  { key: 'connected',     name: 'Connected',     emoji: '🔗', category: 'Craft', metric: 'keysConnected',   need: 1, rule: 'Connect Claude Code (create an API key).' },
  { key: 'power_user',    name: 'Power User',    emoji: '⚡', category: 'Craft', metric: 'keysConnected',   need: 3, rule: 'Create 3 API keys.' },
  { key: 'cli_cowboy',    name: 'CLI Cowboy',    emoji: '🤠', category: 'Craft', metric: 'cliTokens',       need: 1, rule: 'Mint a Gitea CLI token.' },
  // ── Milestones (welcome, time, meta) ─────────────────────────────────────
  { key: 'welcome',         name: 'Welcome to the Valley', emoji: '🌄', category: 'Milestones', metric: 'always',     need: 1,  rule: 'Arrive in Corpo Valley.' },
  { key: 'night_owl',       name: 'Night Owl',      emoji: '🦉', category: 'Milestones', metric: 'nightOwl',   need: 1,  rule: 'Do something between midnight and 5am (UTC).' },
  { key: 'early_bird',      name: 'Early Bird',     emoji: '🐦', category: 'Milestones', metric: 'earlyBird',  need: 1,  rule: 'Do something between 5am and 8am (UTC).' },
  { key: 'lunch_hacker',    name: 'Lunch Break Hacker', emoji: '🥪', category: 'Milestones', metric: 'lunch', need: 1,  rule: 'Do something over the lunch hour (noon UTC).' },
  { key: 'weekend_warrior', name: 'Weekend Warrior',emoji: '🏕️', category: 'Milestones', metric: 'weekend',   need: 1,  rule: 'Do something on a weekend.' },
  { key: 'streak_starter',  name: 'Streak Starter', emoji: '🔥', category: 'Milestones', metric: 'activeDays', need: 3,  rule: 'Be active on 3 different days.' },
  { key: 'on_fire',         name: 'On Fire',        emoji: '🌶️', category: 'Milestones', metric: 'activeDays', need: 7,  rule: 'Be active on 7 different days.' },
  { key: 'dedicated',       name: 'Dedicated',      emoji: '📅', category: 'Milestones', metric: 'activeDays', need: 30, rule: 'Be active on 30 different days.' },
  { key: 'veteran',         name: 'Veteran',        emoji: '🎖️', category: 'Milestones', metric: 'ageDays',    need: 180, rule: 'Be a resident for 6 months.' },
  { key: 'anniversary',     name: 'Anniversary',    emoji: '🎂', category: 'Milestones', metric: 'ageDays',    need: 365, rule: 'Be a resident for a year.' },
  { key: 'completionist',   name: 'Completionist',  emoji: '🏆', category: 'Milestones', metric: 'badgesEarned', need: 25, rule: 'Earn 25 other badges.' },
  { key: 'overachiever',    name: 'Overachiever',   emoji: '🌟', category: 'Milestones', metric: 'badgesEarned', need: 40, rule: 'Earn 40 other badges.' },
];

export const BADGE_COUNT = CATALOG.length;

export const BADGE_META: Record<string, { name: string; emoji: string }> = Object.fromEntries(
  CATALOG.map((b) => [b.key, { name: b.name, emoji: b.emoji }]),
);

/**
 * Record a town-activity event. Best-effort: fully wrapped, returns void, and
 * NEVER throws — safe to call fire-and-forget (`void recordActivity(...)`) from
 * a request handler.
 *
 * Neighbor kinds (pr_authored, project_interaction) are only stored when the
 * actor is NOT the target owner. project_interaction is de-duplicated to at most
 * one row per (actor, project, UTC day). Self-event kinds (builds, capability
 * enables, secrets, key/CLI, merges of your own PRs) are always stored.
 */
export async function recordActivity(
  actorId: string,
  kind: ActivityKind,
  projectId: string | null,
  targetOwnerId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    if (!actorId || !kind) return;
    const owner = targetOwnerId || actorId;
    if (NEIGHBOR_KINDS.has(kind) && owner === actorId) return; // never self for neighbor events
    const metaJson = meta ? JSON.stringify(meta) : null;
    if (DAY_CAPPED_KINDS.has(kind)) {
      // At most one row per (actor, project, kind, UTC day).
      await pool.query(
        `INSERT INTO cv_activity_events (actor_id, kind, project_id, target_owner_id, meta)
         SELECT $1, $2, $3, $4, $5::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM cv_activity_events
           WHERE actor_id = $1 AND kind = $2 AND project_id = $3
             AND created_at >= date_trunc('day', now())
         )`,
        [actorId, kind, projectId, owner, metaJson],
      );
    } else {
      await pool.query(
        `INSERT INTO cv_activity_events (actor_id, kind, project_id, target_owner_id, meta)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actorId, kind, projectId, owner, metaJson],
      );
    }
  } catch (err) {
    console.error('[achievements] recordActivity failed (ignored):', (err as Error).message);
  }
}

type Metrics = Record<string, number>;

async function computeMetrics(userId: string): Promise<Metrics> {
  const epoch = ACHIEVEMENTS_EPOCH;
  const [proj, grants, groupsOwned, groupsJoined, byKind, thresh, caps, fullStack, mergedNonOwned, time] =
    await Promise.all([
      pool.query(
        `SELECT count(*)::int owned, count(*) FILTER (WHERE status='ready')::int ready, min(created_at) first_project
           FROM projects WHERE owner_id=$1 AND created_at>=$2`, [userId, epoch]),
      pool.query(
        `SELECT count(DISTINCT g.project_id)::int shared,
                count(DISTINCT g.project_id) FILTER (WHERE g.subject_type='everyone')::int everyone_shares
           FROM project_grants g JOIN projects p ON p.id=g.project_id
          WHERE p.owner_id=$1 AND g.created_at>=$2`, [userId, epoch]),
      pool.query(
        `SELECT COALESCE(MAX(mc.n),0)::int max_members
           FROM groups g
           LEFT JOIN (SELECT group_id, count(*) FILTER (WHERE user_id<>$1)::int n FROM group_members GROUP BY group_id) mc
             ON mc.group_id=g.id
          WHERE g.owner_id=$1 AND g.created_at>=$2`, [userId, epoch]),
      pool.query(
        `SELECT count(DISTINCT m.group_id)::int joined
           FROM group_members m JOIN groups g ON g.id=m.group_id
          WHERE m.user_id=$1 AND g.owner_id<>$1 AND m.added_at>=$2`, [userId, epoch]),
      pool.query(
        `SELECT kind, count(*)::int total, count(DISTINCT project_id)::int distinct_p
           FROM cv_activity_events WHERE actor_id=$1 AND created_at>=$2 GROUP BY kind`, [userId, epoch]),
      pool.query(
        `SELECT count(*) FILTER (WHERE c>=3)::int reporters
           FROM (SELECT project_id, count(*)::int c FROM cv_activity_events
                  WHERE actor_id=$1 AND kind='project_interaction' AND created_at>=$2
                  GROUP BY project_id) t`, [userId, epoch]),
      pool.query(
        `SELECT bool_or(meta->>'cap'='database') has_db, bool_or(meta->>'cap'='storage') has_store,
                bool_or(meta->>'cap'='mcp') has_mcp, count(DISTINCT meta->>'cap')::int caps_distinct
           FROM cv_activity_events WHERE actor_id=$1 AND kind='capability_enabled' AND created_at>=$2`, [userId, epoch]),
      pool.query(
        `SELECT count(*)::int n FROM (
            SELECT project_id FROM cv_activity_events
             WHERE actor_id=$1 AND kind='capability_enabled' AND meta->>'cap' IN ('database','storage') AND created_at>=$2
             GROUP BY project_id HAVING count(DISTINCT meta->>'cap')>=2) t`, [userId, epoch]),
      pool.query(
        `SELECT count(*)::int n FROM cv_activity_events
          WHERE actor_id=$1 AND kind='pr_merged' AND target_owner_id<>$1 AND created_at>=$2`, [userId, epoch]),
      pool.query(
        `SELECT bool_or(extract(hour from created_at)<5) night,
                bool_or(extract(hour from created_at) BETWEEN 5 AND 7) early,
                bool_or(extract(hour from created_at)=12) lunch,
                bool_or(extract(dow from created_at) IN (0,6)) weekend,
                count(DISTINCT created_at::date)::int active_days, min(created_at) first_event
           FROM cv_activity_events WHERE actor_id=$1 AND created_at>=$2`, [userId, epoch]),
    ]);

  const kindMap = new Map<string, { total: number; distinct_p: number }>(
    byKind.rows.map((r: any) => [r.kind, { total: r.total, distinct_p: r.distinct_p }]),
  );
  const k = (name: string) => kindMap.get(name) ?? { total: 0, distinct_p: 0 };
  const b = (v: any) => (v ? 1 : 0);

  // member_since = earliest of first project and first activity (post-epoch).
  const dates = [proj.rows[0].first_project, time.rows[0].first_event]
    .filter(Boolean).map((d: any) => new Date(d).getTime());
  const ageDays = dates.length ? Math.floor((Date.now() - Math.min(...dates)) / 86400000) : 0;

  return {
    always: 1,
    owned: proj.rows[0].owned,
    ready: proj.rows[0].ready,
    sharedProjects: grants.rows[0].shared,
    everyoneShares: grants.rows[0].everyone_shares,
    maxMembers: groupsOwned.rows[0].max_members,
    groupsJoined: groupsJoined.rows[0].joined,
    prAuthoredTotal: k('pr_authored').total,
    prAuthoredRepos: k('pr_authored').distinct_p,
    prMergedTotal: k('pr_merged').total,
    prMergedNonOwned: mergedNonOwned.rows[0].n,
    interTotal: k('project_interaction').total,
    interDistinct: k('project_interaction').distinct_p,
    reporters: thresh.rows[0].reporters,
    buildsShipped: k('build_shipped').total,
    secretsProjects: k('secret_added').distinct_p,
    keysConnected: k('key_connected').total,
    cliTokens: k('cli_token').total,
    hasDb: b(caps.rows[0].has_db),
    hasStorage: b(caps.rows[0].has_store),
    hasMcp: b(caps.rows[0].has_mcp),
    capsDistinct: caps.rows[0].caps_distinct,
    fullStack: fullStack.rows[0].n > 0 ? 1 : 0,
    nightOwl: b(time.rows[0].night),
    earlyBird: b(time.rows[0].early),
    lunch: b(time.rows[0].lunch),
    weekend: b(time.rows[0].weekend),
    activeDays: time.rows[0].active_days,
    ageDays,
  };
}

/**
 * Derive the full badge board for a user (read-only, no writes). `have`/`need`
 * give progress; `earned` = have >= need; `since` is filled from the grant
 * cache when present.
 */
export async function computeBadges(userId: string): Promise<Badge[]> {
  const [metrics, grants] = await Promise.all([
    computeMetrics(userId),
    pool.query('SELECT badge_key, awarded_at FROM cv_achievement_grants WHERE user_id = $1', [userId]),
  ]);
  const awardedAt = new Map<string, Date>(grants.rows.map((r: any) => [r.badge_key, r.awarded_at]));
  // Two-pass: count the non-meta badges earned so the "earn N badges" meta
  // badges have a value to compare against.
  metrics.badgesEarned = CATALOG.filter(
    (b) => b.metric !== 'badgesEarned' && (metrics[b.metric] ?? 0) >= b.need,
  ).length;

  return CATALOG.map((b) => {
    const have = metrics[b.metric] ?? 0;
    const earned = have >= b.need;
    const since = earned && awardedAt.has(b.key) ? awardedAt.get(b.key)!.toISOString() : undefined;
    return { key: b.key, name: b.name, emoji: b.emoji, rule: b.rule, category: b.category, need: b.need, have, earned, since };
  });
}

/**
 * Compute badges and cache any newly-earned ones in cv_achievement_grants.
 * Best-effort; returns the currently-earned badge keys (or [] on error).
 */
export async function reconcileAwards(userId: string): Promise<string[]> {
  try {
    const earned = (await computeBadges(userId)).filter((b) => b.earned).map((b) => b.key);
    if (earned.length) {
      const values = earned.map((_, i) => `($1, $${i + 2})`).join(', ');
      await pool.query(
        `INSERT INTO cv_achievement_grants (user_id, badge_key) VALUES ${values}
         ON CONFLICT (user_id, badge_key) DO NOTHING`,
        [userId, ...earned],
      );
    }
    return earned;
  } catch (err) {
    console.error('[achievements] reconcileAwards failed (ignored):', (err as Error).message);
    return [];
  }
}

// Per-user reconcile throttle. reconcileAwards is ~10 queries + an upsert, so we
// don't run it on every dashboard page load. maybeReconcile runs it at most once
// per CV_RECONCILE_COOLDOWN_MS per user (in-memory, per process). The pending-
// toast read stays on every load and is cheap, so a newly-earned badge still
// surfaces within the cooldown window (default 5 min) without recomputing on
// every request — this is why /  doesn't need an eager reconcile.
const RECONCILE_COOLDOWN_MS = parseInt(process.env.CV_RECONCILE_COOLDOWN_MS || '300000', 10);
const lastReconcile = new Map<string, number>();

export async function maybeReconcile(userId: string): Promise<void> {
  if (!userId) return;
  const now = Date.now();
  const prev = lastReconcile.get(userId);
  if (prev !== undefined && now - prev < RECONCILE_COOLDOWN_MS) return;
  if (lastReconcile.size > 50_000) lastReconcile.clear();
  lastReconcile.set(userId, now);
  await reconcileAwards(userId); // best-effort, never throws
}

// Retention for the high-volume, privacy-sensitive site-view tracking.
// project_view rows record who visited which project; they feed ONLY the
// popularity counters (never achievements), so pruning old ones is safe for
// badges while bounding both the tracking window and table growth. Other kinds
// are low-volume and achievement-bearing, so they are retained. Window is
// CV_VIEW_RETENTION_DAYS (default 180); set to 0 to disable pruning.
const VIEW_RETENTION_DAYS = parseInt(process.env.CV_VIEW_RETENTION_DAYS || '180', 10);

export async function pruneActivity(): Promise<number> {
  if (!(VIEW_RETENTION_DAYS > 0)) return 0;
  try {
    const res = await pool.query(
      `DELETE FROM cv_activity_events
        WHERE kind = 'project_view' AND created_at < now() - make_interval(days => $1)`,
      [VIEW_RETENTION_DAYS],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    console.error('[achievements] pruneActivity failed (ignored):', (err as Error).message);
    return 0;
  }
}

export interface ToastBadge { key: string; name: string; emoji: string; }

/**
 * Return badges awarded but not yet shown, stamping them notified so the toast
 * appears exactly once. Best-effort; [] on error.
 */
export async function takePendingToasts(userId: string): Promise<ToastBadge[]> {
  try {
    const res = await pool.query(
      `UPDATE cv_achievement_grants SET notified_at = now()
        WHERE user_id = $1 AND notified_at IS NULL
        RETURNING badge_key`,
      [userId],
    );
    return res.rows
      .map((r: any) => r.badge_key as string)
      .filter((k) => BADGE_META[k])
      .map((k) => ({ key: k, name: BADGE_META[k].name, emoji: BADGE_META[k].emoji }));
  } catch (err) {
    console.error('[achievements] takePendingToasts failed (ignored):', (err as Error).message);
    return [];
  }
}

/**
 * Batch-read earned badge keys for many users from the grant cache (one query).
 * Used to decorate other people's cards (e.g. the Community Feed) cheaply.
 * Returns a map of user_id -> ordered earned badge keys.
 */
export async function earnedBadgeKeys(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (!ids.length) return out;
  try {
    const res = await pool.query(
      'SELECT user_id, badge_key FROM cv_achievement_grants WHERE user_id = ANY($1)',
      [ids],
    );
    const order = new Map(CATALOG.map((b, i) => [b.key, i]));
    for (const row of res.rows as any[]) {
      const list = out.get(row.user_id) ?? [];
      list.push(row.badge_key);
      out.set(row.user_id, list);
    }
    for (const list of out.values()) list.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  } catch (err) {
    console.error('[achievements] earnedBadgeKeys failed (ignored):', (err as Error).message);
  }
  return out;
}

export interface ProjectMetrics {
  views: number;        // total site views (project_view)
  visitors: number;     // distinct viewers
  views7d: number;      // views in the last 7 days (drives "trending")
  interactions: number; // meaningful engagement (project_interaction)
  builds: number;       // deploys shipped (build_shipped)
  lastBuild: string | null; // ISO time of the last build (a reliable "last active")
  contributors: number; // distinct PR authors/mergers
}

const EMPTY_METRICS: ProjectMetrics = {
  views: 0, visitors: 0, views7d: 0, interactions: 0, builds: 0, lastBuild: null, contributors: 0,
};

/**
 * Batch per-project engagement metrics for the Community Feed / project detail.
 * One grouped query over the activity ledger; best-effort ({} on error). NOT
 * epoch-gated — these are live popularity/activity counters, not achievements.
 */
export async function projectMetrics(projectIds: string[]): Promise<Map<string, ProjectMetrics>> {
  const out = new Map<string, ProjectMetrics>();
  const ids = Array.from(new Set(projectIds.filter(Boolean)));
  if (!ids.length) return out;
  try {
    const res = await pool.query(
      `SELECT project_id,
         COUNT(*) FILTER (WHERE kind='project_view')::int AS views,
         COUNT(DISTINCT actor_id) FILTER (WHERE kind='project_view')::int AS visitors,
         COUNT(*) FILTER (WHERE kind='project_view' AND created_at > now() - interval '7 days')::int AS views_7d,
         COUNT(*) FILTER (WHERE kind='project_interaction')::int AS interactions,
         COUNT(*) FILTER (WHERE kind='build_shipped')::int AS builds,
         MAX(created_at) FILTER (WHERE kind='build_shipped') AS last_build,
         COUNT(DISTINCT actor_id) FILTER (WHERE kind IN ('pr_authored','pr_merged'))::int AS contributors
       FROM cv_activity_events WHERE project_id = ANY($1) GROUP BY project_id`,
      [ids],
    );
    for (const r of res.rows as any[]) {
      out.set(r.project_id, {
        views: r.views, visitors: r.visitors, views7d: r.views_7d, interactions: r.interactions,
        builds: r.builds, lastBuild: r.last_build ? new Date(r.last_build).toISOString() : null,
        contributors: r.contributors,
      });
    }
  } catch (err) {
    console.error('[achievements] projectMetrics failed (ignored):', (err as Error).message);
  }
  return out;
}

export function emptyMetrics(): ProjectMetrics { return { ...EMPTY_METRICS }; }
