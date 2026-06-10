// Sealed-secrets encryption — pure-Node implementation of the controller's
// hybrid scheme so the portal can mint SealedSecrets without shelling out to
// a `kubeseal` binary.
//
// Format (matches Bitnami sealed-secrets):
//   sealed = base64( BE16(len(RSA-OAEP(sessionKey, label))) ||
//                    RSA-OAEP(sessionKey, label) ||
//                    AES-256-GCM(plaintext, key=sessionKey, nonce=12 zero
//                                                              bytes) ||
//                    16-byte GCM auth tag )
//
//   - sessionKey: 32 random bytes per call (so the zero nonce is safe — a
//     repeated nonce + repeated key would be catastrophic).
//   - OAEP label is `<namespace>/<name>` for the default "strict" scope; that
//     binds the ciphertext to a specific destination Secret, so a stolen
//     SealedSecret can't be replayed elsewhere.
//   - The controller's cert is the RSA key wrapper. We fetch it from the
//     controller's HTTP endpoint at startup and cache it.

import * as crypto from 'crypto';

const CONTROLLER_URL =
  process.env.SEALED_SECRETS_CONTROLLER_URL ||
  'http://sealed-secrets-controller.kube-system.svc.cluster.local:8080';

// Re-fetched on a TTL because sealed-secrets rotates keys (default 30d). On
// rotation, new SealedSecrets must use the latest key so the controller's
// active key set can decrypt them.
const CERT_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedCert: { pem: string; fetchedAt: number; sha256: string } | null = null;

// SHA-256 fingerprint pin over the cert's SubjectPublicKeyInfo (NOT the PEM
// text — see fingerprint()). Every fetched cert must hash to this value or we
// refuse it, defeating an in-cluster MITM that swaps the controller's public
// key. Rotation = operator updates this env + restarts the pod.
const EXPECTED_CERT_SHA256 = (process.env.SEALED_SECRETS_CERT_SHA256 || '').trim().toLowerCase();

// Pinning is MANDATORY by default. Trust-on-first-use (remember the first cert
// seen this process) is a real downgrade — an attacker present before the first
// fetch transparently wins — so it's only allowed when the operator explicitly
// opts in via SEALED_SECRETS_ALLOW_TOFU=true. With neither the pin nor the TOFU
// flag set, we refuse to seal rather than trust an unauthenticated key.
const ALLOW_TOFU = process.env.SEALED_SECRETS_ALLOW_TOFU === 'true';

export class SealError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'SealError';
  }
}

export function sealEnabled(): boolean {
  return true;
}

async function fetchCert(): Promise<string> {
  // Bounded timeout: a hung/black-holed controller must fail fast rather than
  // stall every seal operation (and the request handlers awaiting them)
  // indefinitely — global fetch (undici) has no default timeout.
  const res = await fetch(`${CONTROLLER_URL}/v1/cert.pem`, { signal: AbortSignal.timeout(5000) })
    .catch((err) => { throw new SealError('sealed-secrets controller cert fetch failed or timed out', err); });
  if (!res.ok) {
    throw new SealError(`sealed-secrets controller returned ${res.status} fetching cert`);
  }
  const pem = await res.text();
  if (!pem.includes('BEGIN CERTIFICATE')) {
    throw new SealError('sealed-secrets controller returned non-PEM cert');
  }
  return pem;
}

// Fingerprint the cert's SubjectPublicKeyInfo (the DER-encoded public key),
// NOT the PEM text. The PEM bytes change under benign re-encoding (line wrap,
// trailing newline, base64 chunking) even when the key is identical, which
// would make a text-hash pin spuriously fail. Hashing the SPKI makes the pin a
// property of the key itself — and matches `openssl x509 -pubkey -noout | ...`.
function fingerprint(pem: string): string {
  const spki = new crypto.X509Certificate(pem).publicKey.export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(spki).digest('hex');
}

