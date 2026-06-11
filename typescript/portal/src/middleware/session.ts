import { Request, Response, NextFunction } from 'express';
import { Configuration, FrontendApi } from '@ory/client';

const kratosPublicUrl = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';
const kratosBrowserUrl = process.env.KRATOS_BROWSER_URL || kratosPublicUrl;

const kratos = new FrontendApi(
  new Configuration({ basePath: kratosPublicUrl })
);

export interface PortalSession {
  id: string;
  email: string;
  name?: string;
  // Kratos `preferred_username` trait — used as the Gitea login. May be
  // absent if the identity never set one.
  preferredUsername?: string;
  // Whether the identity's primary email is verified in Kratos. Provisioning
  // routes (project create, key/token minting) require this so an unverified
  // self-registered user can't immediately spin up real compute / repos.
  emailVerified: boolean;
}

declare global {
  namespace Express {
    interface Request {
      portalSession?: PortalSession;
    }
  }
}

export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { data: session } = await kratos.toSession({
      cookie: req.headers.cookie,
    });

    const traits = session.identity?.traits as Record<string, any> | undefined;
    const email = traits?.email || '';
    const verifiable = session.identity?.verifiable_addresses || [];
    const emailVerified = verifiable.some(
      (v: any) => v.value?.toLowerCase() === email.toLowerCase() && v.verified,
    );
    req.portalSession = {
      id: session.identity?.id || '',
      email,
      name: traits?.name?.first
        ? `${traits.name.first} ${traits.name.last || ''}`.trim()
        : undefined,
      preferredUsername: traits?.preferred_username || undefined,
      emailVerified,
    };
    next();
  } catch (err: any) {
    // Distinguish "no/expired session" from "Kratos is down". A 401/403 is the
    // expected unauthenticated case → bounce to login. A network error or 5xx
    // means the identity service itself is unreachable: redirecting there would
    // mask the outage as a logout (and can loop, since the login page can't load
    // either). Fail visibly with a 503 instead.
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      res.redirect(`${kratosBrowserUrl}/self-service/login/browser`);
      return;
    }
    console.error('[session] Kratos toSession failed:', err?.message || err);
    res.status(503).send('Authentication service temporarily unavailable. Please try again shortly.');
  }
}

// Gate for provisioning/credential-minting routes: requires a verified email on
// top of an active session. Mount AFTER requireSession. Returns 403 (rather than
// silently provisioning) so an unverified self-registered user can't create
// projects, mint Gitea/CLI tokens, or issue API keys until they verify.
export function requireVerifiedEmail(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.portalSession?.emailVerified) {
    res.status(403).send(
      'Email verification required. Please verify your email address before provisioning resources.',
    );
    return;
  }
  next();
}
