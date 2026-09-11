# Decision log — Achievements, Badges & Fun Usage Metrics

Date: 2026-07-23. Branch: `feat/achievements` (corpo-valley-main).
Ships as: **portal + mcp-gateway v0.11.0 → v0.12.0** (next minor), deployed to
`portal.corpo-valley.com`.

## Goal

Give Corpo Valley residents **achievements, badges, and fun usage metrics** so
employees are **proud of the experiments they build** — and proud of being good
neighbors in the town. Badges celebrate both *building* (planting projects,
shipping deploys) and *participating* (contributing to others' repos, exploring
the town).

The feature lives entirely in the **platform portal** (`typescript/portal` →
`portal.corpo-valley.com`). It is **not** in `community-center` — that directory
is the per-project starter *template*; each cloned project is isolated (own
Postgres/Garage/namespace, egress-blocked), so it has no cross-project surface.
The portal is the only place that sits in front of every project (site-access
edge, MCP handlers, project CRUD) and already owns Postgres, Kratos identity,
and a server-rendered `.badge` pill idiom.

---

## Product decisions

### D1 — Visibility: **public profiles, no leaderboard** (chosen)

- `GET /achievements` — your own badges + progress (self view).
- `GET /achievements/u/:username` — anyone's **read-only public badge profile**.
- Badges surface on **project cards** (`renderProjectDetail`) and on **Community
  Feed** cards (compact "top badges / count" of the owner).
- **No ranked leaderboard.** Rationale: the town vision is collaborative, not
  competitive; a leaderboard turns pride into ranking anxiety and invites
  gaming. Profiles + on-project badges give visibility and pride without a
  scoreboard. (Revisit later if the org wants friendly competition.)

### D2 — Interaction definition: **meaningful actions only** (chosen)

An "interaction" with a project you don't own is a **deliberate action**, not a
passive page view:

- MCP `get_project` on a non-owned project,
- MCP repo/ops tools routed through `resolveAccessibleProject` on a non-owned
  project (e.g. reading files, PR ops).

**Excluded:** Community Feed page loads (passive browse). Rationale: Town
Reporter should mean you actually *engaged* with 20 neighbors' work, not that a
feed rendered 20 cards. This keeps the ledger small and the badge honest.

### D3 — Launch data: **clean slate** (chosen)

Nothing backfills. Every badge is earned by activity whose qualifying timestamp
is **at or after `ACHIEVEMENTS_EPOCH`** (the feature's ship time, a build
constant). This applies uniformly:

- Event badges (Contributor, Town Reporter) are naturally clean — the events
  table is empty at launch.
- DB-derivable badges (First Post, Serial Founder, Shipped It, Good Neighbor,
  Team Builder) additionally require the qualifying row's `created_at >= EPOCH`
  (project created after launch, grant created after launch, etc.).

Consequence (accepted): a founder with 10 pre-existing projects starts with an
empty board and earns "First Post" on their **next** project. This is the
honest reading of "earned from ship-day forward" and keeps the award-cache /
toast semantics truthful (no retroactive flood of toasts on launch day).

### D4 — Notifications: **award-cache + one-time toast** (chosen)

A `cv_achievement_grants` cache records the first moment each user crosses a
badge threshold. On the next authenticated portal page the user sees a
**server-rendered "🏆 You earned <Badge>!" banner** (dismiss/auto-hide via the
single nonce'd delegated script already in `dashboardLayout()` — no `fetch`, no
new client JS, CSP-safe). The banner shows once (`notified_at` stamped on
render).

---

## Achievement catalog (v1 — 54 badges, 9 categories)

All rules are gated on `created_at >= ACHIEVEMENTS_EPOCH` per D3. "You" = the
Kratos identity id (`req.portalSession.id` / MCP `ctx.userId`). The board renders
as category sections; each badge shows emoji, name, rule, **earned/locked**
state, **progress** (e.g. "3 / 5"), and an "earned <date>" when awarded. The
source of truth is the `CATALOG` array in `services/achievements.ts`.

**Founding** (`projects`): First Post 🌱 (1) · Homesteader 🏠 (3) · Serial Founder
🏗️ (5) · Land Baron 🏰 (10) · Valley Tycoon 👑 (25) projects owned.

