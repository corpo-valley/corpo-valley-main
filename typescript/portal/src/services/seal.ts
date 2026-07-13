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
//   - The controller's cert is the RSA key wrapper. We fetch it through the
//     Kubernetes API server's service-proxy (authenticated + TLS-verified) and
//     cache it, refetching on a TTL so controller key rotation propagates.

import * as crypto from 'crypto';
import { k8sEnabled, k8sServiceProxyGet } from './k8s';

const CONTROLLER_URL =
  process.env.SEALED_SECRETS_CONTROLLER_URL ||
  'http://sealed-secrets-controller.kube-system.svc.cluster.local:8080';

// Re-fetched on a TTL because sealed-secrets rotates keys (default 30d). On
// rotation, new SealedSecrets must use the latest key so the controller's
// active key set can decrypt them.
const CERT_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedCert: { pem: string; fetchedAt: number; sha256: string } | null = null;

// The controller's cert is fetched through the API server's service-proxy (see
// fetchCert): an authenticated, TLS-verified channel. That removes the
// in-cluster MITM the old static SPKI pin (SEALED_SECRETS_CERT_SHA256) defended
// against, so the pin — and its every-30-days manual rotation — is gone.
if ((process.env.SEALED_SECRETS_CERT_SHA256 || '').trim()) {
  console.warn(
    '[seal] SEALED_SECRETS_CERT_SHA256 is set but IGNORED: the portal now fetches the ' +
    'sealed-secrets cert over the authenticated Kubernetes API server, so the manual SPKI ' +
    'pin is neither needed nor maintained. Remove it from your values/env.'
  );
}

// Parse the controller Service coordinates out of CONTROLLER_URL so we can
// address it through the API server's service-proxy subresource. Defaults match
// the stock sealed-secrets install (kube-system / :8080 / http).
function controllerServiceRef(): { namespace: string; service: string; scheme: 'http' | 'https'; port: string } {
  const u = new URL(CONTROLLER_URL);
  const [service, namespace] = u.hostname.split('.');
  return {
    service: service || 'sealed-secrets-controller',
    namespace: namespace || 'kube-system',
    scheme: u.protocol === 'https:' ? 'https' : 'http',
    port: u.port || '8080',
  };
}

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
  // Preferred path: fetch cert.pem through the API server's service-proxy. The
  // channel is TLS-verified + SA-authenticated (this is exactly what
  // `kubeseal --fetch-cert` does), so an in-cluster MITM can't swap the
  // controller's public key — no static pin required.
  if (k8sEnabled()) {
    const ref = controllerServiceRef();
    const pem = await k8sServiceProxyGet({ ...ref, path: '/v1/cert.pem' })
      .catch((err) => { throw new SealError('sealed-secrets cert fetch via k8s API proxy failed', err); });
    if (!pem.includes('BEGIN CERTIFICATE')) {
      throw new SealError('sealed-secrets controller returned non-PEM cert (via API proxy)');
    }
    return pem;
  }

  // Fallback (local dev only): no in-cluster ServiceAccount token, so reach the
  // controller directly over plaintext HTTP. This is UNAUTHENTICATED, so we
  // refuse it in production — a prod portal always has the SA mount.
  if (process.env.NODE_ENV === 'production') {
    throw new SealError(
      'cannot fetch sealed-secrets cert: no in-cluster ServiceAccount token to reach the ' +
      'Kubernetes API server, and the unauthenticated HTTP fallback is refused in production.'
    );
  }
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

  const pem = await fetchCert();
  const sha = fingerprint(pem);

  // A changed fingerprint across refetches is a legitimate ~30-day controller
  // key rotation now that the fetch channel is authenticated — accept it and
  // log, so rotation propagates on the next TTL with no operator action. (The
  // old code refused this to guard the unauthenticated HTTP fetch; that guard
  // is obsolete once we read through the API server.)
  if (cachedCert && cachedCert.sha256 !== sha) {
    console.warn(
      `[seal] sealed-secrets controller cert rotated (SPKI sha256 ${cachedCert.sha256} -> ${sha}); ` +
      'sealing new secrets against the new active key.'
    );
  }

  cachedCert = { pem, fetchedAt: now, sha256: sha };
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
