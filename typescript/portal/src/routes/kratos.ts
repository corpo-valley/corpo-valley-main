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

    // No "Create an account" link — self-service registration is disabled
    // (accounts are provisioned by an admin). Only the recovery link remains.
    const footer = `<div class="links">
      <a href="${kratosBrowserUrl}/self-service/recovery/browser">Forgot password?</a>
    </div>`;

    res.send(renderLoginPage(
      flow.ui.action,
      flow.ui.nodes as any,
      flow.ui.messages as any,
      footer,
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

// Self-service registration is disabled platform-wide (Kratos
// selfservice.flows.registration.enabled=false). There is no portal
// /registration route — accounts are created by an admin via /admin/users.

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
    res.send(renderError(
      'Authentication Error',
      errorBody?.message || 'An error occurred during authentication.',
      errorBody?.reason || JSON.stringify(errorBody, null, 2),
    ));
  } catch (err: any) {
    console.error('Error flow error:', err?.response?.data || err.message);
    res.send(renderError('Error', 'Failed to retrieve error details.', errorId));
  }
});

export default router;