**Shipping** (`projects.status='ready'` + `build_shipped`): Shipped It 🚀 (1) ·
Launch Party 🎉 (3) · Fleet Commander 🛰️ (10) deployed · First Build 🔨 (1) · Ship
Shape 📦 (10) · Build Baron 🏭 (50) builds shipped.

**Contributions** (`pr_authored`, `pr_merged`): Contributor 🔧 (1 PR to a repo you
don't own) · Prolific Contributor 🛠️ (5 repos) · Open Source Hero 🦸 (15 repos) ·
Merge Master 🔀 (1) · Merge Machine ⚙️ (10) · Peer Reviewer 👓 (merge a non-owned PR).

**Exploration** (`project_interaction`): Neighborly 👋 (1) · Neighborhood Watch 👀
(5) · Explorer 🧭 (10) · Cartographer 🗺️ (25) distinct non-owned projects · Town
Reporter 📰 (3×20) · Town Crier 📣 (3×40) · Busybody 🐝 (100 total).

**Neighbors** (`project_grants`): Good Neighbor 🤝 (share 1) · Open Door 🚪 (share
to everyone) · Philanthropist 🎁 (share 5).

**Teams** (`groups`/`group_members`): Team Builder 👥 (group + 1 member) · Guild
Leader 🛡️ (5) · Kingmaker 🤴 (10) · Joiner 🧩 (join a group) · Social Butterfly 🦋 (3 groups).

**Capabilities** (`capability_enabled` meta.cap): Data Wrangler 🗄️ (database) · Pack
Rat 📦 (storage) · Tool Maker 🔌 (MCP) · Full Stack 🍔 (DB+storage on one) · Triple Threat 🎯 (all three).

**Craft** (`secret_added`, `key_connected`, `cli_token`): Secret Keeper 🔐 (1) ·
Locksmith 🗝️ (3 projects) · Connected 🔗 (1 key) · Power User ⚡ (3 keys) · CLI Cowboy 🤠 (mint a CLI token).

**Milestones** (welcome/time/meta from event timestamps): Welcome to the Valley 🌄
· Night Owl 🦉 · Early Bird 🐦 · Lunch Break Hacker 🥪 · Weekend Warrior 🏕️ · Streak
Starter 🔥 (3 days) · On Fire 🌶️ (7) · Dedicated 📅 (30) · Veteran 🎖️ (6mo) ·
Anniversary 🎂 (1yr) · Completionist 🏆 (25 badges) · Overachiever 🌟 (40 badges).

> Time-of-day badges bucket on the event's UTC hour (container TZ).

**Identity rule (critical):** the actor for `pr_authored` is captured as the
Kratos id at the MCP handler (`ctx.userId`). The Gitea PR author is `cvportal`
(site-admin token) on the MCP path and must never be used to credit
Contributor. "Not owned by you" is judged with `projects.owner_id` (Kratos id),
never the Gitea username (different identity namespace).

---

## Architecture

**Storage** — portal Postgres, schema created idempotently in `migrate()`
(`src/services/projects.ts`). Two new tables:

```sql
CREATE TABLE IF NOT EXISTS cv_activity_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id       text NOT NULL,                 -- Kratos identity id
  kind           text NOT NULL CHECK (kind IN ('pr_authored','project_interaction',
                   'pr_merged','build_shipped','capability_enabled','secret_added',
                   'key_connected','cli_token','project_view')),
  project_id     uuid REFERENCES projects(id) ON DELETE SET NULL,
  target_owner_id text NOT NULL,                -- project owner at event time
  created_at     timestamptz NOT NULL DEFAULT now(),
  meta           jsonb
  -- invariant enforced in app: only inserted when target_owner_id <> actor_id
);
CREATE INDEX IF NOT EXISTS cv_activity_actor_kind_idx  ON cv_activity_events (actor_id, kind);
CREATE INDEX IF NOT EXISTS cv_activity_actor_proj_idx  ON cv_activity_events (actor_id, project_id);

CREATE TABLE IF NOT EXISTS cv_achievement_grants (
  user_id     text NOT NULL,
  badge_key   text NOT NULL,
  awarded_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,                       -- null = toast pending
  PRIMARY KEY (user_id, badge_key)
);
```

De-dup guard: `recordActivity` caps `project_interaction` inserts to **1 per
(actor, project, day)** (app-level check) so repeated `get_project` calls in a
session don't flood the ledger — distinct-project and 3×-threshold counts stay
meaningful. `pr_authored` is not capped (each PR is a real event).

**New service** — `src/services/achievements.ts` (mirrors `projects.ts`):

- `recordActivity(actorId, kind, projectId, targetOwnerId)` — **best-effort**,
  full `try/catch`, returns `void`, **never throws** (matches the portal's
  fire-and-forget provisioning rule; a DB hiccup must never break `create_pr` /
  `get_project`). No-ops when `targetOwnerId === actorId`.
- `computeBadges(userId): Promise<Badge[]>` — runs the derivation SQL (all
  epoch-gated), returns fully-shaped `Badge` objects (`key, name, emoji, rule,
  earned, progress:{have,need}, since?`).
- `reconcileAwards(userId): Promise<Badge[]>` — computes badges, upserts newly
  earned ones into `cv_achievement_grants` (INSERT … ON CONFLICT DO NOTHING),
  returns the set that is earned-but-not-yet-notified (drives the toast).
- `takePendingToasts(userId): Promise<Badge[]>` — returns un-notified grants and
  stamps `notified_at` (shown once).

**Instrumentation** (all best-effort, actor = Kratos id, only when owner≠actor):

1. `src/services/mcp.ts` `create_pr` (~L742) & `merge_pr` (~L773) →
   `recordActivity(ctx.userId,'pr_authored',p.id,p.owner_id)`.
2. `src/services/mcp.ts` `get_project` (~L213) and `resolveAccessibleProject`
   (~L1321) → `recordActivity(actor,'project_interaction',p.id,p.owner_id)`.
   **Off the ingress hot path** — nothing added to `routes/site-access.ts` /
   `effectiveSitePerm` (memoized per-request auth subrequest).
3. Award reconciliation is triggered lazily: on `GET /` (home) and
   `GET /achievements`, and opportunistically after the instrumented MCP actions
   (best-effort). Toasts surface on the home + achievements pages.

**UI** (`src/templates.ts`, server-rendered, strict CSP, reuse `.badge` /
`.app-card` / `.app-grid`):

- `renderAchievements(email, badges, isAdmin, opts)` → `dashboardLayout(...,'achievements')`.
- `renderPublicProfile(username, displayName, badges, viewer)` — read-only.
- `badgeChip(b)` helper beside `roleBadge()`/`accessBadge()`; dropped into
  `renderProjectDetail()` (owner's badges) and Community Feed cards.
- New CSS `.badge-achievement` / `.achievement-card` / `.badge-locked` appended
  to the inlined CSS const, matching the Stardew palette (harvest-gold
  `#e8b94a`, leaf-green `#84a25a`); 🏆 per earned badge.
- Toast banner rendered by `dashboardLayout` when `opts.newBadges` is passed.
- Nav: `{ label:'Achievements', href:'/achievements', key:'achievements' }` in
  `navItems`.

**Routes** (`src/routes/dashboard.ts`, mounted last):

- `GET /achievements` — `requireSession`; `reconcileAwards` + `computeBadges`
  for `req.portalSession.id`; render.
- `GET /achievements/u/:username` — `requireSession`; resolve username→identity
  via `services/kratos-admin.ts`; `computeBadges`; render read-only profile.
- Both GET-only → **no CSRF-prefix entry, no `requireVerifiedEmail`**.

Identity enrichment (id → display name/username) uses
`services/kratos-admin.ts` (`listAllHumanIdentities`/`findIdentityByEmail`) —
there is no local `users` table.

---

## Addendum — project engagement metrics (Community Feed)

Fixes the "weak/broken" community metrics (the feed's only signal was the flaky
Gitea repo mtime). The activity ledger doubles as per-project analytics:

- **`project_view`** — a NEW kind recorded from the ingress edge
  (`routes/site-access.ts`) when a non-owner is admitted to a project site.
  Fire-and-forget, in-memory day-throttled per (viewer, slug) + DB day-capped,
  and only inside the perm-cache-miss branch — so it adds ~nothing to the hot
  path. It is a SEPARATE kind from `project_interaction`, so counting raw site
  views does not change achievement semantics (Town Reporter et al. still use
  `project_interaction` only).
- **`projectMetrics(ids)`** (`services/achievements.ts`) — one grouped query
  (indexed by `(project_id, kind)`) returns per project: views, distinct
  visitors, 7-day views (trending), interactions, builds shipped, last-build
  time, and distinct contributors.
- **Community Feed** (`GET /community`) gains a **Popularity** column
  (👀 visitors · 🚀 builds · 🤝 contributors · 🔥 trending), quick-sort chips
  (Trending / Popular / Recently active / Newest), and a reliable **"Last
  active"** = `max(last build, repo mtime)` replacing the flaky mtime-only
  column. **Project detail** gains a metrics strip.

## Ship / deploy plan (v0.11.0 → v0.12.0)

1. **Source bump:** `typescript/portal/package.json` and
   `typescript/mcp-gateway/package.json` 0.11.0 → 0.12.0 (lockstep). Leave
   `community-center/package.json` (independent 0.1.x, baked into the portal
   image).
2. **PR** on `feat/achievements` → merge to `main` (established repo — user
   drives merge). Merge auto-triggers `build-images.yaml` (rolling
   `:latest` + `YYYYMMDD-sha`).
3. **Release:** run `release-images.yaml` (Actions → Run workflow) with
   `version=v0.12.0`, `apps=portal,mcp-gateway,garage`, `create_release=true` →
   immutable `ghcr.io/corpo-valley/corpo-valley-portal:v0.12.0` + git tag +
   GitHub Release.
4. **Deploy pin:** in the GitOps repo ArgoCD actually reconciles —
   **`hashtagcyber/corpo-valley`** (not the aspirational `corpo-valley-hetzner`)
   — set `image.tags.portal` (+ `mcp-gateway`) to `v0.12.0`, re-render the chart
   (`corpo-valley-chart`), commit the regenerated
   `k8s/platform/chart-rendered.yaml` (portal `image:` pin ~L1947) with message
   `deploy: cv-platform → v0.12.0 release`. `cv-platform` ArgoCD app
   (prune+selfHeal) auto-syncs into ns `cv-portal`. No manual promote gate.

---

## Risks & guardrails

- **`migrate()` fails the process hard on error** and is the single schema
  owner — keep both new tables strictly `CREATE … IF NOT EXISTS`.
- **`recordActivity` must never throw** — a throwing hook would regress
  `create_pr`/`get_project`. Wrap fully; log-and-swallow.
- **Hot path:** no interaction logging in `site-access.ts` / `effectiveSitePerm`
  (per-request ingress subrequest); cap interactions per project/day.
- **Identity namespaces:** judge "not yours" with `owner_id` (Kratos), never the
  Gitea login (`cvportal` on MCP PRs).
- **Enumeration blind spot:** the "not owned by you" universe for Town Reporter
  is the reachable set (internal/everyone via Community Feed + shared grants via
  `get_project`); private projects you don't own aren't enumerable — set the
  bar against that reachable universe.
- **CSP:** any interactivity reuses the single nonce'd delegated script +
  `data-*` attributes; no `onclick`/`fetch`/React.
- **Version drift:** `package.json`, the `release-images` input, and the deploy
  pin are three hand-maintained values with no machine source of truth — bump
  all three; the PR covers package.json, the release + pin are steps 3–4.
```

## Security hardening (post-review)

Applied after a security review of the branch:

- **Public-profile endpoint** (`/achievements/u/:username`): added a per-IP
  `profileLimiter` (60/min), a short-TTL username→identity cache (so it no
  longer scans the full Kratos identity list per hit), and **removed the
  write-on-read** `reconcileAwards(target)` — profiles are now purely
  read-only (badges derive live; the target's own page loads keep their grant
  cache current). Closes the amplification + cross-user-write finding.
- **Reconcile throttle**: `/` and `/achievements` call `maybeReconcile()`
  (once per `CV_RECONCILE_COOLDOWN_MS`/user, default 5 min) instead of an eager
  reconcile every load — the cheap pending-toast read still runs every load, so
  awards/toasts surface within the window. (`/` never needed an eager reconcile.)
- **Retention**: `pruneActivity()` deletes `project_view` rows older than
  `CV_VIEW_RETENTION_DAYS` (default 180), scheduled daily in `index.ts`
  (`CV_PRUNE_INTERVAL_MS`). `project_view` feeds only popularity counters, never
  achievements, so pruning is badge-safe; it bounds the who-viewed-what tracking
  window and table growth.
