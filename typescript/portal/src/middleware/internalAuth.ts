import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

// Shared-secret authentication for /internal/* webhook routes that are NOT
// otherwise authenticated (i.e. the Kratos after-registration hook). Network
// origin alone (requireInClusterCaller) is not authentication — any in-cluster
// pod, including tenant-controlled Gitea Actions runners, can reach the portal
// Service without forwarded-proxy headers and from an RFC1918 address.
//
// The caller (Kratos `web_hook` action config / deploy) must send the secret in
// `Authorization: Bearer <secret>` or `X-Internal-Secret: <secret>`. The secret
// lives in INTERNAL_WEBHOOK_SECRET, mirrored into the Kratos webhook config and
// the chart. We fail CLOSED when it is unset so a misconfigured deploy can never
// silently fall back to the network-origin heuristic.

const INTERNAL_WEBHOOK_SECRET = (process.env.INTERNAL_WEBHOOK_SECRET || '').trim();

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function extractSecret(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (m) return m[1];
  }
  const hdr = req.headers['x-internal-secret'];
  if (typeof hdr === 'string' && hdr) return hdr;
  return null;
}

export function requireInternalSecret(req: Request, res: Response, next: NextFunction): void {
  if (!INTERNAL_WEBHOOK_SECRET) {
    console.error('[internal] INTERNAL_WEBHOOK_SECRET is not set — refusing webhook (fail closed).');
    res.status(503).json({ error: 'internal webhook auth not configured' });
    return;
  }
  const provided = extractSecret(req);
  if (!provided || !timingSafeEqualStr(provided, INTERNAL_WEBHOOK_SECRET)) {
    // 404 (not 401) so an unauthenticated prober can't even confirm the route
    // exists — same shape requireInClusterCaller already returns.
    res.status(404).end();
    return;
  }
  next();
}
