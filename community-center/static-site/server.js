// Static-site capability — the website every Corpo Valley project has.
//
// A tiny Express server that serves the files in ./public. This is the
// "a website for people to view content" capability: always present, always
// mounted at `/` by the project's Ingress. Replace the contents of ./public
// with your own HTML/CSS/JS, or swap this for a framework's build output —
// just keep serving on PORT so the platform's Service keeps finding it.
//
// Identity: the platform's edge gates every request on a valid Kratos session
// before it reaches this container. A static site usually doesn't need to know
// who the caller is; if you do, resolve them from the forwarded session cookie
// with the shared `lib/identity.js` helper (as the database/mcp modules do) —
// do NOT trust any inbound `X-User-Id`-style header, the edge doesn't set one.

const path = require('path');
const express = require('express');

// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage -- static file server with no state-changing routes (GET only), so CSRF does not apply.
const app = express();
const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Liveness/readiness: process is up. No dependencies, so ready == alive.
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', (_req, res) => res.json({ ok: true }));

// Serve the static bundle. `index: 'index.html'` makes `/` resolve to the
// landing page. express.static is safe against path traversal by design.
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

// Anything not matched by a static file falls back to the landing page so
// client-side routers (if you add one) keep working on deep links. A RegExp
// route is used as the catch-all so it behaves identically across Express
// versions (the string '*' wildcard syntax changed in Express 5).
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`static-site listening on :${PORT}`));
