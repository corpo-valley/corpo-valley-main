// Reserved usernames.
//
// The portal addresses platform-admin tooling by username: `cvportal` is a
// Gitea *site admin* whose Basic-auth, when POSTed to `/users/<name>/tokens`,
// mints a PAT on whatever `<name>` is passed. So if a tenant identity could
// claim `preferred_username=cvportal`, the per-project "mint CLI token" flow
// would hand that tenant a site-admin token — full cross-tenant repo write.
//
// We therefore refuse to let any human-facing identity ingress (self-service
// after-registration hook, admin user create/update) carry one of these
// names, and — as the load-bearing backstop — refuse to mint a Gitea token
// for one regardless of caller (see services/gitea.ts:mintUserCliToken).

const GITEA_ADMIN_USER = (process.env.GITEA_ADMIN_USER || 'cvportal').trim().toLowerCase();

const RESERVED_USERNAMES = new Set<string>([
  GITEA_ADMIN_USER,
  'cvportal', 'root', 'admin', 'administrator', 'gitea', 'argocd',
  'kratos', 'hydra', 'keto', 'ory', 'portal', 'system', 'sys',
  'kubernetes', 'kube', 'sealed-secrets', 'registry',
]);

// Kratos identity-schema constraint on preferred_username: ^[a-zA-Z0-9._-]+$,
// length 1..64. Mirror it here so portal-side ingress can reject malformed
// usernames before they reach Gitea / k8s sinks.
const USERNAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function isValidUsername(username: unknown): username is string {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

export function isReservedUsername(username: unknown): boolean {
  if (typeof username !== 'string') return false;
  const u = username.trim().toLowerCase();
  if (!u) return false;
  if (RESERVED_USERNAMES.has(u)) return true;
  // The platform pairs each human with a `<username>.bot` companion created via
  // the Kratos admin API (which skips these guards). Letting a *human* claim a
  // `*.bot` name would let them impersonate a bot identity, which the
  // platform treats as machine-owned. Bot creation goes through the admin
  // path, so this
  // block never interferes with legitimate bot provisioning.
  if (u.endsWith('.bot')) return true;
  return false;
}

export class ReservedUsernameError extends Error {
  constructor(public readonly username: string) {
    super(`username "${username}" is not allowed`);
    this.name = 'ReservedUsernameError';
  }
}

// Throws ReservedUsernameError if the username is malformed or reserved.
// Use at every point where a user-controlled username would be persisted to
// Kratos/Gitea or used to address a privileged Gitea endpoint.
export function assertUsernameAllowed(username: unknown): asserts username is string {
  if (!isValidUsername(username) || isReservedUsername(username)) {
    throw new ReservedUsernameError(String(username));
  }
}
