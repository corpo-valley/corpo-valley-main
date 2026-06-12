import { Router, Request, Response } from 'express';
import { Configuration, FrontendApi } from '@ory/client';
import {
  renderFlow, renderError,
  renderLoginPage, renderRecoveryPage, renderSettingsPage,
} from '../templates';

const router = Router();

const kratosPublicUrl = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';
const kratosBrowserUrl = process.env.KRATOS_BROWSER_URL || kratosPublicUrl;
const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

// "Login with Google" (decision D4): when the chart enables the Kratos Google
// OIDC provider it also sets this flag, and the login page shows ONLY the
// Google button. Password/code stay fully functional behind
// /login?method=password — the break-glass path for admins and for any window
// where the Google client config is broken. The flag only changes rendering;
// Kratos decides what methods actually exist.
const GOOGLE_LOGIN_ENABLED = process.env.GOOGLE_LOGIN_ENABLED === 'true';

// Carries the "show me the password form" choice across the Kratos
// flow-creation round-trip (/login?method=password → Kratos → /login?flow=…).
const LOGIN_METHOD_COOKIE = 'cv_lm';

// Allow post-login redirects ONLY to user-project subdomains. The portal's
// own internal flows don't use return_to (they fall through to Kratos's
// default_browser_return_url), so we can keep this strict to prevent the
// /login?return_to= parameter from being abused as an open redirect.
// `endsWith('.projects.corpo-valley.com')` rejects `projects.corpo-valley.com`
// itself and attacker-controlled lookalikes like `xprojects.corpo-valley.com`
// or `x.projects.corpo-valley.com.evil.com`.
function isSafeRedirect(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname.endsWith('.projects.corpo-valley.com');
  } catch {
    return false;
  }
}

const kratos = new FrontendApi(
  new Configuration({ basePath: kratosPublicUrl })
);

// Short-lived cookie carrying the intended post-login destination. We do NOT
// forward return_to to Kratos (which would 303 the freshly-authenticated browser
// straight to any *.projects.corpo-valley.com host — a tenant-controlled origin,
// i.e. an open-redirect/phishing vector). Instead we stash a vetted destination
// here and let the dashboard honour it ONLY if the logged-in subject owns that
// project (see routes/dashboard.ts GET /).
export const POST_LOGIN_COOKIE = 'cv_pld';

function stashPostLoginDest(req: Request, res: Response, returnTo?: string): string {
  if (returnTo && isSafeRedirect(returnTo)) {
    res.cookie(POST_LOGIN_COOKIE, returnTo, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 5 * 60 * 1000,
      path: '/',
    });
  }
  return `${kratosBrowserUrl}/self-service/login/browser`;
}

