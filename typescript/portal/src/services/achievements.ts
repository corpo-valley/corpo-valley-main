// Achievements & badges — the town's "pride board".
//
// Design (see docs/decisions/2026-07-23-achievements-and-badges.md):
//  • The ONLY new event data is cv_activity_events (PRs to repos you don't own +
//    meaningful cross-project interactions). Every other badge is derived on
//    read from the existing projects / project_grants / groups tables.
//  • "Clean slate": every badge is gated on the qualifying row's created_at >=
//    ACHIEVEMENTS_EPOCH, so the feature earns forward from ship day and nothing
//    backfills.
//  • recordActivity is best-effort and NEVER throws — a DB hiccup must never
//    break create_pr / get_project (mirrors the portal's fire-and-forget rule).
//  • Awarded badges are cached in cv_achievement_grants; that cache drives the
//    one-time toast and the cheap "other people's badges" lookup on the feed.
import { pool } from './projects';

// Ship-day cutoff. Overridable per-deploy; defaults to the v0.12.0 ship date.
export const ACHIEVEMENTS_EPOCH = new Date(
  process.env.CV_ACHIEVEMENTS_EPOCH || '2026-07-23T00:00:00.000Z',
);

export type ActivityKind = 'pr_authored' | 'project_interaction';

export interface Badge {
  key: string;
  name: string;
  emoji: string;
  rule: string;
  need: number;
  have: number;
  earned: boolean;
  /** ISO date the badge was awarded (from the grant cache), when earned. */
  since?: string;
}

// Display metadata for a badge, keyed by badge_key. The catalog order is the
// render order on the page.
const CATALOG: { key: string; name: string; emoji: string; rule: string; need: number }[] = [
  { key: 'first_post',            name: 'First Post',           emoji: '🌱', rule: 'Plant your first project.',                                  need: 1 },
  { key: 'serial_founder',        name: 'Serial Founder',       emoji: '🏗️', rule: 'Own 5 or more projects.',                                   need: 5 },
  { key: 'shipped_it',            name: 'Shipped It',           emoji: '🚀', rule: 'Get a project to a successful deploy.',                      need: 1 },
  { key: 'good_neighbor',         name: 'Good Neighbor',        emoji: '🤝', rule: 'Share one of your projects with someone.',                   need: 1 },
  { key: 'team_builder',          name: 'Team Builder',         emoji: '👥', rule: 'Create a group and add another member.',                     need: 1 },
  { key: 'contributor',           name: 'Contributor',          emoji: '🔧', rule: "Open a pull request against a repo you don't own.",          need: 1 },
  { key: 'prolific_contributor',  name: 'Prolific Contributor', emoji: '🛠️', rule: "Open PRs to 5 different repos you don't own.",              need: 5 },
  { key: 'neighborhood_watch',    name: 'Neighborhood Watch',   emoji: '👀', rule: "Interact with 5 different projects you don't own.",          need: 5 },
  { key: 'town_reporter',         name: 'Town Reporter',        emoji: '📰', rule: "Interact 3+ times with each of 20 projects you don't own.",  need: 20 },
];

export const BADGE_META: Record<string, { name: string; emoji: string }> = Object.fromEntries(
  CATALOG.map((b) => [b.key, { name: b.name, emoji: b.emoji }]),
);

/**
 * Record a town-activity event. Best-effort: fully wrapped, returns void, and
 * NEVER throws — safe to call fire-and-forget (`void recordActivity(...)`) from
 * an MCP handler on the request path. No-ops when the actor is the target owner
 * (self-activity is never a neighbor achievement) or when ids are missing.
 *
 * project_interaction is de-duplicated to at most one row per (actor, project,
 * UTC day) so repeated get_project calls in a session don't flood the ledger
 * while distinct-project and 3x-threshold counts stay meaningful. pr_authored is
 * never capped — each PR is a distinct, meaningful event.
 */
export async function recordActivity(
  actorId: string,
  kind: ActivityKind,
  projectId: string | null,
  targetOwnerId: string,
): Promise<void> {
  try {
    if (!actorId || !targetOwnerId || actorId === targetOwnerId) return;
    if (kind === 'project_interaction') {
      // One interaction per project per day. ON CONFLICT would need a unique
      // index over a day-truncated expression; a guarded insert keeps the
      // schema simple and is race-tolerant enough for a cosmetic ledger.
      await pool.query(
        `INSERT INTO cv_activity_events (actor_id, kind, project_id, target_owner_id)
         SELECT $1, 'project_interaction', $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM cv_activity_events
           WHERE actor_id = $1 AND kind = 'project_interaction' AND project_id = $2
             AND created_at >= date_trunc('day', now())
         )`,
        [actorId, projectId, targetOwnerId],
      );
    } else {
      await pool.query(
        `INSERT INTO cv_activity_events (actor_id, kind, project_id, target_owner_id)
         VALUES ($1, 'pr_authored', $2, $3)`,
        [actorId, projectId, targetOwnerId],
      );
    }
  } catch (err) {
    // Swallow — activity logging must never regress a core action.
    console.error('[achievements] recordActivity failed (ignored):', (err as Error).message);
  }
}

