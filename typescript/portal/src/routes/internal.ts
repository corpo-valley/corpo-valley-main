import { Router, Request, Response, NextFunction } from 'express';
import { getFile, upsertRepoFile, getBranchHead, getCommitStatus } from '../services/gitea';
import { getProjectBySlug, getProjectByPinTokenHash } from '../services/projects';
import { effectiveSitePerm } from '../services/access';
import { hashPinToken, pinTokenHashMatches } from '../services/pin-token';
import { requireInternalSecret } from '../middleware/internalAuth';
import { ensureProvisionedById } from '../services/provisioning';

const router = Router();

// In-cluster-only guard for /internal/* routes that aren't Kratos webhooks
// (Kratos is in-cluster too, but uses a different specific endpoint). The
// portal Ingress sets X-Forwarded-For when proxying external traffic; an
// in-cluster Service-to-Service call goes direct without it. Reject any
// request that carries forwarded-proxy headers — same heuristic
// nginx-ingress itself uses to distinguish edge from internal traffic.
//
// Also restrict the source IP to RFC 1918 (k8s pod CIDR is in 10.0.0.0/8
// on microk8s); requests from anywhere else are rejected even if they
// somehow bypass the header check.
function requireInClusterCaller(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-host']) {
    res.status(404).end();
    return;
  }
  const raw = req.socket?.remoteAddress || '';
  // Normalise IPv6-mapped IPv4 (::ffff:10.x.x.x) before checking.
  const ip = raw.replace(/^::ffff:/, '');
  const isPrivate =
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip === '127.0.0.1';
  if (!isPrivate) {
    res.status(404).end();
    return;
  }
  next();
}

// ── Kratos registration webhooks (Google Workspace signup) ────────────────
//
// POST /internal/hooks/registration — Kratos `after.oidc` registration hook
// (response.ignore=true on the Kratos side, so signup latency doesn't depend
// on us). The body only NAMES an identity id; the portal re-fetches the
// canonical identity from the Kratos admin API and runs the same idempotent
// ensureProvisioned the admin-create flow uses.
//
// Auth: requireInternalSecret (the X-Internal-Secret Kratos sends, configured
// in the kratos-google-oidc sealed fragment) on top of the network-origin
// guard. Without it ANY in-cluster pod — including tenant-controlled
// gitea-runners — could POST here and trigger repeated provisioning fan-out
// against real identities (finding F3). The lazy backstop in the dashboard
// (ensureProvisionedLazy) still covers a hook delivery that flaked.
router.post('/internal/hooks/registration', requireInClusterCaller, requireInternalSecret, async (req: Request, res: Response) => {
  const identityId = String(req.body?.identity_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identityId)) {
    res.status(400).json({ error: 'identity_id required' });
    return;
  }
  try {
    await ensureProvisionedById(identityId);
  } catch (err: any) {
    // Never signal failure back into the registration flow — provisioning is
    // best-effort by design and retried lazily on first dashboard visit.
    console.error('[internal/registration-hook] provisioning failed for', identityId, err?.message);
  }
  res.json({ ok: true });
});

// POST /internal/hooks/registration/deny — `can_interrupt` hook on the
// password and code registration methods. Enabling the registration FLOW for
// Google signup would otherwise re-open password/code self-signup via direct
// Kratos API calls (the portal UI never offered them); this hook makes those
// methods always fail with a user-readable message. Body format per Kratos's
// webhook flow-interrupt contract.
router.post('/internal/hooks/registration/deny', requireInClusterCaller, (_req: Request, res: Response) => {
  res.status(403).json({
    messages: [
      {
        instance_ptr: '#/',
        messages: [
          {
            id: 4000001,
            text: 'Self-service sign-up with a password or email code is disabled. Use "Continue with Google", or ask an administrator to create your account.',
            type: 'error',
          },
        ],
      },
    ],
  });
});

