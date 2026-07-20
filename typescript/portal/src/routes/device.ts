import { Router, Request, Response } from 'express';
import { Configuration, OAuth2Api } from '@ory/client';
import { renderDeviceCodePage, renderInfo, renderError, renderFormRedirect } from '../templates';
import { validateCsrf, csrfHiddenField } from '../middleware/csrf';

// OAuth 2.0 Device Authorization Grant (RFC 8628) — the browser side.
//
// STATUS: INERT on the current Ory Hydra v2.3.0 — that version has no device
// config (no urls.device, no device endpoints), so Hydra never redirects here
// and discovery does not advertise the grant (see routes/mcp.ts). This code is
// complete and ready; it activates once Hydra is upgraded to a version with
// device-flow support and the chart sets urls.device.{verification,success}.
//
// A headless/CLI client (e.g. an MCP client that can't complete an interactive
// browser login) POSTs to Hydra's /oauth2/device/auth, gets a user_code +
// verification URI, and long-polls /oauth2/token. The human opens the
// verification URI in ANY browser; Hydra's /oauth2/device/verify redirects here
// (urls.device.verification) with a device_challenge so the code can be entered
// and paired. Accepting the code hands control back to Hydra, which then runs
// the STANDARD login + consent flow (routes/kratos.ts, routes/hydra.ts) — no
// device-specific login/consent handling is needed. This is the legitimate path
// for the headless clients that would otherwise dead-end at the login page.

const router = Router();

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';
const hydra = new OAuth2Api(new Configuration({ basePath: hydraAdminUrl }));

// Continue a form POST via a same-origin client-side navigation instead of a
// 302, so CSP `form-action` can't cancel the redirect chain that continues into
// Hydra and onward. Same rationale as routes/hydra.ts's sendFormRedirect.
function sendFormRedirect(res: Response, url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    res.status(500).send(renderError('Device Error', 'Unexpected redirect target.'));
    return;
  }
  res.set('Cache-Control', 'no-store').send(renderFormRedirect(url));
}

// GET /device — code-entry UI. No requireSession: the user may not be logged in
// yet (login happens AFTER the code is accepted, when Hydra drives the standard
// login flow). Hydra passes device_challenge (always) and user_code (only when
// the device used the "complete" verification URI).
router.get('/device', (req: Request, res: Response) => {
  const deviceChallenge = req.query.device_challenge as string | undefined;
  const userCode = (req.query.user_code as string | undefined) || '';
  if (!deviceChallenge) {
    return res.status(400).send(renderError(
      'Device Error',
      'This page must be reached from the verification link shown on your device.',
    ));
  }
  res.send(renderDeviceCodePage(deviceChallenge, userCode, csrfHiddenField(req, res)));
});

// POST /device/accept — submit the entered user code to Hydra. On success Hydra
// returns a redirect that continues into the normal login/consent flow.
router.post('/device/accept', validateCsrf, async (req: Request, res: Response) => {
  const deviceChallenge = req.body?.device_challenge;
  const userCode = String(req.body?.user_code || '').trim();
  if (!deviceChallenge || !userCode) {
    return res.status(400).send(renderError('Device Error', 'Missing device code.'));
  }

  try {
    const { data } = await hydra.acceptUserCodeRequest({
      deviceChallenge,
      acceptDeviceUserCodeRequest: { user_code: userCode },
    });
    return sendFormRedirect(res, data.redirect_to);
  } catch (err: any) {
    const status = err?.response?.status;
    // A wrong/expired/already-used code comes back 4xx — re-render the form with
    // an inline error so the human can retry, rather than a dead-end page.
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return res.status(400).send(renderDeviceCodePage(
        deviceChallenge,
        userCode,
        csrfHiddenField(req, res),
        [{ type: 'error', text: 'That code is invalid or has expired. Check the code on your device and try again.' }],
      ));
    }
    console.error('Device accept error:', err?.response?.data || err.message);
    return res.status(500).send(renderError('Device Error', 'Failed to verify the device code.'));
  }
});

// GET /device/success — Hydra's urls.device.success target; the browser lands
// here after login + consent complete. The device's own token poll now succeeds.
router.get('/device/success', (_req: Request, res: Response) => {
  res.send(renderInfo(
    'Device connected',
    'You have authorized the device. Return to your device or CLI — it will finish signing in automatically.',
  ));
});

export default router;
