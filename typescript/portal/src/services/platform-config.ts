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

// The portal's public base URL — project Ingresses bounce unauthenticated
// browsers to `${PORTAL_PUBLIC_URL}/login`. Note the production default, NOT
// the localhost default the rest of the portal uses for BASE_URL: this value
// is written into cluster-facing artifacts, where localhost would be wrong
// even in dev.
export const PORTAL_PUBLIC_URL =
  (process.env.BASE_URL || 'https://portal.corpo-valley.com').replace(/\/+$/, '');

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