export async function getCert(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedCert && now - cachedCert.fetchedAt < CERT_TTL_MS) {
    return cachedCert.pem;
  }

  // Fail closed: without an explicit pin, refuse to seal unless TOFU is opted in.
  // TOFU trusts the first cert seen over a plaintext in-cluster HTTP channel, so
  // it is a dev-only convenience — never honour it in production. Production must
  // set an explicit SPKI pin.
  if (!EXPECTED_CERT_SHA256) {
    if (process.env.NODE_ENV === 'production') {
      throw new SealError(
        'sealed-secrets cert is not pinned and trust-on-first-use is not permitted in production: ' +
        'set SEALED_SECRETS_CERT_SHA256 to the expected SPKI sha256.'
      );
    }
    if (!ALLOW_TOFU) {
      throw new SealError(
        'sealed-secrets cert is not pinned: set SEALED_SECRETS_CERT_SHA256 to the ' +
        'expected SPKI sha256, or set SEALED_SECRETS_ALLOW_TOFU=true (non-production only) ' +
        'to explicitly accept trust-on-first-use. Refusing to seal against an unauthenticated key.'
      );
    }
  }

  const pem = await fetchCert();
  const sha = fingerprint(pem);

  // Explicit pin: a configured fingerprint must match the fetched cert.
  // This protects against an in-cluster MITM swapping the controller's
  // pubkey. Operator updates this env when sealed-secrets rotates keys.
  if (EXPECTED_CERT_SHA256 && sha !== EXPECTED_CERT_SHA256) {
    throw new SealError(
      `sealed-secrets cert fingerprint mismatch: expected ${EXPECTED_CERT_SHA256}, got ${sha}. ` +
      `Refusing to seal — either the controller's active key has rotated (update SEALED_SECRETS_CERT_SHA256 in the portal env) or the fetch was MITM'd.`
    );
  }

  // Pin-on-first-use fallback: when no explicit pin is configured, we
  // remember the first fingerprint we saw and refuse silent mid-process
  // rotation. An attacker who arrives AFTER the portal has cached a
  // benign cert can't transparently swap in their own. The cache TTL
  // means a legitimate rotation forces a refetch — at which point a
  // mismatch produces a loud failure that the operator must clear by
  // restarting the portal (and ideally setting an explicit pin).
  if (!EXPECTED_CERT_SHA256 && cachedCert && cachedCert.sha256 !== sha) {
    throw new SealError(
      `sealed-secrets cert fingerprint changed mid-process: was ${cachedCert.sha256}, now ${sha}. ` +
      `Refusing the new cert — restart the portal after confirming the controller rotated its key intentionally.`
    );
  }

  cachedCert = { pem, fetchedAt: now, sha256: sha };
  if (!EXPECTED_CERT_SHA256) {
    console.warn(
      `[seal] SEALED_SECRETS_ALLOW_TOFU is set — trusting sealed-secrets cert on first use (SPKI sha256=${sha}). ` +
      `Set SEALED_SECRETS_CERT_SHA256=${sha} for explicit pinning across restarts and remove the TOFU flag.`
    );
  }
  return pem;
}

export interface SealOpts {
  namespace: string;
  name: string;
  value: string | Buffer;
}

// Encrypt one value for a (namespace, name) destination Secret. Returns the
// base64 string suitable for `spec.encryptedData[<key>]`.
export async function sealValue(opts: SealOpts): Promise<string> {
  const certPem = await getCert();
  const plaintext = Buffer.isBuffer(opts.value) ? opts.value : Buffer.from(opts.value, 'utf8');
  const label = Buffer.from(`${opts.namespace}/${opts.name}`, 'utf8');

  // 32 fresh bytes; AES-256-GCM with a 12-byte zero IV is safe so long as the
  // key is unique per call.
  const sessionKey = crypto.randomBytes(32);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, Buffer.alloc(12));
  const aesCipher = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const aesTag = cipher.getAuthTag();

  const rsaCipher = crypto.publicEncrypt(
    {
      key: certPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      oaepLabel: label,
    },
    sessionKey
  );

  const rsaLen = Buffer.alloc(2);
  rsaLen.writeUInt16BE(rsaCipher.length, 0);
  return Buffer.concat([rsaLen, rsaCipher, aesCipher, aesTag]).toString('base64');
}

export interface BuildSealedSecretOpts {
  namespace: string;
  name: string;
  // Plain KEY=VALUE pairs; values are sealed individually before write.
  data: Record<string, string>;
}

// Build a complete SealedSecret YAML for committing to the user's repo.
export async function buildSealedSecretYaml(opts: BuildSealedSecretOpts): Promise<string> {
  const encryptedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.data)) {
    encryptedData[k] = await sealValue({ namespace: opts.namespace, name: opts.name, value: v });
  }

  const dataLines = Object.entries(encryptedData)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join('\n');

  // The template metadata is copied onto the unsealed Secret by the
  // controller, so it must carry the same name + namespace.
  return [
    'apiVersion: bitnami.com/v1alpha1',
    'kind: SealedSecret',
    'metadata:',
    `  name: ${opts.name}`,
    `  namespace: ${opts.namespace}`,
    'spec:',
    '  encryptedData:',
    dataLines,
    '  template:',
    '    metadata:',
    `      name: ${opts.name}`,
    `      namespace: ${opts.namespace}`,
    '    type: Opaque',
    '',
  ].join('\n');
}
