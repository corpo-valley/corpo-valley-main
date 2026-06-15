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
// `blob.garageImage`; the default reproduces the pinned upstream version.
export const GARAGE_IMAGE =
  process.env.CV_GARAGE_IMAGE || 'ghcr.io/corpo-valley/corpo-valley-garage:v1.0.1';