// GET /login
router.get('/login', async (req: Request, res: Response) => {
  const flowId = req.query.flow as string | undefined;
  const loginChallenge = req.query.login_challenge as string | undefined;

  // Break-glass selector: ?method=password forces the credential form even in
  // Google-only mode. Persist it across the Kratos flow-creation redirect.
  if (req.query.method === 'password') {
    res.cookie(LOGIN_METHOD_COOKIE, 'password', {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 5 * 60 * 1000, path: '/',
    });
  }
  const wantPassword = req.query.method === 'password' || req.cookies?.[LOGIN_METHOD_COOKIE] === 'password';

  // If there's a Hydra login_challenge but no flow, bounce the browser
  // straight to Kratos's /self-service/login/browser?login_challenge=...
  // Kratos sees the user's actual session cookie and decides:
  //   - already logged in → 303 to Hydra's accept_login_request URL
  //   - no session → 303 to portal/login?flow=<id> (the fresh login UI)
  // Letting the browser do the round-trip avoids SDK content-negotiation mess.
  if (loginChallenge && !flowId) {
    const target = `${kratosBrowserUrl}/self-service/login/browser?login_challenge=${encodeURIComponent(loginChallenge)}`;
    return res.redirect(target);
  }

  if (!flowId) {
    // No flow ID: redirect to Kratos to create one. Stash the (vetted) post-login
    // destination in a cookie rather than handing it to Kratos as return_to.
    return res.redirect(stashPostLoginDest(req, res, req.query.return_to as string | undefined));
  }

  try {
    const { data: flow } = await kratos.getLoginFlow({
      id: flowId,
      cookie: req.headers.cookie,
    });

    const googleOnly = GOOGLE_LOGIN_ENABLED && !wantPassword;
    // In Google-only mode the footer offers the discreet break-glass link
    // instead of password recovery; the full form keeps the recovery link.
    // No "Create an account" link either way: password/code self-signup stays
    // disabled (Google signup happens through the Google button itself).
    const footer = googleOnly
      ? `<div class="links">
        <a href="/login?method=password">Sign in another way</a>
      </div>`
      : `<div class="links">
        <a href="${kratosBrowserUrl}/self-service/recovery/browser">Forgot password?</a>
      </div>`;
    // NOTE: the cv_lm cookie is deliberately NOT cleared here — a failed
    // password attempt 303s back to this flow, and clearing it would bounce
    // the user to the Google-only page mid-error. It expires on its own.

    res.send(renderLoginPage(
      flow.ui.action,
      flow.ui.nodes as any,
      flow.ui.messages as any,
      footer,
      { googleOnly },
    ));
  } catch (err: any) {
    if (err?.response?.status === 410 || err?.response?.status === 403) {
      // Flow expired, start a new one (stash the vetted destination as above).
      return res.redirect(stashPostLoginDest(req, res, req.query.return_to as string | undefined));
    }
    console.error('Login flow error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Login Error', 'Failed to load login flow.', err?.response?.data?.error?.message));
  }
});

// GET /registration — Kratos registration flow UI. Exists only for the
// Google-signup path (decision D5): with auth.google.enabled the chart turns
// the Kratos registration FLOW on, restricted to the oidc method (password/
// code signups are rejected by the deny webhook — see routes/internal.ts).
// The Google flow normally completes without ever showing this page; Kratos
// sends the browser here when it has something to say (e.g. the data-mapper
// rejected the Workspace domain, or a duplicate-email conflict), so this
// renders the flow's nodes/messages generically.
router.get('/registration', async (req: Request, res: Response) => {
  const flowId = req.query.flow as string | undefined;

  if (!flowId) {
    if (process.env.GOOGLE_LOGIN_ENABLED === 'true') {
      return res.redirect(`${kratosBrowserUrl}/self-service/registration/browser`);
    }
    // Registration disabled: the only accounts are admin-created.
    return res.redirect('/login');
  }

  try {
    const { data: flow } = await kratos.getRegistrationFlow({
      id: flowId,
      cookie: req.headers.cookie,
    });
    const footer = `<div class="links"><a href="/login">Back to Sign In</a></div>`;
    // Only the oidc method (plus the flow's hidden defaults) is offered:
    // password/code signup is policy-rejected by the deny webhook, so showing
    // those fields would advertise a path that always fails.
    const nodes = (flow.ui.nodes as any[]).filter(
      (n) => n.group === 'oidc' || n.group === 'default',
    );
    res.send(renderFlow(
      'Sign up',
      flow.ui.action,
      flow.ui.method,
      nodes as any,
      flow.ui.messages as any,
      footer,
    ));
  } catch (err: any) {
    if (err?.response?.status === 410 || err?.response?.status === 403 || err?.response?.status === 404) {
      return res.redirect('/login');
    }
    console.error('Registration flow error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Registration Error', 'Failed to load registration flow.', err?.response?.data?.error?.message));
  }
});

