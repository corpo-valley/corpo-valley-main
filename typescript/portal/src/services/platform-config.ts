// Deployment-wide values every generator must agree on.
//
// The portal emits artifacts that embed this deployment's hosts and in-cluster
// DNS names: per-project k8s manifests (manifests.ts), the Community Center
// template seeded into Gitea (template-seed.ts), and the build.yaml refresh in
// pin-token-backfill.ts. They all read from here so the values can't drift
// between generators. The chart injects the env vars; the defaults reproduce
// the original corpo-valley.com deployment (namespacePrefix "cv-").

// Public suffix for project hosts: a project serves at <slug>.<PROJECTS_DOMAIN>.
export const PROJECTS_DOMAIN =
  process.env.PROJECTS_DOMAIN || 'projects.corpo-valley.com';

// The deployment's base domain: the projects suffix minus its first label
// (projects.example.com → example.com). Used to derive public hosts for
// links the portal/MCP hands to users and agents.
export const BASE_DOMAIN = PROJECTS_DOMAIN.split('.').slice(1).join('.');

// Public Gitea URL for browser/git links (clone URLs, repo links, docs).
// NOT the GITEA_URL env — that's the in-cluster API endpoint. Defaults to
// the chart's `gitea.<domain>` host convention; override with
// GITEA_PUBLIC_URL when hosts.gitea differs.
export const GITEA_PUBLIC_URL =
  (process.env.GITEA_PUBLIC_URL || `https://gitea.${BASE_DOMAIN}`).replace(/\/+$/, '');

// The portal's public base URL — project Ingresses bounce unauthenticated
// browsers to `${PORTAL_PUBLIC_URL}/login`. Note the production default, NOT
// the localhost default the rest of the portal uses for BASE_URL: this value
// is written into cluster-facing artifacts, where localhost would be wrong
// even in dev. Falls back to this deployment's own domain, never corpo-valley.com.
export const PORTAL_PUBLIC_URL =
  (process.env.BASE_URL || `https://portal.${BASE_DOMAIN}`).replace(/\/+$/, '');

// Public MCP endpoint editor configs point at. PUBLIC_MCP_URL is the RFC 9728
// resource identifier (host only); the JSON-RPC endpoint is <resource>/mcp.
export const PUBLIC_MCP_URL =
  (process.env.PUBLIC_MCP_URL || `https://mcp.${BASE_DOMAIN}`).replace(/\/+$/, '');
export const MCP_ENDPOINT_URL = `${PUBLIC_MCP_URL}/mcp`;

// Public OAuth (Hydra) URL editors are sent to for the OAuth handshake.
export const OAUTH_PUBLIC_URL =
  (process.env.HYDRA_PUBLIC_URL || `https://oauth.${BASE_DOMAIN}`).replace(/\/+$/, '');

// In-cluster registry the tenant Build workflows push to and the tenant
// Deployments pull from.
export const CV_REGISTRY =
  process.env.CV_REGISTRY || 'registry.cv-registry.svc.cluster.local:5000';

// The portal's own in-cluster URL — tenant Build workflows call
// `${PORTAL_INTERNAL_URL}/internal/projects/<slug>/pin` after pushing.
export const PORTAL_INTERNAL_URL =
  (process.env.CV_PORTAL_INTERNAL_URL || 'http://portal.cv-portal.svc.cluster.local')
    .replace(/\/+$/, '');

// In-cluster Kratos public endpoint — project Ingress auth-url and the
// template's identity helper validate sessions against it. Falls back to the
// cluster DNS literal (not session.ts's localhost dev default) because the
// consumers of this value run inside the cluster.
export const KRATOS_CLUSTER_URL =
  (process.env.KRATOS_PUBLIC_URL || 'http://ory-kratos-public.cv-ory.svc.cluster.local:4433')
    .replace(/\/+$/, '');

