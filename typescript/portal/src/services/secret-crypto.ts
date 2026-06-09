// Authenticated encryption for secrets the portal must persist in its own
// Postgres (currently per-project database passwords). Storing those in
// cleartext undoes the SealedSecrets ceremony: a DB backup leak or a read-only
// SQLi would hand over every project's live DB credential. We wrap them with
// AES-256-GCM under a key that only the portal pod holds (PORTAL_SECRET_KEY,
// a mounted Kubernetes Secret), so the ciphertext at rest is useless without it.
//
// Stored form: `enc:v1:<kid>:` + base64(iv[12] || tag[16] || ciphertext), where
// <kid> identifies which key encrypted it. This makes KEY rotation real (not
// just the scheme version): set PORTAL_SECRET_KEY to the new key and
// PORTAL_SECRET_KEY_OLD to the previous one, restart, and the startup migration
// re-encrypts everything under the new key; once done, drop PORTAL_SECRET_KEY_OLD.

import * as crypto from 'crypto';

const PREFIX = 'enc:v1:';

interface KeyEntry { kid: string; key: Buffer; }

function parseKey(raw: string): Buffer | null {
  const t = raw.trim();
  if (!t) return null;
  const key = Buffer.from(t, 'base64');
  if (key.length !== 32) {
    throw new Error('PORTAL_SECRET_KEY* must be base64-encoded 32 bytes (AES-256).');
  }
  return key;
}

function kidOf(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

let cached: { current: KeyEntry | null; byKid: Map<string, Buffer> } | null = null;

function keys(): { current: KeyEntry | null; byKid: Map<string, Buffer> } {
  if (cached) return cached;
  const byKid = new Map<string, Buffer>();
  let current: KeyEntry | null = null;

  const cur = parseKey(process.env.PORTAL_SECRET_KEY || '');
  if (cur) {
    const kid = kidOf(cur);
    current = { kid, key: cur };
    byKid.set(kid, cur);
  }
  // Optional previous keys for rotation (comma-separated base64 values).
  for (const raw of (process.env.PORTAL_SECRET_KEY_OLD || '').split(',')) {
    const k = parseKey(raw);
    if (k) byKid.set(kidOf(k), k);
  }
  cached = { current, byKid };
  return cached;
}

function currentKey(): KeyEntry {
  const { current } = keys();
  if (!current) throw new Error('PORTAL_SECRET_KEY is not set — cannot encrypt/decrypt persisted secrets.');
  return current;
}

// True iff PORTAL_SECRET_KEY is configured.
export function secretCryptoAvailable(): boolean {
  try {
    currentKey();
    return true;
  } catch {
    return false;
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const { kid, key } = currentKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${kid}:` + Buffer.concat([iv, tag, ct]).toString('base64');
}

// Split a stored value into { kid, payload }. Handles the current
// `enc:v1:<kid>:<b64>` form and the legacy `enc:v1:<b64>` form (no kid).
function parseStored(stored: string): { kid: string | null; payload: string } {
  const rest = stored.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  // base64 never contains ':', so a colon means the segment before it is a kid.
  if (colon !== -1) return { kid: rest.slice(0, colon), payload: rest.slice(colon + 1) };
  return { kid: null, payload: rest };
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored; // legacy cleartext
  const { kid, payload } = parseStored(stored);
  const { byKid } = keys();
  const key = kid ? byKid.get(kid) : currentKey().key;
  if (!key) throw new Error(`no key available for kid "${kid}" — set PORTAL_SECRET_KEY_OLD to the retired key to decrypt.`);
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// True iff a stored value should be re-encrypted under the current key: either
// it's legacy cleartext, or it's ciphertext under a non-current kid. Drives the
// startup re-encryption migration so rotation actually re-keys the data.
export function needsReencrypt(stored: string): boolean {
  if (!isEncrypted(stored)) return true;
  const { kid } = parseStored(stored);
  return kid !== currentKey().kid;
}
