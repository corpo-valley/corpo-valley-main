import express from 'express';
import cookieParser from 'cookie-parser';
import healthRouter from './routes/health';
import kratosRouter from './routes/kratos';
import hydraRouter from './routes/hydra';
import dashboardRouter from './routes/dashboard';
import adminRouter from './routes/admin';
import internalRouter from './routes/internal';
import mcpRouter from './routes/mcp';
import docsRouter from './routes/docs';
import siteAccessRouter from './routes/site-access';
import groupsRouter from './routes/groups';
import { validateCsrf } from './middleware/csrf';
import { migrate } from './services/projects';
import { reconcileAllProjects } from './services/repo-access';
import { backfillPinTokens } from './services/pin-token-backfill';
import { seedCommunityCenterTemplate } from './services/template-seed';
import { runWithNonce } from './lib/csp-nonce';
import * as crypto from 'crypto';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

// Ory Kratos browser origin (e.g. https://auth.corpo-valley.com). The login /
// recovery / verification / settings flows render in the portal but their forms
// POST to Kratos's flow `action` on this origin, so the CSP `form-action` must
// allow it — otherwise the browser blocks "Sign in" / "Email me a code" /
// "Send recovery email" as cross-origin submissions.
const KRATOS_BROWSER_ORIGIN = (() => {
  try {
    return new URL(process.env.KRATOS_BROWSER_URL || process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433').origin;
  } catch {
    return '';
  }
})();

// Ory Hydra browser origin (e.g. https://oauth.corpo-valley.com). When a user
// without an existing session connects MCP, the OAuth login_challenge renders
// the interactive Kratos login form; on success Kratos 303s the form submission
// to Hydra's login-accept URL on THIS origin to continue the flow. Chromium
// enforces `form-action` across the whole redirect chain of a submission, so the
// Hydra origin must be allowed too — otherwise the login POST's redirect is
// blocked and the MCP connect dead-ends on the login page. (Users with an
// existing session skip the form via a GET redirect, which form-action ignores,
// which is why this only bites first-time / no-session connects.)
const HYDRA_BROWSER_ORIGIN = (() => {
  try {
    return new URL(process.env.HYDRA_PUBLIC_URL || 'http://localhost:4444').origin;
  } catch {
    return '';
  }
})();

// Google OIDC: the Kratos login/registration form POST 303s to
// accounts.google.com; Chromium enforces form-action across the redirect
// chain (same mechanism as HYDRA_BROWSER_ORIGIN above).
const GOOGLE_FORM_ACTION_ORIGIN =
  process.env.GOOGLE_LOGIN_ENABLED === 'true' ? 'https://accounts.google.com' : '';

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Baseline security response headers on every route, mounted before routers.
//   - frame-ancestors 'none' + X-Frame-Options: DENY — clickjacking defense.
//   - nosniff — stop MIME-type sniffing of our HTML/JSON responses.
//   - Referrer-Policy — don't leak full URLs (which can carry flow ids) cross-origin.
// The CSP locks down framing, base-uri, form-action, object-src, and external
// origins. script-src does NOT allow 'unsafe-inline': every inline <script> the
// templates emit carries the per-response nonce below, and inline event handlers
// have been replaced with delegated handlers (see the dashboard bootstrap
// script). style-src keeps 'unsafe-inline' (inline styles are pervasive and far
// lower risk than inline script). The nonce is exposed to templates via
// AsyncLocalStorage so the header and the <script> tags always agree.
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // HSTS on HTTPS requests (the ingress/CDN terminates TLS and sets
  // X-Forwarded-Proto; with `trust proxy`, req.secure reflects it). Harmless if
  // the ingress also sets it.
  if (req.secure) {
    res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      // 'self' for the portal's own POSTs (consent, logout, dashboard/admin),
      // the Kratos origin for the auth-flow forms, the Hydra origin for the
      // login-form 303 that continues an OAuth login_challenge, and (when Google
      // login is on) accounts.google.com for the OIDC 303 (see
      // KRATOS_BROWSER_ORIGIN / HYDRA_BROWSER_ORIGIN / GOOGLE_FORM_ACTION_ORIGIN above).
      `form-action 'self'${[KRATOS_BROWSER_ORIGIN, HYDRA_BROWSER_ORIGIN, GOOGLE_FORM_ACTION_ORIGIN].filter(Boolean).map((o) => ' ' + o).join('')}`,
      "frame-ancestors 'none'",
    ].join('; '),
  );
  runWithNonce(nonce, next);
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Auth flow routes (no session required — these ARE the auth UI)
app.use(healthRouter);
app.use(kratosRouter);
app.use(hydraRouter);

