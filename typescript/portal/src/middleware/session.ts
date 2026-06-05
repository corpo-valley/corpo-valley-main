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
    req.portalSession = {
      id: session.identity?.id || '',
      email: traits?.email || '',
      name: traits?.name?.first
        ? `${traits.name.first} ${traits.name.last || ''}`.trim()
        : undefined,
      preferredUsername: traits?.preferred_username || undefined,
    };
    next();
  } catch {
    res.redirect(`${kratosBrowserUrl}/self-service/login/browser`);
  }
}
