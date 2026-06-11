// Database capability — a Postgres-backed JSON API, mounted at `/api`.
//
// This is the "data/views" capability. It ships a tiny example resource
// (`items`) so the project deploys and works the moment you enable the
// database; replace it with your real tables and routes.
//
// ── Authorization is baked in ────────────────────────────────────────────
// Every request that reaches this container has already passed the platform's
// edge auth gate (the Ingress requires a valid Kratos session). The shared
// identity helper re-validates the forwarded Kratos session cookie to get the
// caller's stable id — a workload in this namespace can't forge it, because a
// valid identity requires a real session only the signed-in user holds.
//
// By default every row is scoped to its owner: a caller only ever sees and
// mutates their own data (`WHERE owner_id = $caller`). The platform flips
// CV_SHARED=true when the project owner ticks "data is shared across users",
// which makes reads span everyone's rows (writes still record the author).
// The secure posture — per-user isolation — is the default; sharing is the
// explicit opt-in.

const express = require('express');
const { Pool } = require('pg');
const { resolveUser } = require('../lib/identity');

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

// Identity gate. Resolve the caller from the forwarded Kratos session cookie.
// No valid session → refuse rather than guess.
async function requireUser(req, res, next) {
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  req.userId = user.id;
  req.userEmail = user.email;
  next();
}

const api = express.Router();
api.use(requireUser);

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

// Create an item owned by the caller. owner_id always comes from the resolved
// session identity (req.userId), never the request body, so a caller can't
// write as someone else.
api.post('/items', async (req, res) => {
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

// Delete one of the caller's own items. The owner_id predicate means a caller
// can only ever delete rows they own, even in shared mode.
api.delete('/items/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM items WHERE id = $1 AND owner_id = $2',
      [id, req.userId]
    );
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
