// Storage capability — an S3-backed file API, mounted at `/files`.
//
// This is the "blob/file storage" capability. It puts a thin, presigned-URL
// front door on the project's object store so the browser can upload and
// download files directly, while this service stays the gatekeeper for who may
// see and touch what.
//
// ── Authorization is baked in ────────────────────────────────────────────
// Every request that reaches this container has already passed the platform's
// edge access gate: anonymous visitors and members without `read` on this
// project never get here. The request carries the trusted identity headers
// (X-CV-User-Id / X-CV-User-Email / X-CV-Perm — see ACCESS.md); the shared
// identity helper reads them (falling back to the legacy Kratos-cookie
// re-validation when absent) and exposes the caller's permission class:
//
//   read   can view  → GET routes (list, download URL)
//   write  can create/update/delete THEIR OWN files → mutating routes
//   admin  app-level moderator → may delete ANYONE's objects here
//
// ── Ownership is always recorded ──────────────────────────────────────────
// Every object is stored under its author's prefix — `<userId>/<name>` —
// ALWAYS, in both modes. That is what lets `write` mean "your own files" and
// `admin` mean "anyone's", exactly like the database capability keeps an
// owner_id per row. CV_SHARED only widens what reads return; it never widens
// who may mutate whose data:
//
//   CV_SHARED=false (default): a caller only ever lists/reads/writes/deletes
//     under their own `<userId>/` prefix. Full per-user isolation.
//   CV_SHARED=true: reads + lists span EVERY author's objects (the shared
//     view), and the listing carries each object's `owner` so callers can
//     address a specific one. But writes still land only in the caller's own
//     prefix (no overwriting a peer's file), and deleting someone else's
//     object requires `admin`.
//
// The platform injects the S3 connection details from the per-project `garage`
// Secret via the Deployment's env (endpoint, credentials, bucket). No
// connection details live here.

const express = require('express');
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { requirePerm } = require('../lib/identity');

// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage -- CSRF is handled by csrfGuard below (Sec-Fetch-Site same-origin check); the csurf package the rule looks for is deprecated.
const app = express();
const PORT = process.env.PORT || 7000;

// When true, reads + lists span every author's objects (the shared view). It
// does NOT change who may write or delete what — writes are always confined to
// the caller's own prefix and cross-author deletes require admin. Set by the
// platform from the project's "shared across users" setting — never read from
// request input.
const SHARED = process.env.CV_SHARED === 'true';

// The platform populates these from the per-project `garage` Secret via the
// Deployment's env. Garage speaks the S3 API; it wants path-style addressing
// and a fixed region label. No connection details are hardcoded here.
const BUCKET = process.env.S3_BUCKET || 'app';
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'garage',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

// Presigned URLs are short-lived: the browser gets one, uses it immediately to
// PUT/GET a single object, and it expires before it can leak into history or a
// referer in any useful way.
const PRESIGN_EXPIRY_S = 300;

app.use(express.json({ limit: '64kb' }));

// CSRF protection. The edge authenticates via an ambient Kratos session
// cookie, so a malicious site could try to drive state-changing requests with
// the victim's cookie attached. We reject any unsafe request whose
// Sec-Fetch-Site marks it cross-site; combined with the JSON-only body parser
// (which a cross-site HTML form can't satisfy), this is the modern equivalent
// of the deprecated csurf middleware.
function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const site = req.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: 'cross-site request blocked' });
    return;
  }
  next();
}
app.use(csrfGuard);

// Sanitize a user-supplied object name (the part within an owner's space).
// Rejects path traversal, leading slashes and anything outside a conservative
// charset, so a name can only ever address a flat file inside one prefix —
// never climb out of it. Returns the safe name, or null if it must be refused.
function safeName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim();
  if (!name || name.length > 256) return null;
  // No absolute paths, no traversal, no nested directories — a flat, safe name.
  if (name.startsWith('/') || name.includes('..') || name.includes('/')) return null;
  // Restrict to a safe charset: letters, digits, dot, dash, underscore.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return name;
}

// Sanitize an owner segment (a caller's identity id, e.g. a Kratos UUID). Same
// conservative rules as a name — it's a single flat key segment, never a path.
function safeOwner(input) {
  if (typeof input !== 'string') return null;
  const owner = input.trim();
  if (!owner || owner.length > 256) return null;
  if (owner.startsWith('/') || owner.includes('..') || owner.includes('/')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(owner)) return null;
  return owner;
}

