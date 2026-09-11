// Ingress auth-subrequest target for project websites.
//
// Every request to https://<slug>.<PROJECTS_DOMAIN> triggers an nginx
// auth_request to GET /access/site/<slug> with the visitor's cookies. We
// resolve the Kratos session, compute the visitor's effective SITE permission
// (owner → admin; else max(default dial, direct grants, group grants) — see
// services/access.ts), and answer:
//
//   401  no session            → nginx bounces to the portal login (auth-signin)
//   403  signed in, no `read`  → blocked at the edge; the app never sees it
//   200  read/write/admin      → request proceeds, with identity headers
//
// On 200 we stamp the developer-facing contract headers; the Ingress carries
// `auth-response-headers: X-CV-User-Id, X-CV-User-Email, X-CV-Perm`, which
// makes nginx OVERWRITE any client-supplied copies on the upstream request —
// project code may trust them blind (community-center/docs/ACCESS.md).
//
// This endpoint is on the hot path of every project request, so both lookups
// are memoized briefly: sessions per cookie value, permissions per
// (user, slug). TTLs are short enough that a grant change or logout lands
// within seconds. It is intentionally session-middleware-free and safe to
// expose: it only ever reflects the caller's own identity and permission.

import { Router, Request, Response } from 'express';
import { Configuration, FrontendApi } from '@ory/client';
import { getProjectBySlug } from '../services/projects';
import { effectiveSitePerm } from '../services/access';
import { recordActivity } from '../services/achievements';

const router = Router();

const kratos = new FrontendApi(
  new Configuration({ basePath: process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433' })
);

const SLUG_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

interface CacheEntry<T> { val: T; exp: number; }

// Session cache keyed on the ory_kratos_session cookie VALUE (not the whole
// header), so unrelated cookies don't fragment it and a fresh login is never
// shadowed by a stale negative entry. Mirrors community-center/lib/identity.js.
const SESSION_TTL_MS = 10_000;
const SESSION_NEG_TTL_MS = 3_000;
const sessionCache = new Map<string, CacheEntry<{ id: string; email: string } | null>>();

// Permission cache keyed on user+slug. Short TTL: a revoked grant or a default
// flipped to `none` locks the visitor out within PERM_TTL_MS.
const PERM_TTL_MS = 5_000;
const permCache = new Map<string, CacheEntry<string>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  return undefined;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, val: T, ttl: number): void {
  // Bounded: a flush is fine, entries are cheap to refill.
  if (map.size > 5000) map.clear();
  map.set(key, { val, exp: Date.now() + ttl });
}

// In-memory throttle for the site-view counter: at most one recordActivity
// attempt per (viewer, slug) per UTC day per process. The DB day-cap (see
// recordActivity) is the durable backstop; this just keeps us from touching the
// DB on the hot path more than once a day per viewer/project.
const viewedToday = new Set<string>();

function markViewed(userId: string, slug: string): boolean {
  const key = `${userId}:${slug}:${Math.floor(Date.now() / 86_400_000)}`;
  if (viewedToday.has(key)) return false;
  if (viewedToday.size > 50_000) viewedToday.clear();
  viewedToday.add(key);
  return true;
}

function sessionToken(cookieHeader: string): string | null {
  const m = /(?:^|;\s*)ory_kratos_session=([^;]+)/.exec(cookieHeader);
  return m ? m[1] : null;
}

async function resolveSession(cookieHeader: string): Promise<{ id: string; email: string } | null> {
  const token = sessionToken(cookieHeader);
  if (!token) return null;
  const hit = cacheGet(sessionCache, token);
  if (hit !== undefined) return hit;

  let val: { id: string; email: string } | null = null;
  try {
    const { data: session } = await kratos.toSession({ cookie: cookieHeader });
    const traits = session.identity?.traits as Record<string, any> | undefined;
    if (session.identity?.id) {
      val = { id: session.identity.id, email: traits?.email || '' };
    }
  } catch {
    // 401 (no session) and Kratos outages both land here. Caching the
    // negative briefly keeps a cookie-less crawler from hammering Kratos;
    // failing CLOSED (401) is the right outage behavior for an auth gate.
    val = null;
  }
  cacheSet(sessionCache, token, val, val ? SESSION_TTL_MS : SESSION_NEG_TTL_MS);
  return val;
}

router.get('/access/site/:slug', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const slug = String(req.params.slug || '');
  if (!SLUG_RE.test(slug)) {
    res.status(403).end();
    return;
  }

  const user = await resolveSession(req.headers.cookie || '');
  if (!user) {
    res.status(401).end();
    return;
  }

  try {
    const permKey = `${user.id}:${slug}`;
    let perm = cacheGet(permCache, permKey);
    if (perm === undefined) {
      const project = await getProjectBySlug(slug);
      perm = project ? await effectiveSitePerm(project, user.id) : 'none';
      cacheSet(permCache, permKey, perm, PERM_TTL_MS);
      // Popularity: count a site view when a non-owner is admitted. Fire-and-
      // forget + in-memory day-throttle + DB day-cap, so it never blocks or
      // materially loads this ingress auth hot path. Only runs on perm-cache
      // misses (~once per 5s per viewer/slug), never on the memoized fast path.
      if (project && perm !== 'none' && project.owner_id !== user.id && markViewed(user.id, slug)) {
        void recordActivity(user.id, 'project_view', project.id, project.owner_id);
      }
    }
    if (perm === 'none') {
      res.status(403).end();
      return;
    }
    res.set('X-CV-User-Id', user.id);
    res.set('X-CV-User-Email', user.email);
    res.set('X-CV-Perm', perm);
    res.status(200).end();
  } catch (err: any) {
    // DB hiccup: fail closed (403, not 500 — nginx turns other codes into a
    // client-facing 500 with no signin redirect anyway; 403 is the honest
    // "not allowed right now").
    console.error('[site-access] permission lookup failed for', slug, err?.message);
    res.status(403).end();
  }
});

export default router;
