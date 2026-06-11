import { Router, Request, Response } from 'express';
import { Configuration, OAuth2Api } from '@ory/client';
import { renderError, renderInfo, renderConsentPage, renderLogoutConfirm, renderFormRedirect } from '../templates';
import { getIdentity } from '../services/kratos-admin';
import { getProjectBySlug } from '../services/projects';
import { userCanAccessService } from '../services/keto';
import { requireSession } from '../middleware/session';
import { validateCsrf, csrfHiddenField } from '../middleware/csrf';

const router = Router();

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';
const PROJECTS_DOMAIN = process.env.PROJECTS_DOMAIN || 'projects.corpo-valley.com';

// Parse the project slug out of a per-project MCP resource indicator
// (`https://<slug>.<PROJECTS_DOMAIN>/mcp`). Returns null for any audience that
// isn't a project-MCP resource — those pass through ownership filtering.
function projectSlugFromResource(resource: string): string | null {
  try {
    const u = new URL(resource);
    const suffix = '.' + PROJECTS_DOMAIN;
    if (!u.hostname.endsWith(suffix)) return null;
    const slug = u.hostname.slice(0, -suffix.length);
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(slug)) return null;
    return slug;
  } catch {
    return null;
  }
}

// Root-cause defense for the MCP confused-deputy: a client can request ANY
// resource indicator, so before Hydra stamps a per-project MCP resource into a
// token's `aud`, drop any such audience the consenting subject doesn't own.
// Non-project audiences (the platform MCP, OIDC clients) pass through untouched.
// The gateway re-checks ownership per request; this stops the token issuing at all.
async function filterOwnedAudiences(requested: string[], subject: string): Promise<string[]> {
  const out: string[] = [];
  for (const aud of requested) {
    const slug = projectSlugFromResource(aud);
    if (!slug) { out.push(aud); continue; }
    const project = await getProjectBySlug(slug);
    if (project && project.owner_id === subject) {
      out.push(aud);
    } else {
      console.warn('[consent] dropping audience for project not owned by subject', { aud, subject });
    }
  }
  return out;
}

const hydra = new OAuth2Api(
  new Configuration({ basePath: hydraAdminUrl })
);

// Build the OIDC id_token claims for a Kratos identity. Standard claims:
//   sub                 = identity UUID (handled by Hydra automatically)
//   email               = traits.email
//   email_verified      = whether the email is verified in Kratos
//   name / given_name / family_name  = if traits.name is set
//   preferred_username  = if traits.preferred_username is set
//
// Always look up the identity via Kratos admin so the claims are real. The
// default `subject` field is the Kratos UUID — passing that as the email
// claim breaks OIDC clients (e.g. Gitea) that look users up by email.
async function buildIdTokenClaims(subject: string): Promise<Record<string, any>> {
  const claims: Record<string, any> = {};
  try {
    const identity = await getIdentity(subject);
    const traits = (identity.traits ?? {}) as Record<string, any>;
    if (traits.email) {
      claims.email = traits.email;
      // Case-insensitive match, consistent with the verified-email checks in
      // middleware/session.ts and routes/mcp.ts (Kratos may store the address in
      // a different case than the trait).
      const verified = identity.verifiable_addresses?.some(
        (v: any) => v.value?.toLowerCase() === String(traits.email).toLowerCase() && v.verified,
      );
      claims.email_verified = !!verified;
    }
    const first = traits.name?.first;
    const last = traits.name?.last;
    if (first || last) {
      const full = `${first || ''} ${last || ''}`.trim();
      if (full) claims.name = full;
      if (first) claims.given_name = first;
      if (last) claims.family_name = last;
    }
    if (traits.preferred_username) {
      claims.preferred_username = traits.preferred_username;
    }
  } catch (err: any) {
    console.error('id_token claim lookup failed for', subject, err.message);
  }
  return claims;
}

// Finish a form POST with a same-origin page that navigates client-side.
// Chromium enforces CSP `form-action` on the redirect chain of a form
// submission, so a 302 from /consent/* or /logout/accept to the Hydra origin
// (and onward to the OAuth client's arbitrary redirect_uri — localhost,
// claude.ai, vscode://…) is silently cancelled and the page looks like the
// button did nothing. redirect_to always comes from Hydra, but the scheme
// check costs nothing.
function sendFormRedirect(res: Response, url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    res.status(500).send(renderError('Redirect Error', 'Unexpected redirect target.'));
    return;
  }
  res.send(renderFormRedirect(url));
}

// Known first-party clients that can skip the consent screen. Gitea will use
// this once it's onboarded as an OIDC client of Hydra.
const TRUSTED_CLIENTS = new Set(
  (process.env.TRUSTED_CLIENT_IDS || 'argocd,gitea').split(',').filter(Boolean)
);

function isTrustedClient(clientId: string | undefined): boolean {
  if (!clientId) return false;
  return TRUSTED_CLIENTS.has(clientId);
}