// GET /verification
router.get('/verification', async (req: Request, res: Response) => {
  const flowId = req.query.flow as string | undefined;

  if (!flowId) {
    return res.redirect(`${kratosBrowserUrl}/self-service/verification/browser`);
  }

  try {
    const { data: flow } = await kratos.getVerificationFlow({
      id: flowId,
      cookie: req.headers.cookie,
    });

    res.send(renderFlow(
      'Verify Your Email',
      flow.ui.action,
      flow.ui.method,
      flow.ui.nodes as any,
      flow.ui.messages as any,
    ));
  } catch (err: any) {
    if (err?.response?.status === 410 || err?.response?.status === 403) {
      return res.redirect(`${kratosBrowserUrl}/self-service/verification/browser`);
    }
    console.error('Verification flow error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Verification Error', 'Failed to load verification flow.', err?.response?.data?.error?.message));
  }
});

// GET /recovery
router.get('/recovery', async (req: Request, res: Response) => {
  const flowId = req.query.flow as string | undefined;

  if (!flowId) {
    return res.redirect(`${kratosBrowserUrl}/self-service/recovery/browser`);
  }

  try {
    const { data: flow } = await kratos.getRecoveryFlow({
      id: flowId,
      cookie: req.headers.cookie,
    });

    const footer = `<div class="links">
      <a href="${kratosBrowserUrl}/self-service/login/browser">Back to Sign In</a>
    </div>`;

    res.send(renderRecoveryPage(
      flow.ui.action,
      flow.ui.nodes as any,
      flow.ui.messages as any,
      footer,
    ));
  } catch (err: any) {
    if (err?.response?.status === 410 || err?.response?.status === 403) {
      return res.redirect(`${kratosBrowserUrl}/self-service/recovery/browser`);
    }
    console.error('Recovery flow error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Recovery Error', 'Failed to load recovery flow.', err?.response?.data?.error?.message));
  }
});

// GET /settings — settings flow UI (password change, profile updates, etc.)
// Kratos sends users here after a successful recovery flow so they can set a
// new password. Without this route the user lands on a 404 after the recovery
// link is accepted.
router.get('/settings', async (req: Request, res: Response) => {
  const flowId = req.query.flow as string | undefined;

  if (!flowId) {
    return res.redirect(`${kratosBrowserUrl}/self-service/settings/browser`);
  }

  try {
    const { data: flow } = await kratos.getSettingsFlow({
      id: flowId,
      cookie: req.headers.cookie,
    });

    const footer = `<div class="links">
      <a href="${baseUrl}/">Back to Dashboard</a>
    </div>`;

    res.send(renderSettingsPage(
      flow.ui.action,
      flow.ui.nodes as any,
      flow.ui.messages as any,
      footer,
    ));
  } catch (err: any) {
    if (err?.response?.status === 410 || err?.response?.status === 403) {
      return res.redirect(`${kratosBrowserUrl}/self-service/settings/browser`);
    }
    console.error('Settings flow error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Settings Error', 'Failed to load settings flow.', err?.response?.data?.error?.message));
  }
});

// GET /error
router.get('/error', async (req: Request, res: Response) => {
  const errorId = req.query.id as string | undefined;

  if (!errorId) {
    return res.send(renderError('Error', 'An unknown error occurred.'));
  }

  try {
    const { data } = await kratos.getFlowError({ id: errorId });
    const errorBody = data.error as Record<string, any> | undefined;
    // Render only the whitelisted message/reason strings. Never JSON.stringify
    // the whole upstream error object — Kratos flow-error bodies can carry
    // internal flow state and identifiers not meant for an arbitrary viewer of
    // this unauthenticated endpoint.
    res.send(renderError(
      'Authentication Error',
      (typeof errorBody?.message === 'string' && errorBody.message) || 'An error occurred during authentication.',
      typeof errorBody?.reason === 'string' ? errorBody.reason : undefined,
    ));
  } catch (err: any) {
    console.error('Error flow error:', err?.response?.data || err.message);
    res.send(renderError('Error', 'Failed to retrieve error details.', errorId));
  }
});

export default router;
