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

## Achievement catalog (v1)

All rules are gated on `created_at >= ACHIEVEMENTS_EPOCH` per D3. "You" = the
Kratos identity id (`req.portalSession.id` / MCP `ctx.userId`).

| Badge | Emoji | Rule | Data source |
|---|---|---|---|
| First Post | 🌱 | Own ≥1 project | `projects` (owner_id, created_at) |
| Serial Founder | 🏗️ | Own ≥5 projects | `projects` count |
| Shipped It | 🚀 | ≥1 owned project reaches `status='ready'` | `projects.status` |
| Good Neighbor | 🤝 | Share an owned project with a user/group/everyone | `project_grants` |
| Team Builder | 👥 | Create a group and add ≥1 other member | `groups` + `group_members` |
| Contributor | 🔧 | Open ≥1 PR against a repo you don't own | `cv_activity_events` kind=`pr_authored` |
| Prolific Contributor | 🛠️ | Open PRs to ≥5 repos you don't own | `cv_activity_events` distinct project_id |
| Neighborhood Watch | 👀 | Interact with ≥5 different non-owned projects | `cv_activity_events` kind=`project_interaction` |
| Town Reporter | 📰 | Interact ≥3× with each of ≥20 non-owned projects | `cv_activity_events` grouped |

Each badge renders with: emoji, name, one-line rule, **earned/locked** state,
**progress** (e.g. "3 / 5 projects"), and an "earned <date>" when awarded.

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
  kind           text NOT NULL CHECK (kind IN ('pr_authored','project_interaction')),
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