// Resolve which object a read/delete request targets, and whose it is. The
// owner is taken from the trusted identity by default; in SHARED mode a caller
// may name another owner via ?owner=<id> (used to reach objects the shared
// listing surfaced). In per-user mode the owner is ALWAYS the caller — any
// ?owner is ignored — so there is no way to address another space. Returns
// { key, crossOwner } or null if the inputs are invalid.
function resolveTarget(req) {
  const name = safeName(req.params.name);
  if (!name) return null;
  let owner = req.userId;
  if (SHARED && typeof req.query.owner === 'string' && req.query.owner) {
    const o = safeOwner(req.query.owner);
    if (!o) return null;
    owner = o;
  }
  return { key: `${owner}/${name}`, crossOwner: owner !== req.userId };
}

const files = express.Router();
// Identity + permission gate. `read` is the floor — the edge already blocks
// anyone below it, so this mostly matters for local runs without the headers.
files.use(requirePerm('read'));

// List objects the caller may see. Per-user callers list only their own
// `<userId>/` prefix; SHARED lists the whole bucket. Each entry carries its
// `owner` and bare `name` (and the full `key`) so a SHARED caller can address a
// specific peer's object on a later GET/DELETE via ?owner=.
files.get('/', async (req, res) => {
  const prefix = SHARED ? '' : `${req.userId}/`;
  try {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    }));
    const objects = (out.Contents || []).map((o) => {
      const slash = o.Key.indexOf('/');
      const owner = slash >= 0 ? o.Key.slice(0, slash) : '';
      const name = slash >= 0 ? o.Key.slice(slash + 1) : o.Key;
      return { key: o.Key, owner, name, size: o.Size, lastModified: o.LastModified };
    });
    res.json({ shared: SHARED, files: objects });
  } catch (err) {
    console.error('GET /files failed:', err.message);
    res.status(500).json({ error: 'storage error' });
  }
});

// Presign a direct upload. Requires the `write` class. The key is ALWAYS built
// from the caller's OWN prefix + a sanitized name — even in SHARED mode — so a
// caller can only ever create or replace files inside their own space and can
// never overwrite a peer's object.
files.post('/presign', requirePerm('write'), async (req, res) => {
  const name = safeName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: 'invalid or missing name' });
    return;
  }
  const contentType = typeof req.body?.contentType === 'string'
    ? req.body.contentType.slice(0, 255)
    : undefined;
  const key = `${req.userId}/${name}`;
  try {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: PRESIGN_EXPIRY_S }
    );
    res.json({ url, key, name, method: 'PUT', expiresIn: PRESIGN_EXPIRY_S });
  } catch (err) {
    console.error('POST /files/presign failed:', err.message);
    res.status(500).json({ error: 'storage error' });
  }
});

// Presign a download and 302 to it. A per-user caller can only reach their own
// objects; a SHARED caller may reach any author's (reads span the shared view)
// by passing ?owner=<id>. We HEAD first so a missing object is a clean 404.
files.get('/:name', async (req, res) => {
  const target = resolveTarget(req);
  if (!target) {
    res.status(400).json({ error: 'invalid name or owner' });
    return;
  }
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: target.key }));
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      res.status(404).json({ error: 'not found' });
      return;
    }
    console.error('GET /files/:name head failed:', err.message);
    res.status(500).json({ error: 'storage error' });
    return;
  }
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: target.key }),
      { expiresIn: PRESIGN_EXPIRY_S }
    );
    res.redirect(302, url);
  } catch (err) {
    console.error('GET /files/:name failed:', err.message);
    res.status(500).json({ error: 'storage error' });
  }
});

// Delete an object. `write` callers may delete only their OWN files. Deleting
// another author's object (only addressable in SHARED mode via ?owner=) is a
// moderator action and requires `admin` — mirroring the database capability,
// where cross-owner row deletes are admin-only regardless of CV_SHARED.
files.delete('/:name', requirePerm('write'), async (req, res) => {
  const target = resolveTarget(req);
  if (!target) {
    res.status(400).json({ error: 'invalid name or owner' });
    return;
  }
  if (target.crossOwner && req.userPerm !== 'admin') {
    res.status(403).json({ error: 'deleting another user\'s file requires admin' });
    return;
  }
  try {
    // HEAD first so we can report whether anything was actually removed —
    // S3 DELETE is idempotent and 204s even for a missing key.
    let existed = true;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: target.key }));
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
        existed = false;
      } else {
        throw err;
      }
    }
    if (existed) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: target.key }));
    }
    res.json({ deleted: existed });
  } catch (err) {
    console.error('DELETE /files/:name failed:', err.message);
    res.status(500).json({ error: 'storage error' });
  }
});

app.use('/files', files);

// Liveness: process up, no S3. Readiness: 200 OK — like the database module's
// liveness, we keep this simple and don't hard-fail readiness on a transient
// object-store blip, so a brief Garage hiccup doesn't pull every pod out of
// rotation.
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`storage api listening on :${PORT} (shared=${SHARED}, bucket=${BUCKET})`));
