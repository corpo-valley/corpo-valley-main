// Database capability — a Postgres-backed JSON API, mounted at `/api`.
//
// This is the "data/views" capability. It ships a tiny example resource
// (`items`) so the project deploys and works the moment you enable the
// database; replace it with your real tables and routes.
//
// ── Authorization is baked in ────────────────────────────────────────────
// Every request that reaches this container has already passed the platform's
// edge access gate: anonymous visitors and members without `read` on this
// project never get here. The request carries the trusted identity headers
// (X-CV-User-Id / X-CV-User-Email / X-CV-Perm — see ACCESS.md); the shared
// identity helper reads them (falling back to the legacy Kratos-cookie
// re-validation when absent) and exposes the caller's permission class:
//
//   read   can view  → GET routes
//   write  can create/update/delete THEIR OWN data → mutating routes
//   admin  app-level moderator → may delete ANYONE's rows here
//
// By default every row is scoped to its owner: a caller only ever sees and
// mutates their own data (`WHERE owner_id = $caller`). The platform flips
// CV_SHARED=true when the project owner ticks "data is shared across users",
// which makes reads span everyone's rows (writes still record the author).
// The secure posture — per-user isolation — is the default; sharing is the
// explicit opt-in.

const express = require('express');
const { Pool } = require('pg');
const { resolveUser, requirePerm } = require('../lib/identity');

// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage -- CSRF is handled by csrfGuard below (Sec-Fetch-Site same-origin check); the csurf package the rule looks for is deprecated.
const app = express();
const PORT = process.env.PORT || 3000;

// When true, reads return every user's rows. When false (default), each
// caller only sees their own. Set by the platform from the project's
// "shared across users" setting — don't read it from request input.
const SHARED = process.env.CV_SHARED === 'true';

// The platform populates DATABASE_URL from the per-project `postgres` Secret
// via the Deployment's env. node-postgres doesn't read DATABASE_URL on its own
// (it reads PG* vars), so pass it explicitly. No connection details live here.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json({ limit: '64kb' }));

// CSRF protection. The edge authenticates via an ambient Kratos session
// cookie, so a malicious site could try to drive state-changing requests with
// the victim's cookie attached. We reject any unsafe request whose
// Sec-Fetch-Site marks it cross-site; combined with the JSON-only body parser
// (which a cross-site HTML form can't satisfy), this is the modern equivalent
// of the deprecated csurf middleware.
function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const site = req.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: 'cross-site request blocked' });
    return;
  }
  next();
}
app.use(csrfGuard);

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id         serial PRIMARY KEY,
      owner_id   text NOT NULL,
      title      text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS items_owner_idx ON items (owner_id);');
}

const api = express.Router();
// Identity + permission gate. `read` is the floor — the edge already blocks
// anyone below it, so this mostly matters for local runs without the headers.
api.use(requirePerm('read'));

// List items the caller is allowed to see. Parameterized — the SHARED
// branch decides scope, the value is never interpolated into SQL.
api.get('/items', async (req, res) => {
  try {
    const result = SHARED
      ? await pool.query(
          'SELECT id, owner_id, title, created_at FROM items ORDER BY created_at DESC LIMIT 200'
        )
      : await pool.query(
          'SELECT id, owner_id, title, created_at FROM items WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 200',
          [req.userId]
        );
    res.json({ shared: SHARED, items: result.rows });
  } catch (err) {
    console.error('GET /items failed:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// Create an item owned by the caller. Requires the `write` class. owner_id
// always comes from the resolved identity (req.userId), never the request
// body, so a caller can't write as someone else.
api.post('/items', requirePerm('write'), async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 280) : '';
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO items (owner_id, title) VALUES ($1, $2) RETURNING id, owner_id, title, created_at',
      [req.userId, title]
    );
    res.status(201).json({ item: rows[0] });
  } catch (err) {
    console.error('POST /items failed:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// Delete an item. `write` callers can only delete rows they own; `admin`
// callers (app-level moderators) may delete anyone's — that's the canonical
// use of the third permission class.
api.delete('/items/:id', requirePerm('write'), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  try {
    const { rowCount } = req.userPerm === 'admin'
      ? await pool.query('DELETE FROM items WHERE id = $1', [id])
      : await pool.query('DELETE FROM items WHERE id = $1 AND owner_id = $2', [id, req.userId]);
    res.json({ deleted: rowCount > 0 });
  } catch (err) {
    console.error('DELETE /items failed:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.use('/api', api);

// Liveness: process up, no DB. Readiness: only ready when Postgres answers,
// so k8s holds traffic until the database is reachable.
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err.message || err) });
  }
});

ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`database api listening on :${PORT} (shared=${SHARED})`)))
  .catch((err) => {
    console.error('Schema bootstrap failed:', err);
    // Exit so k8s restarts us — usually Postgres just isn't up yet.
    process.exit(1);
  });