// Internal webhooks (cluster-only, no CSRF, no session — Kratos posts here)
app.use(internalRouter);

// Project-site auth subrequests from ingress-nginx (GET-only, validates the
// forwarded Kratos cookie itself — no session middleware, no CSRF).
app.use(siteAccessRouter);

// MCP server (Bearer-token auth via Hydra introspection; no CSRF, no
// session cookies). Mounted BEFORE the CSRF middleware below so it isn't
// caught by it.
app.use(mcpRouter);

// Public docs (no session, no CSRF) — editor setup walkthrough etc.
app.use(docsRouter);

// CSRF validation on all dashboard/admin POST routes
app.use('/projects', validateCsrf);
app.use('/keys', validateCsrf);
app.use('/admin', validateCsrf);
app.use('/groups', validateCsrf);

// Admin routes (session + admin required) — scoped to /admin
app.use('/admin', adminRouter);

// Groups (session required)
app.use(groupsRouter);

// Dashboard routes (session required) — last since it has GET /
app.use(dashboardRouter);

async function start() {
  // Idempotent startup migration for the portal Postgres DB (projects table).
  try {
    await migrate();
    console.log('Portal DB migration complete');
  } catch (err: any) {
    console.error('Portal DB migration failed:', err.message);
    // Fail fast — projects routes can't work without the table.
    process.exit(1);
  }

  // One-shot security backfill: mint CV_PIN_TOKEN for any pre-existing
  // project that doesn't have one yet, and refresh its build.yaml so the
  // workflow actually sends the Bearer header. Idempotent — once a
  // project has a token, subsequent restarts are no-ops. Best-effort: a
  // backfill failure is logged but doesn't block portal startup, since
  // the bigger risk is a stale portal that can't serve traffic at all.
  try {
    await backfillPinTokens();
  } catch (err: any) {
    console.error('Pin-token backfill failed:', err?.message);
  }

  // Seed the Community Center template repo in Gitea from the baked-in
  // baseline — only when the repo is missing or empty. Once seeded, Gitea is
  // the source of truth and admins own the template; this never overwrites
  // their edits (an explicit /admin/template/reset does that). Best-effort:
  // a Gitea hiccup here must not block the portal from serving traffic.
  try {
    const seeded = await seedCommunityCenterTemplate();
    console.log(`[template-seed] ${seeded.action}${seeded.reason ? `: ${seeded.reason}` : ''}` +
      (seeded.written !== undefined ? ` (${seeded.written} written, ${seeded.deleted} deleted)` : ''));
  } catch (err: any) {
    console.error('Community Center template seed failed:', err?.message);
  }

  // Periodic repo-access reconcile sweep. Triggered grant/default/membership
  // changes are the fast path; this self-heals any converge step that failed
  // transiently — above all a collaborator removal (revocation) a Gitea blip
  // left stale, which would otherwise be silent write access. Interval is
  // REPO_RECONCILE_INTERVAL_MS (default 30m); set to 0 to disable. unref() so
  // the timer never holds the process open on shutdown.
  const reconcileMs = parseInt(process.env.REPO_RECONCILE_INTERVAL_MS || '1800000', 10);
  if (reconcileMs > 0) {
    const timer = setInterval(() => {
      reconcileAllProjects().catch((err: any) =>
        console.error('[repo-access] periodic reconcile sweep failed:', err?.message));
    }, reconcileMs);
    timer.unref();
    console.log(`Repo-access reconcile sweep every ${Math.round(reconcileMs / 1000)}s`);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Portal listening on port ${port}`);
    console.log(`Kratos public: ${process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433'}`);
    console.log(`Kratos admin: ${process.env.KRATOS_ADMIN_URL || 'http://localhost:4434'}`);
    console.log(`Hydra admin: ${process.env.HYDRA_ADMIN_URL || 'http://localhost:4445'}`);
    console.log(`Hydra public: ${process.env.HYDRA_PUBLIC_URL || 'http://localhost:4444'}`);
    console.log(`Keto read: ${process.env.KETO_READ_URL || 'http://localhost:4466'}`);
    console.log(`Keto write: ${process.env.KETO_WRITE_URL || 'http://localhost:4467'}`);
    console.log(`Base URL: ${process.env.BASE_URL || 'http://localhost:3000'}`);
  });
}

start();
