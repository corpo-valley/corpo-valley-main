import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// CSRF protection bound to the authenticated Kratos session.
//
// The previous design was a stateless double-submit (cookie value == body
// value). That is unsafe here because the portal (portal.corpo-valley.com)
// shares the registrable parent domain `corpo-valley.com` with tenant-
// controlled project hosts (`<slug>.projects.corpo-valley.com`). A tenant can
// emit `Set-Cookie: _csrf=...; Domain=corpo-valley.com` from their own host,
// shadowing the portal's host-only cookie with an attacker-known value and
// defeating the equality check.
//
// Instead the token is an HMAC over the victim's Kratos session cookie value
// under a server-side secret. An attacker cannot read the httpOnly Kratos
// session cookie and does not know the server secret, so they cannot produce a
// token that validates against the victim's session — cookie shadowing is moot
// because we never compare against an attacker-writable cookie. We additionally
// enforce an Origin/Referer allowlist on state-changing requests.

const CSRF_FIELD = '_csrf_token';
const KRATOS_SESSION_COOKIE = 'ory_kratos_session';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// HMAC key: prefer the dedicated CSRF secret, else reuse PORTAL_SECRET_KEY (a
// server-only secret already required for at-rest encryption). Falling back to a
// per-process random key keeps local dev working but would break across replicas
// — production must set one of the env secrets.
let cachedKey: Buffer | null = null;
function csrfKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = (process.env.CSRF_HMAC_SECRET || process.env.PORTAL_SECRET_KEY || '').trim();
  if (raw) {
    cachedKey = crypto.createHash('sha256').update(raw).digest();
  } else {
    console.warn('[csrf] neither CSRF_HMAC_SECRET nor PORTAL_SECRET_KEY set — using an ephemeral per-process key (breaks multi-replica). Set one in production.');
    cachedKey = crypto.randomBytes(32);
  }
  return cachedKey;
}

function tokenForSession(req: Request): string {
  const session = req.cookies?.[KRATOS_SESSION_COOKIE] || '';
  return crypto.createHmac('sha256', csrfKey()).update(session).digest('hex');
}

export function csrfToken(req: Request, _res: Response): string {
  // Bound to the current Kratos session; deterministic so the token embedded in
  // a rendered form matches what validateCsrf recomputes on the POST.
  return tokenForSession(req);
}

export function csrfHiddenField(req: Request, res: Response): string {
  const token = csrfToken(req, res);
  return `<input type="hidden" name="${CSRF_FIELD}" value="${token}">`;
}

function originAllowed(req: Request): boolean {
  // Fail CLOSED on a state-changing request that carries neither Origin nor
  // Referer: browsers reliably send Origin on form POSTs, and legitimate
  // non-browser automation should use the API-key/Hydra path (exempt from this
  // middleware), not cookie-authenticated dashboard routes. A header-less POST
  // is therefore treated as cross-origin.
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const source = origin || referer;
  if (!source) return false;
  try {
    const u = new URL(source);
    const base = new URL(BASE_URL);
    return u.protocol === base.protocol && u.host === base.host;
  } catch {
    return false;
  }
}

export function validateCsrf(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }

  if (!originAllowed(req)) {
    res.status(403).send('CSRF validation failed (origin)');
    return;
  }

  // Compare on BYTE length (not UTF-16 code units) and wrap timingSafeEqual in
  // try/catch — attacker-controlled multibyte input whose string length equals
  // the token's would otherwise make timingSafeEqual throw (RangeError on
  // unequal byte length) and surface as a 500 instead of a clean 403.
  const expected = Buffer.from(tokenForSession(req), 'utf8');
  const providedRaw = req.body?.[CSRF_FIELD];
  const provided = Buffer.from(typeof providedRaw === 'string' ? providedRaw : '', 'utf8');
  let ok = false;
  if (provided.length === expected.length) {
    try { ok = crypto.timingSafeEqual(provided, expected); } catch { ok = false; }
  }
  if (!ok) {
    res.status(403).send('CSRF validation failed');
    return;
  }

  next();
}
