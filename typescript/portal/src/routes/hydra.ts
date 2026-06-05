import { Router, Request, Response } from 'express';
import { Configuration, OAuth2Api } from '@ory/client';
import { renderError, renderInfo, renderConsentPage } from '../templates';
import { getIdentity } from '../services/kratos-admin';

const router = Router();

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';

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
      const verified = identity.verifiable_addresses?.some(
        (v: any) => v.value === traits.email && v.verified,
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

// Known first-party clients that can skip the consent screen. Gitea will use
// this once it's onboarded as an OIDC client of Hydra.
const TRUSTED_CLIENTS = new Set(
  (process.env.TRUSTED_CLIENT_IDS || 'argocd,gitea').split(',').filter(Boolean)
);

function isTrustedClient(clientId: string | undefined): boolean {
  if (!clientId) return false;
  return TRUSTED_CLIENTS.has(clientId);
}

// GET /consent — Handle Hydra OAuth2 consent
router.get('/consent', async (req: Request, res: Response) => {
  const consentChallenge = req.query.consent_challenge as string | undefined;

  if (!consentChallenge) {
    return res.status(400).send(renderError('Consent Error', 'Missing consent_challenge parameter.'));
  }

  try {
    const { data: consentRequest } = await hydra.getOAuth2ConsentRequest({
      consentChallenge,
    });

    const grantScope = consentRequest.requested_scope || [];
    const grantAccessTokenAudience = consentRequest.requested_access_token_audience || [];
    const clientId = consentRequest.client?.client_id;
    const clientName = consentRequest.client?.client_name || clientId || 'Unknown';

    // Auto-accept for trusted first-party clients
    if (isTrustedClient(clientId)) {
      const idTokenClaims = await buildIdTokenClaims(consentRequest.subject || '');
      const { data: completedRequest } = await hydra.acceptOAuth2ConsentRequest({
        consentChallenge,
        acceptOAuth2ConsentRequest: {
          grant_scope: grantScope,
          grant_access_token_audience: grantAccessTokenAudience,
          remember: true,
          remember_for: 3600,
          session: { id_token: idTokenClaims },
        },
      });
      return res.redirect(completedRequest.redirect_to);
    }

    // For unknown/external clients, show consent page
    res.send(renderConsentPage(
      clientName,
      grantScope,
      consentChallenge,
    ));
  } catch (err: any) {
    console.error('Consent error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Consent Error', 'Failed to process consent request.'));
  }
});

// POST /consent/accept — User approves consent
router.post('/consent/accept', async (req: Request, res: Response) => {
  const consentChallenge = req.body?.consent_challenge;

  if (!consentChallenge) {
    return res.status(400).send(renderError('Consent Error', 'Missing consent challenge.'));
  }

  try {
    const { data: consentRequest } = await hydra.getOAuth2ConsentRequest({
      consentChallenge,
    });

    const idTokenClaims = await buildIdTokenClaims(consentRequest.subject || '');
    const { data: completedRequest } = await hydra.acceptOAuth2ConsentRequest({
      consentChallenge,
      acceptOAuth2ConsentRequest: {
        grant_scope: consentRequest.requested_scope || [],
        grant_access_token_audience: consentRequest.requested_access_token_audience || [],
        remember: true,
        remember_for: 3600,
        session: { id_token: idTokenClaims },
      },
    });

    return res.redirect(completedRequest.redirect_to);
  } catch (err: any) {
    console.error('Consent accept error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Consent Error', 'Failed to accept consent.'));
  }
});

// POST /consent/deny — User denies consent
router.post('/consent/deny', async (req: Request, res: Response) => {
  const consentChallenge = req.body?.consent_challenge;

  if (!consentChallenge) {
    return res.status(400).send(renderError('Consent Error', 'Missing consent challenge.'));
  }

  try {
    const { data: completedRequest } = await hydra.rejectOAuth2ConsentRequest({
      consentChallenge,
      rejectOAuth2Request: {
        error: 'access_denied',
        error_description: 'The user denied the consent request.',
      },
    });

    return res.redirect(completedRequest.redirect_to);
  } catch (err: any) {
    console.error('Consent deny error:', err?.response?.data || err.message);
    res.status(500).send(renderError('Consent Error', 'Failed to deny consent.'));
  }
});

// GET /logout — Handle logout (Kratos session + Hydra OAuth2)
router.get('/logout', async (req: Request, res: Response) => {
  const logoutChallenge = req.query.logout_challenge as string | undefined;

  // Hydra OAuth2 logout callback — accept the challenge and redirect
  if (logoutChallenge) {
    try {
      const { data: completedRequest } = await hydra.acceptOAuth2LogoutRequest({
        logoutChallenge,
      });
      return res.redirect(completedRequest.redirect_to);
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

export default router;
