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
// By default every object is scoped to its owner: keys are prefixed with the
// caller's user id (`<userId>/<name>`), so a caller only ever lists, reads and
// deletes their own files. The platform flips CV_SHARED=true when the project
// owner ticks "data is shared across users", which drops the prefix and turns
// the bucket into one shared view (writes still record the author in the key's
// metadata is not used here; the key itself carries no owner when shared). The
// secure posture — per-user isolation — is the default; sharing is the explicit
// opt-in.
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

// When true, the bucket is one shared view: objects are stored without an
// owner prefix and every caller lists/reads the whole bucket. When false
// (default), each caller is confined to their own `<userId>/` prefix. Set by
// the platform from the project's "shared across users" setting — don't read it
// from request input.
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

// The caller's key prefix. Per-user isolation is the default; SHARED drops it
// so all objects live flat in the bucket. The prefix is derived from the
// resolved identity (req.userId), never from request input, so a caller can't
// reach into another user's space by crafting an object name.
function prefixFor(userId) {
  return SHARED ? '' : `${userId}/`;
}

// Sanitize a user-supplied object name. We reject path traversal, leading
// slashes and anything outside a conservative charset, so the name can only
// ever name a file inside the caller's own prefix — never climb out of it.
// Returns the safe name, or null if it must be refused.
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

const files = express.Router();
// Identity + permission gate. `read` is the floor — the edge already blocks
// anyone below it, so this mostly matters for local runs without the headers.
files.use(requirePerm('read'));

// List objects the caller is allowed to see. The prefix decides scope: per-user
// callers only ever list under their own `<userId>/`; SHARED lists the bucket.
// Keys are returned with the prefix stripped so the client sees plain names.
files.get('/', async (req, res) => {
  const prefix = prefixFor(req.userId);
  try {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    }));
    const objects = (out.Contents || [])
      // A shared bucket may also hold per-user-prefixed keys from when sharing
      // was off; in SHARED mode we still surface everything under the (empty)
      // prefix, so just strip whatever prefix applies.
      .map((o) => ({
        key: prefix && o.Key.startsWith(prefix) ? o.Key.slice(prefix.length) : o.Key,
        size: o.Size,
        lastModified: o.LastModified,
      }));
    res.json({ shared: SHARED, files: objects });
  } catch (err) {
    console.error('GET /files failed:', err.message);
    res.status(500).json({ error: 'storage error' });
  }
});

// Presign a direct upload. Requires the `write` class. The browser POSTs the
// desired name, gets back a short-lived PUT URL, and uploads straight to
// Garage — the bytes never pass through this service. The key is always built
// from the caller's prefix + a sanitized name, so a caller can only ever write
// inside their own space.
files.post('/presign', requirePerm('write'), async (req, res) => {
  const name = safeName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: 'invalid or missing name' });
    return;
  }
  const contentType = typeof req.body?.contentType === 'string'
    ? req.body.contentType.slice(0, 255)
    : undefined;
  const key = `${prefixFor(req.userId)}${name}`;
  try {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: PRESIGN_EXPIRY_S }
    );
    res.json({ url, key: name, method: 'PUT', expiresIn: PRESIGN_EXPIRY_S });
  } catch (err) {
    console.error('POST /files/presign failed:', err.message);
    res.status(500).json({ error: 'storage error' });
  }
});

// Presign a download for one of the caller's objects and 302 to it, so a plain
// <a href> or fetch lands on the bytes. We HEAD first so a missing object is a
// clean 404 rather than a redirect to a URL that will 404 at Garage. The key is
// scoped to the caller's prefix; the name is sanitized so it can't escape it.
files.get('/:name', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) {
    res.status(400).json({ error: 'invalid name' });
    return;
  }
  const key = `${prefixFor(req.userId)}${name}`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
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
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: PRESIGN_EXPIRY_S }
    );
    res.redirect(302, url);
  } catch (err) {
    console.error('GET /files/:name failed:', err.message);
    res.status(500).json({ error: 'storage error' });
  }
});

// Delete an object. `write` callers can only delete files under their own
// prefix; `admin` callers (app-level moderators) may delete anyone's — but only
// when the bucket is SHARED, where keys aren't owner-prefixed. With per-user
// isolation there is no "anyone else" to reach, so admin and write behave the
// same: both are confined to the caller's own prefix.
files.delete('/:name', requirePerm('write'), async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) {
    res.status(400).json({ error: 'invalid name' });
    return;
  }
  const key = `${prefixFor(req.userId)}${name}`;
  try {
    // HEAD first so we can report whether anything was actually removed —
    // S3 DELETE is idempotent and 204s even for a missing key.
    let existed = true;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
        existed = false;
      } else {
        throw err;
      }
    }
    if (existed) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
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