// GET /internal/projects/:slug/owner
//
// Lets the MCP gateway verify that the authenticated user actually OWNS the
// project named by the request's host slug before it reverse-proxies into the
// tenant container. The gateway's audience check alone is insufficient: Hydra
// grants whatever resource indicator a client requests, so a user can legitimately
// mint a token whose `aud` names a project they don't own. This endpoint is the
// per-request ownership backstop. Authenticated with the shared internal secret.
router.get('/internal/projects/:slug/owner', requireInternalSecret, requireInClusterCaller, async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '');
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(slug)) {
    res.status(400).json({ error: 'invalid slug' });
    return;
  }
  try {
    const project = await getProjectBySlug(slug);
    if (!project) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ owner_id: project.owner_id, slug: project.slug });
  } catch (err: any) {
    console.error('[internal/owner] error for', slug, err?.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /internal/projects/:slug/access/:sub
//
// The MCP gateway's per-request authorization. MCP is a project's app over a
// different protocol, so access mirrors the SITE gate: this returns the caller's
// effective site permission (none|read|write|admin) from the same grants engine
// that backs GET /access/site/:slug — direct grants, group grants, the site
// default, and owner=admin all included. The gateway compares it to its required
// floor (read). Authenticated with the shared internal secret (same as /owner).
router.get('/internal/projects/:slug/access/:sub', requireInternalSecret, requireInClusterCaller, async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '');
  const sub = String(req.params.sub || '');
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(slug)) {
    res.status(400).json({ error: 'invalid slug' });
    return;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) {
    res.status(400).json({ error: 'invalid sub' });
    return;
  }
  try {
    const project = await getProjectBySlug(slug);
    if (!project) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const perm = await effectiveSitePerm(project, sub);
    res.json({ slug: project.slug, sub, site_perm: perm });
  } catch (err: any) {
    console.error('[internal/access] error for', slug, err?.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /internal/projects/:slug/pin
//
// Called by the project repo's Build workflow after it has pushed a new
// immutable image tag to the in-cluster registry. The portal pins the
// project's k8s/deployment.yaml to that tag by editing the file via
// Gitea's Contents API as cvportal (a site admin → bypasses branch
// protection that gates outside contributors via PR).
//
// Auth model:
//
//   1. Bearer token (`CV_PIN_TOKEN`) — the workflow sends a per-project
//      secret minted at project-create time. The portal looks the project
//      up by `sha256(token)`. Without this, ANY runner in cv-gitea-runners
//      (one StatefulSet shared across all projects) could pin ANY project's
//      deployment by guessing the slug; the network-origin guard alone
//      is not authentication.
//   2. URL slug must agree with the token's owning project. Defence in
//      depth: a hypothetical token-rebind regression would still be caught.
//   3. requireInClusterCaller stays as the outer network-origin guard —
//      keeps external callers from even reaching the auth check.
//   4. The supplied `sha` must equal the current head of `main` on the
//      target repo (anti-misfire — keeps a stale workflow run from pinning
//      a tag that no longer matches main).
router.post('/internal/projects/:slug/pin', requireInClusterCaller, async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '');
  const tag = String(req.body?.tag || '');
  const sha = typeof req.body?.sha === 'string' ? req.body.sha : '';

  if (!/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: 'invalid slug' });
    return;
  }
  if (!/^[0-9]{14}$/.test(tag)) {
    res.status(400).json({ error: 'tag must be YYYYMMDDHHMMSS' });
    return;
  }
  // `sha` is REQUIRED: it's the anti-misfire guard (must equal current head of
  // main). Making it optional let a caller skip the check entirely by omitting
  // the field, enabling a stale workflow run to force a rollback. Demand it.
  if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
    res.status(400).json({ error: 'sha is required and must be 7-40 hex chars (head of main)' });
    return;
  }

  // Bearer auth. Strict header parse; no whitespace tolerance beyond the
  // single space mandated by RFC 6750.
  const auth = req.headers['authorization'];
  const m = typeof auth === 'string' ? auth.match(/^Bearer\s+([A-Za-z0-9_\-]+)$/) : null;
  if (!m) {
    res.status(401).json({ error: 'missing or malformed Authorization header' });
    return;
  }
  const submittedHash = hashPinToken(m[1]);

  try {
    const project = await getProjectByPinTokenHash(submittedHash);
    // 401 (not 403) so the caller can't distinguish "wrong token" from
    // "right token, wrong slug" — same response shape avoids enumeration.
    if (!project || !pinTokenHashMatches(project.pin_token_hash || '', submittedHash)) {
      res.status(401).json({ error: 'invalid pin token' });
      return;
    }
    // Defence in depth: the slug in the URL must match the project the
    // token belongs to. A token rebind regression would otherwise let
    // project A's workflow pin project B by lying about the URL slug.
    if (project.slug !== slug) {
      res.status(401).json({ error: 'invalid pin token' });
      return;
    }
    if (!project.gitea_repo) {
      res.status(409).json({ error: 'project has no gitea repo' });
      return;
    }
    const [owner, repo] = project.gitea_repo.split('/');

    // Anti-misfire: caller-claimed sha must equal current head of main.
    // We don't trust the caller blindly — this prevents a stray runner
    // from pinning to a tag that wasn't actually just built for this
    // project's current commit.
    const head = await getBranchHead({ owner, repo, branch: 'main' });
    if (!head) {
      res.status(409).json({ error: 'main branch not found' });
      return;
    }
    // Accept either full or short sha (>=7 hex chars). Compare by prefix from
    // the live head — head.sha is always full-length from Gitea. `sha` is
    // already validated as 7-40 hex above, so the only effective check here is
    // the head-of-main prefix match.
    if (!head.sha.startsWith(sha.toLowerCase())) {
      res.status(409).json({
        error: 'sha mismatch: not the head of main',
        head_sha: head.sha,
        provided_sha: sha,
      });
      return;
    }

    // Deploy gate: optionally require that the required scan/CI status check
    // passed for head-of-main before pinning. A tenant controls their own repo
    // (and therefore their own CV_PIN_TOKEN), so without this they could pin an
    // arbitrary, never-scanned image into their namespace, bypassing the scan
    // gate that branch-protected merges enforce. Opt-in (default off) because
    // the required check's context name is deploy-specific; when
    // REQUIRED_PIN_STATUS_CONTEXT is set we demand that context be 'success'.
    const requiredContext = (process.env.REQUIRED_PIN_STATUS_CONTEXT || '').trim();
    if (requiredContext) {
      const status = await getCommitStatus({ owner, repo, sha: head.sha });
      const check = status?.checks.find((c) => c.context === requiredContext);
      if (!check || check.state !== 'success') {
        res.status(409).json({
          error: `required status check "${requiredContext}" did not pass for head of main`,
          head_sha: head.sha,
          check_state: check?.state || 'missing',
        });
        return;
      }
    }

    const path = 'k8s/deployment.yaml';
    const file = await getFile({ owner, repo, path });
    if (!file) {
      res.status(404).json({ error: 'k8s/deployment.yaml not found in repo' });
      return;
    }

    // Line-anchored rewrite of every `image: registry.cv-registry.../<owner>/<slug>:<tag>`
    // line. Greedy `.*` plus an end-of-line tag pattern back-tracks to the
    // tag's separator colon (not the `:5000` in the host). The `g` flag pins
    // ALL container image lines: a multi-capability project runs several
    // containers from the same image, so they must all move to the new tag
    // together. The postgres StatefulSet's `image: postgres:16-alpine` doesn't
    // match the registry host, so it's left alone.
    const updated = file.content.replace(
      /^(\s*image:\s+registry\.cv-registry.*):[A-Za-z0-9_.-]+$/mg,
      `$1:${tag}`
    );

    if (updated === file.content) {
      res.json({
        ok: true,
        changed: false,
        reason: 'already pinned to this tag, or no matching image: line',
        tag,
      });
      return;
    }

    await upsertRepoFile({
      owner, repo, path,
      content: updated,
      sha: file.sha,
      message: `chore: pin image to ${tag} [skip ci]`,
    });

    res.json({ ok: true, changed: true, tag, slug });
  } catch (err: any) {
    // Keep raw upstream (Gitea) error detail in the server log only; don't
    // reflect internal repo/branch state back to the caller.
    console.error('[internal/pin] error for', slug, err?.message);
    res.status(500).json({ error: 'internal error' });
  }
});

export default router;