// Namespace Kratos runs in, parsed from KRATOS_CLUSTER_URL's in-cluster DNS
// name (ory-kratos-public.<ns>.svc.cluster.local). The per-project egress
// NetworkPolicy pins tenant → Kratos traffic to this namespace. Falls back
// to the original cv-ory when the URL isn't an in-cluster DNS name (dev).
export const KRATOS_NAMESPACE = (() => {
  try {
    const host = new URL(KRATOS_CLUSTER_URL).hostname;
    const m = /^[^.]+\.([^.]+)\.svc(\.|$)/.exec(host);
    if (m) return m[1];
  } catch { /* fall through */ }
  return 'cv-ory';
})();

// StorageClass for per-project Postgres PVCs (postgres.ts). Three states:
//   - env unset          → 'microk8s-hostpath' (the original deployment's SC,
//                          so non-chart upgrades behave exactly as before)
//   - env set but empty  → undefined: omit storageClassName entirely, letting
//                          the cluster's default StorageClass bind (EKS gp3,
//                          k3s local-path, ...)
//   - env set, non-empty → that class
// The chart always injects CV_STORAGE_CLASS from `storage.className`.
export const POSTGRES_STORAGE_CLASS: string | undefined =
  process.env.CV_STORAGE_CLASS === undefined
    ? 'microk8s-hostpath'
    : (process.env.CV_STORAGE_CLASS || undefined);

// StorageClass for per-project Garage PVCs — the same dial as Postgres, so a
// deployment's object-storage volumes bind on the same backend as its
// databases. Kept as its own export for readability at the call site.
export const GARAGE_STORAGE_CLASS: string | undefined = POSTGRES_STORAGE_CLASS;

// The self-bootstrapping Garage image the platform deploys for the storage
// capability (built from corpo-valley-main containers/garage). MUST match the
// image the chart's cv-projects-garage-bounds VAP pins, or the generated
// StatefulSet is rejected at admission. The chart injects this from
// `tenant.capabilities.garage.image`; the default reproduces the pinned
// upstream version.
export const GARAGE_IMAGE =
  process.env.CV_GARAGE_IMAGE || 'ghcr.io/corpo-valley/corpo-valley-garage:v1.0.1';

// Pinned image for the per-project Postgres "database" capability. The chart
// injects it from tenant.capabilities.postgres.image — the SAME value that
// pins the cv-projects-postgres-bounds VAP, so the generated StatefulSet and
// the admission gate can't drift. Sibling of GARAGE_IMAGE above.
export const POSTGRES_IMAGE =
  process.env.CV_POSTGRES_IMAGE || 'postgres:16-alpine';

// ── cooldeps: optional package-manager gating proxy (npm / PyPI / Go) ──────
// Whether this deployment runs the cooldeps supply-chain gate. The chart sets
// COOLDEPS_ENABLED from `cooldeps.enabled`. When on, the portal surfaces the
// /admin/cooldeps page, injects cooldeps reminders into the MCP instructions,
// docs, tool results, and the seeded Community Center template, and reconciles
// the cv-cooldeps ConfigMap (admin policy edits) + rolls the Deployment.
export const COOLDEPS_ENABLED =
  (process.env.COOLDEPS_ENABLED || 'false').toLowerCase() === 'true';

// In-cluster cooldeps endpoint (chart default
// http://cooldeps.cv-cooldeps.svc.cluster.local:8080). The base the CI runners
// and project builds point their package managers at; the per-ecosystem
// registry URLs the docs/template reference derive from it (…/npm, …/pypi/simple,
// …/go).
export const COOLDEPS_INTERNAL_URL =
  (process.env.COOLDEPS_INTERNAL_URL || 'http://cooldeps.cv-cooldeps.svc.cluster.local:8080')
    .replace(/\/+$/, '');

// Namespace the cooldeps Deployment + cooldeps-config ConfigMap live in. The
// portal patches the config and rolls the Deployment here when an admin saves
// new policy from /admin/cooldeps.
export const COOLDEPS_NAMESPACE =
  process.env.COOLDEPS_NAMESPACE || 'cv-cooldeps';

