import { rateLimit } from 'express-rate-limit';
import type { Request, Response } from 'express';

// Per-IP rate limiting for the portal's unauthenticated auth surface
// (findings #4 and #5): the interactive Kratos/Hydra flow pages, the Dynamic
// Client Registration proxy, and the OAuth discovery documents.
//
// Trust-proxy / IP-keying correctness: the portal sits behind Cloudflare →
// ingress-nginx → this app, and index.ts already sets `app.set('trust proxy', 1)`
// so `req.ip` is the client IP from X-Forwarded-For (the last hop appended by
// ingress-nginx, which clients can't forge) rather than the ingress pod IP.
// We therefore rely on the default express-rate-limit keyGenerator (req.ip);
// v7 validates the trust-proxy setting at startup and would loudly warn if it
// were permissive enough to be spoofable or strict enough to key everyone as
// one IP.
//
// All limiters return machine-readable JSON on 429 — never HTML — because the
// throttled endpoints are hit by OAuth/MCP clients as well as browsers, and an
// HTML error page would confuse programmatic clients mid-flow.

const jsonTooManyRequests = (_req: Request, res: Response) => {
  res.status(429).json({ error: 'too_many_requests' });
};

const common = {
  standardHeaders: 'draft-7' as const, // RateLimit / RateLimit-Policy headers
  legacyHeaders: false, // no X-RateLimit-* legacy headers
  handler: jsonTooManyRequests,
};

// Interactive auth endpoints (/login, /consent, /registration, /recovery,
// /verification, /settings, /error). Moderate: humans clicking through a
// login or recovery flow stay far under this; credential-stuffing and
// recovery-code brute forcing don't.
export const authLimiter = rateLimit({
  ...common,
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 60, // 60 requests / 5 min / IP
});

// Dynamic Client Registration (/oauth2/register, proxied to Hydra). Strict:
// open DCR with no throttle lets an attacker mass-mint OAuth clients
// (client-flooding) or churn out lookalike clients for consent phishing
// (finding #4). Legitimate MCP clients register once and cache the client.
export const dcrLimiter = rateLimit({
  ...common,
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 20, // 20 requests / 10 min / IP
});

// Public badge-profile lookups (/achievements/u/:username). Authenticated, but
// each hit does a Kratos identity scan + badge derivation, so any member could
// loop it to load Kratos/Postgres. Cap it per IP; a human browsing profiles
// stays well under, a scraper does not.
export const profileLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000, // 1 minute
  limit: 60, // 60 profile views / min / IP
});

// OAuth/OIDC discovery documents (/.well-known/*). Lenient but present:
// clients fetch these on every connect, so the ceiling is high — it only
// exists to stop the discovery docs being used as a free amplification /
// scraping target.
export const wellKnownLimiter = rateLimit({
  ...common,
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 240, // 240 requests / 5 min / IP
});
