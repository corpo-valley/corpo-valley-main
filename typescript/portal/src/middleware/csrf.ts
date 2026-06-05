import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const CSRF_COOKIE = '_csrf';
const CSRF_FIELD = '_csrf_token';

export function csrfToken(req: Request, res: Response): string {
  // Reuse existing token from cookie if present
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token) {
    token = crypto.randomUUID();
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // Cloudflare terminates SSL
    });
  }
  return token;
}

export function csrfHiddenField(req: Request, res: Response): string {
  const token = csrfToken(req, res);
  return `<input type="hidden" name="${CSRF_FIELD}" value="${token}">`;
}

export function validateCsrf(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const bodyToken = req.body?.[CSRF_FIELD];

  if (!cookieToken || !bodyToken || cookieToken !== bodyToken) {
    res.status(403).send('CSRF validation failed');
    return;
  }

  next();
}