// Public cooldeps URL — set only when cooldeps.publicIngress is on (so dev
// laptops can install through it). Empty string means "in-cluster only".
export const COOLDEPS_PUBLIC_URL =
  (process.env.COOLDEPS_PUBLIC_URL || '').replace(/\/+$/, '');

// A Kubernetes resource "quantity": digits with an optional decimal/exponent
// and one of the canonical unit suffixes (e.g. 64Mi, 2Gi, 250m, 2). Anchored,
// and length-capped to keep a pathological input from reaching the regex.
// Used to validate BOTH operator-supplied env values below AND the untrusted
// resource values the manifest generator reads back from a project's
// hand-editable k8s/deployment.yaml — only a string that passes this is ever
// interpolated into generated YAML or a k8s API object.
// Mantissa, then an OPTIONAL tail that is EITHER a decimal exponent (e/E…) OR a
// unit suffix — never both, and no leading sign. This matches what the k8s
// apiserver actually accepts (a quantity is `<number><suffix>` where the
// exponent IS a suffix form), so a value we accept here won't be rejected at
// admission, and `quantityToNumber` parses exactly the same grammar.
const QUANTITY_RE =
  /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

export function isQuantity(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 32 && QUANTITY_RE.test(s);
}

// Read a memory/CPU quantity from the env, falling back (with no throw) to the
// baked default if the operator left it unset or supplied a non-quantity — a
// bad chart value must not produce a broken ResourceQuota/LimitRange or a
// deployment.yaml the apiserver rejects.
function quantityEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return isQuantity(v) ? v : fallback;
}

// ── Per-project memory budget (operator-owned ceilings) ─────────────────────
//
// The chart injects these; the portal stamps them onto every tenant namespace
// as a ResourceQuota (per-project totals) + LimitRange (per-container bounds
// and the defaults applied to containers that declare nothing). Project owners
// tune their pods' `resources:` within these ceilings and the apiserver
// enforces them — see k8s.ts (tenantResourceQuotaObject / tenantLimitRangeObject)
// and manifests.ts (the default stamped into a newly added capability). The
// defaults reproduce the original corpo-valley.com deployment.

// ResourceQuota limits.memory — the headline per-project max memory usage.
export const TENANT_MAX_MEMORY = quantityEnv('CV_MAX_MEMORY', '4Gi');
// ResourceQuota requests.memory — the per-project scheduled floor.
export const TENANT_MAX_MEMORY_REQUESTS = quantityEnv('CV_MAX_MEMORY_REQUESTS', '2Gi');
// LimitRange max.memory — ceiling any single container may request.
export const TENANT_MAX_MEMORY_PER_CONTAINER = quantityEnv('CV_MAX_MEMORY_PER_CONTAINER', '2Gi');
// Stamped into a freshly added capability container, and the LimitRange
// `default` (limit) for containers that declare no memory limit.
export const TENANT_DEFAULT_MEMORY = quantityEnv('CV_DEFAULT_MEMORY', '256Mi');
// The LimitRange `defaultRequest` and the request stamped into a new container.
export const TENANT_DEFAULT_MEMORY_REQUEST = quantityEnv('CV_DEFAULT_MEMORY_REQUEST', '64Mi');

// ── Per-project CPU budget (operator-owned ceilings) ────────────────────────
//
// The CPU twin of the memory block above — same ResourceQuota + LimitRange, and
// the same chart-default → per-project-override flow. Defaults reproduce the
// values that were hardcoded before they became tunable. Unlike before, the
// LimitRange default/defaultRequest are ALSO what manifests.ts stamps into a
// freshly added capability container, so a new container and the LimitRange
// agree (cf. memory, which has always shared one default).
//
// ResourceQuota limits.cpu — the per-project max CPU usage.
export const TENANT_MAX_CPU = quantityEnv('CV_MAX_CPU', '4');
// ResourceQuota requests.cpu — the per-project scheduled CPU floor.
export const TENANT_MAX_CPU_REQUESTS = quantityEnv('CV_MAX_CPU_REQUESTS', '2');
// LimitRange max.cpu — ceiling any single container may request.
export const TENANT_MAX_CPU_PER_CONTAINER = quantityEnv('CV_MAX_CPU_PER_CONTAINER', '2');
// LimitRange `default` (limit) + the cpu limit stamped into a new container.
export const TENANT_DEFAULT_CPU = quantityEnv('CV_DEFAULT_CPU', '500m');
// LimitRange `defaultRequest` + the cpu request stamped into a new container.
export const TENANT_DEFAULT_CPU_REQUEST = quantityEnv('CV_DEFAULT_CPU_REQUEST', '50m');

