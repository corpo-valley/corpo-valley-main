// Per-project CV_PIN_TOKEN — the secret the project's Build workflow
// sends to POST /internal/projects/:slug/pin so the portal can verify
// the request is coming from that specific project's workflow (not
// another project's runner reaching the in-cluster endpoint).
//
// The plaintext token is set as a Gitea Actions secret on the project's
// repo at create time and is never stored server-side; we keep only
// `sha256(token)` in the projects row.

import * as crypto from 'crypto';

// 32 bytes -> 43-char base64url. URL-safe so it round-trips through
// HTTP headers / shell quoting without escaping.
export function generatePinToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashPinToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// Constant-time compare via crypto.timingSafeEqual. Both sides are hex of
// fixed length, so length-mismatch returns false without leaking.
export function pinTokenHashMatches(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