// Enforce the per-service tier gate for admin-registered service clients. The
// platform's Admin → Apps UI assigns each registered service a required tier
// (EVERYONE/BETA/ALPHA/ADMIN), but nothing consulted it at request time, so the
// gating was decorative — any authenticated user could complete consent for any
// service regardless of its tier. We close that here, at the point Hydra issues
// the service a token. Trusted first-party clients (argocd/gitea) and
// dynamically-registered clients (the MCP OAuth flow, which carry no tier) are
// unaffected: userCanAccessService returns true when no tier tuple exists.
// Returns true if allowed; otherwise sends a 403 and returns false. Any Keto
// error propagates (caught by the route's try/catch → 500), i.e. fail closed.
async function ensureServiceTierAccess(
  res: Response,
  clientId: string | undefined,
  subject: string,
): Promise<boolean> {
  if (!clientId) return true;
  if (await userCanAccessService(subject, clientId)) return true;
  console.warn('[consent] tier gate denied: subject lacks required tier for service', { clientId, subject });
  res.status(403).send(renderError('Access Denied', 'Your account tier does not have access to this application.'));
  return false;
}

// Verify the active Kratos session owns the consent challenge. Without this,
// an attacker who lures a logged-in victim (or forges a cross-site POST) could
// have Hydra mint tokens carrying the VICTIM's subject for an attacker-
// registered client — a textbook OAuth confused-deputy. Returns the consent
// request on success, or null after having sent an error/redirect response.
async function loadConsentForSession(
  req: Request,
  res: Response,
  consentChallenge: string,
): Promise<Awaited<ReturnType<typeof hydra.getOAuth2ConsentRequest>>['data'] | null> {
  const { data: consentRequest } = await hydra.getOAuth2ConsentRequest({ consentChallenge });
  const sessionSubject = req.portalSession?.id;
  if (!sessionSubject || consentRequest.subject !== sessionSubject) {
    console.warn('[consent] subject mismatch', { challenge_subject: consentRequest.subject, session_subject: sessionSubject });
    res.status(403).send(renderError('Consent Error', 'This authorization request does not belong to your session.'));
    return null;
  }
  return consentRequest;
}

// GET /consent — Handle Hydra OAuth2 consent. requireSession ensures we know
// who the browser is before we ever act on the challenge.
router.get('/consent', requireSession, async (req: Request, res: Response) => {
  const consentChallenge = req.query.consent_challenge as string | undefined;

  if (!consentChallenge) {
    return res.status(400).send(renderError('Consent Error', 'Missing consent_challenge parameter.'));
  }

  try {
    const consentRequest = await loadConsentForSession(req, res, consentChallenge);
    if (!consentRequest) return;

    const grantScope = consentRequest.requested_scope || [];
    const grantAccessTokenAudience = consentRequest.requested_access_token_audience || [];
    const clientId = consentRequest.client?.client_id;
    const clientName = consentRequest.client?.client_name || clientId || 'Unknown';

    // Auto-accept for trusted first-party clients — only after the subject-
    // equality check above has confirmed the session owns this challenge.
    if (isTrustedClient(clientId)) {
      const idTokenClaims = await buildIdTokenClaims(consentRequest.subject || '');
      const { data: completedRequest } = await hydra.acceptOAuth2ConsentRequest({
        consentChallenge,
        acceptOAuth2ConsentRequest: {
          grant_scope: grantScope,
          grant_access_token_audience: await filterOwnedAudiences(grantAccessTokenAudience, consentRequest.subject || ''),
          remember: true,
          remember_for: 3600,
          session: { id_token: idTokenClaims },
        },
      });
      // Plain GET navigation (no form submission), so a 302 is not subject to
      // the form-action enforcement that sendFormRedirect works around.
      return res.redirect(completedRequest.redirect_to);
    }

    // Tier gate: deny before showing consent if the subject's tier is below the
    // service's required tier. (Trusted clients above are exempt by design.)
    if (!(await ensureServiceTierAccess(res, clientId, consentRequest.subject || ''))) return;

    // For unknown/external clients, show consent page (with a CSRF token).
    res.send(renderConsentPage(
      clientName,
      grantScope,
      consentChallenge,
      csrfHiddenField(req, res),
    ));
  } catch (err: any) {
    console.error('Consent error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Consent Error', 'Failed to process consent request.'));
  }
});