// ── Per-project storage budget (operator-owned) ─────────────────────────────
//
// CV_DEFAULT_STORAGE sizes each capability's data volume at PROVISION time (the
// Postgres/Garage volumeClaimTemplate). CV_MAX_STORAGE is the ResourceQuota
// `requests.storage` ceiling — the SUM of every PVC in the namespace. Growing a
// volume past 5Gi therefore needs this ceiling raised too; see reconcileTenant*
// in k8s.ts. A volume can only be grown (k8s forbids shrinking a PVC) and only
// when its StorageClass has allowVolumeExpansion.
export const TENANT_DEFAULT_STORAGE = quantityEnv('CV_DEFAULT_STORAGE', '5Gi');
// Per-VOLUME admission cap (chart tenant.storage.maxPerVolume). Mirrors the cap
// the cv-projects-*-bounds VAPs enforce on each PVC, so the portal can reject a
// grow that admission would later deny instead of half-applying it.
export const TENANT_MAX_PVC_SIZE = quantityEnv('CV_MAX_PVC_SIZE', '10Gi');
// Per-NAMESPACE total (chart tenant.storage.maxTotal) → ResourceQuota
// requests.storage, the sum of every PVC in the project.
export const TENANT_MAX_STORAGE = quantityEnv('CV_MAX_STORAGE', '20Gi');

// ── Per-project object-count budget (operator-owned) ────────────────────────
//
// ResourceQuota `pods` / `persistentvolumeclaims`. These cap how many of each a
// tenant can create — including objects an owner adds via their own repo, which
// ArgoCD syncs recursively. A positive integer; a bad chart value falls back to
// the baked default rather than producing a broken quota.
function countEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return isCount(v) ? v : fallback;
}

// A non-negative integer count (no unit suffix), length-capped. Distinct from
// isQuantity, which would also accept "12Mi" for a field that must be a count.
const COUNT_RE = /^\d+$/;
export function isCount(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 9 && COUNT_RE.test(s);
}

export const TENANT_MAX_PODS = countEnv('CV_MAX_PODS', '12');
export const TENANT_MAX_PVCS = countEnv('CV_MAX_PVCS', '3');

// Normalise a k8s quantity (or plain count) to a comparable number so we can
// enforce "up-only" per-project overrides — an admin may raise a project above
// the platform default but not below it. Handles binary (Ki…Ei = 1024^n),
// decimal (k…E = 1000^n), milli (m = 1e-3), and bare numbers (cpu cores, counts,
// bytes). Only ever used to compare two values of the SAME dimension (a field
// against its own default), so cross-unit meaning is irrelevant. Returns NaN on
// anything isQuantity/isCount wouldn't have accepted; callers validate first.
const QUANTITY_SUFFIX: Record<string, number> = {
  m: 1e-3,
  k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};
export function quantityToNumber(s: string): number {
  // Reuse QUANTITY_RE so this parses EXACTLY the grammar isQuantity accepts —
  // they can never drift. Group 1 = mantissa, group 3 = the optional tail.
  const m = QUANTITY_RE.exec(s);
  if (!m) return NaN;
  const tail = m[3];
  if (!tail) return Number(m[1]);
  // The tail is either a decimal exponent or a unit suffix (mutually exclusive).
  if (tail[0] === 'e' || tail[0] === 'E') return Number(m[1] + tail);
  return Number(m[1]) * QUANTITY_SUFFIX[tail];
}