interface RawCounts {
  projectsOwned: number;
  projectsReady: number;
  grantsGiven: number;
  teamMembers: number;
  prTotal: number;
  prDistinctRepos: number;
  interactDistinct: number;
  reporterProjects: number; // non-owned projects interacted with >= 3 times
}

async function rawCounts(userId: string): Promise<RawCounts> {
  const epoch = ACHIEVEMENTS_EPOCH;
  const [proj, grants, team, prs, inter] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS owned,
              count(*) FILTER (WHERE status = 'ready')::int AS ready
         FROM projects WHERE owner_id = $1 AND created_at >= $2`,
      [userId, epoch],
    ),
    pool.query(
      `SELECT count(*)::int AS n
         FROM project_grants g JOIN projects p ON p.id = g.project_id
        WHERE p.owner_id = $1 AND g.created_at >= $2`,
      [userId, epoch],
    ),
    pool.query(
      `SELECT count(*)::int AS n
         FROM groups g JOIN group_members m ON m.group_id = g.id
        WHERE g.owner_id = $1 AND m.user_id <> $1 AND m.added_at >= $2`,
      [userId, epoch],
    ),
    pool.query(
      `SELECT count(*)::int AS total, count(DISTINCT project_id)::int AS repos
         FROM cv_activity_events
        WHERE actor_id = $1 AND kind = 'pr_authored' AND created_at >= $2`,
      [userId, epoch],
    ),
    pool.query(
      `SELECT count(*)::int AS distinct_p,
              count(*) FILTER (WHERE c >= 3)::int AS reporters
         FROM (
           SELECT project_id, count(*)::int AS c
             FROM cv_activity_events
            WHERE actor_id = $1 AND kind = 'project_interaction' AND created_at >= $2
            GROUP BY project_id
         ) t`,
      [userId, epoch],
    ),
  ]);
  return {
    projectsOwned: proj.rows[0].owned,
    projectsReady: proj.rows[0].ready,
    grantsGiven: grants.rows[0].n,
    teamMembers: team.rows[0].n,
    prTotal: prs.rows[0].total,
    prDistinctRepos: prs.rows[0].repos,
    interactDistinct: inter.rows[0].distinct_p,
    reporterProjects: inter.rows[0].reporters,
  };
}

function haveFor(key: string, c: RawCounts): number {
  switch (key) {
    case 'first_post':           return c.projectsOwned;
    case 'serial_founder':       return c.projectsOwned;
    case 'shipped_it':           return c.projectsReady;
    case 'good_neighbor':        return c.grantsGiven;
    case 'team_builder':         return c.teamMembers;
    case 'contributor':          return c.prTotal;
    case 'prolific_contributor': return c.prDistinctRepos;
    case 'neighborhood_watch':   return c.interactDistinct;
    case 'town_reporter':        return c.reporterProjects;
    default:                     return 0;
  }
}

/**
 * Derive the full badge board for a user (read-only, no writes). `have`/`need`
 * give progress; `earned` = have >= need; `since` is filled from the grant
 * cache when present.
 */
export async function computeBadges(userId: string): Promise<Badge[]> {
  const [counts, grants] = await Promise.all([
    rawCounts(userId),
    pool.query('SELECT badge_key, awarded_at FROM cv_achievement_grants WHERE user_id = $1', [userId]),
  ]);
  const awardedAt = new Map<string, Date>(grants.rows.map((r: any) => [r.badge_key, r.awarded_at]));
  return CATALOG.map((b) => {
    const have = haveFor(b.key, counts);
    const earned = have >= b.need;
    const since = earned && awardedAt.has(b.key) ? awardedAt.get(b.key)!.toISOString() : undefined;
    return { key: b.key, name: b.name, emoji: b.emoji, rule: b.rule, need: b.need, have, earned, since };
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
      // One multi-row upsert; DO NOTHING preserves the original awarded_at.
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

export interface ToastBadge { key: string; name: string; emoji: string; }

/**
 * Return badges awarded but not yet shown to the user, stamping them notified so
 * the toast appears exactly once. Call after reconcileAwards on an authenticated
 * page render. Best-effort; [] on error.
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
 * Used to decorate other people's cards (e.g. the Community Feed) cheaply,
 * without recomputing. Returns a map of user_id -> ordered earned badge keys.
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