// POST /consent/accept — User approves consent. requireSession + validateCsrf
// + subject-equality close the confused-deputy hole.
router.post('/consent/accept', requireSession, validateCsrf, async (req: Request, res: Response) => {
  const consentChallenge = req.body?.consent_challenge;

  if (!consentChallenge) {
    return res.status(400).send(renderError('Consent Error', 'Missing consent challenge.'));
  }

  try {
    const consentRequest = await loadConsentForSession(req, res, consentChallenge);
    if (!consentRequest) return;

    // Re-check the service tier gate at the point of issuance (defense in depth
    // against a direct POST that skips the GET render).
    if (!(await ensureServiceTierAccess(res, consentRequest.client?.client_id, consentRequest.subject || ''))) return;

    const idTokenClaims = await buildIdTokenClaims(consentRequest.subject || '');
    const { data: completedRequest } = await hydra.acceptOAuth2ConsentRequest({
      consentChallenge,
      acceptOAuth2ConsentRequest: {
        grant_scope: consentRequest.requested_scope || [],
        grant_access_token_audience: await filterOwnedAudiences(consentRequest.requested_access_token_audience || [], consentRequest.subject || ''),
        remember: true,
        remember_for: 3600,
        session: { id_token: idTokenClaims },
      },
    });

    return sendFormRedirect(res, completedRequest.redirect_to);
  } catch (err: any) {
    console.error('Consent accept error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Consent Error', 'Failed to accept consent.'));
  }
});

// POST /consent/deny — User denies consent
router.post('/consent/deny', requireSession, validateCsrf, async (req: Request, res: Response) => {
  const consentChallenge = req.body?.consent_challenge;

  if (!consentChallenge) {
    return res.status(400).send(renderError('Consent Error', 'Missing consent challenge.'));
  }

  try {
    // Confirm the session owns this challenge before rejecting it.
    const owned = await loadConsentForSession(req, res, consentChallenge);
    if (!owned) return;
    const { data: completedRequest } = await hydra.rejectOAuth2ConsentRequest({
      consentChallenge,
      rejectOAuth2Request: {
        error: 'access_denied',
        error_description: 'The user denied the consent request.',
      },
    });

    return sendFormRedirect(res, completedRequest.redirect_to);
  } catch (err: any) {
    console.error('Consent deny error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Consent Error', 'Failed to deny consent.'));
  }
});

// GET /logout — Handle logout (Kratos session + Hydra OAuth2). requireSession
// so we always know who the browser is before acting on a logout challenge.
router.get('/logout', requireSession, async (req: Request, res: Response) => {
  const logoutChallenge = req.query.logout_challenge as string | undefined;

  // Hydra OAuth2 logout callback. Do NOT auto-accept on GET: verify the active
  // session owns the challenge, then render a CSRF-protected confirmation that
  // POSTs to /logout/accept. This stops a forged GET from terminating an
  // arbitrary subject's session.
  if (logoutChallenge) {
    try {
      const { data: logoutRequest } = await hydra.getOAuth2LogoutRequest({ logoutChallenge });
      if (!req.portalSession?.id || logoutRequest.subject !== req.portalSession.id) {
        console.warn('[logout] subject mismatch', { challenge_subject: logoutRequest.subject, session_subject: req.portalSession?.id });
        await hydra.rejectOAuth2LogoutRequest({ logoutChallenge }).catch(() => {});
        return res.status(403).send(renderError('Logout Error', 'This logout request does not belong to your session.'));
      }
      return res.send(renderLogoutConfirm(logoutChallenge, csrfHiddenField(req, res)));
    } catch (err: any) {
      console.error('Hydra logout error:', err?.response?.data || err.message);
      return res.send(renderInfo('Logged Out', 'You have been logged out.'));
    }
  }

  // Browser-initiated logout — create a Kratos logout flow and redirect to it
  const kratosPublicUrl = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';
  try {
    const resp = await fetch(`${kratosPublicUrl}/self-service/logout/browser`, {
      headers: { cookie: req.headers.cookie || '' },
      redirect: 'manual',
    });
    const data = await resp.json() as { logout_url?: string };
    if (data.logout_url) {
      return res.redirect(data.logout_url);
    }
  } catch (err: any) {
    console.error('Kratos logout error:', err.message);
  }

  // Fallback: clear cookie manually and show logged out page
  res.clearCookie('ory_kratos_session');
  res.send(renderInfo('Logged Out', 'You have been logged out successfully.'));
});

// POST /logout/accept — confirm a Hydra logout challenge. requireSession +
// validateCsrf + subject-equality before accepting.
router.post('/logout/accept', requireSession, validateCsrf, async (req: Request, res: Response) => {
  const logoutChallenge = req.body?.logout_challenge;
  if (!logoutChallenge) {
    return res.status(400).send(renderError('Logout Error', 'Missing logout challenge.'));
  }
  try {
    const { data: logoutRequest } = await hydra.getOAuth2LogoutRequest({ logoutChallenge });
    if (!req.portalSession?.id || logoutRequest.subject !== req.portalSession.id) {
      await hydra.rejectOAuth2LogoutRequest({ logoutChallenge }).catch(() => {});
      return res.status(403).send(renderError('Logout Error', 'This logout request does not belong to your session.'));
    }
    const { data: completedRequest } = await hydra.acceptOAuth2LogoutRequest({ logoutChallenge });
    return sendFormRedirect(res, completedRequest.redirect_to);
  } catch (err: any) {
    console.error('Hydra logout accept error:', err?.response?.data || err.message);
    return res.send(renderInfo('Logged Out', 'You have been logged out.'));
  }
});

export default router;
