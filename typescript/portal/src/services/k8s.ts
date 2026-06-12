// In-cluster Kubernetes API client for the portal. Used to register an
// ArgoCD `Application` in the projects-ArgoCD namespace when a new project is
// created, so the projects ArgoCD picks up the new repo and deploys it.
//
// We talk to the API server directly with the pod's projected ServiceAccount
// token + the cluster's CA cert at the standard mount paths. This keeps the
// portal free of the heavy @kubernetes/client-node dependency.
//
// Disabled (and short-circuits to a no-op) when the token mount is absent —
// e.g. local dev outside the cluster.
import * as https from 'https';
import * as fs from 'fs';
import { KRATOS_NAMESPACE, PROJECTS_DOMAIN } from './platform-config';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN_FILE = `${SA_DIR}/token`;
const CA_FILE = `${SA_DIR}/ca.crt`;

// Use the DNS name (not KUBERNETES_SERVICE_HOST, which is a cluster IP) so the
// TLS handshake matches the API server cert's SAN cleanly.
const apiHost = 'kubernetes.default.svc';
const apiPort = process.env.KUBERNETES_SERVICE_PORT || '443';

let cachedCa: Buffer | null = null;

function readToken(): string {
  // Projected SA tokens rotate, so re-read each call.
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

function readCa(): Buffer {
  if (!cachedCa) cachedCa = fs.readFileSync(CA_FILE);
  return cachedCa;
}

export function k8sEnabled(): boolean {
  try {
    fs.accessSync(TOKEN_FILE, fs.constants.R_OK);
    fs.accessSync(CA_FILE, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export class K8sApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`k8s API ${status}: ${body?.message || (typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200))}`);
    this.name = 'K8sApiError';
  }
}

interface K8sCallOpts {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  contentType?: string;
}

function call<T>(opts: K8sCallOpts): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = https.request(
      {
        host: apiHost,
        port: Number(apiPort),
        method: opts.method,
        path: opts.path,
        ca: readCa(),
        headers: {
          Authorization: `Bearer ${readToken()}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': opts.contentType || 'application/json', 'Content-Length': String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: any;
          try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) resolve(body as T);
          else reject(new K8sApiError(status, body));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Read helpers for the MCP kube_get / kube_logs tools ───────────────────
// Generic GET/LIST against the API server. Callers pass the apiGroup +
// version + plural resource name, plus the namespace. The portal's
// ServiceAccount has read perms via the `cv-projects-reader` ClusterRole;
// the MCP tool layer enforces "namespace must equal a slug the caller
// owns" so the SA's broader cluster-read can't be abused through here.

function k8sPathBase(opts: { apiGroup: string; version: string }): string {
  return opts.apiGroup
    ? `/apis/${opts.apiGroup}/${opts.version}`
    : `/api/${opts.version}`;
}

export interface NamespacedRef {
  apiGroup: string;
  version: string;
  plural: string;
  namespace: string;
}

export async function k8sListNamespaced<T = any>(
  ref: NamespacedRef,
  opts?: { labelSelector?: string; fieldSelector?: string; limit?: number }
): Promise<T> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  const qs = new URLSearchParams();
  if (opts?.labelSelector) qs.set('labelSelector', opts.labelSelector);
  if (opts?.fieldSelector) qs.set('fieldSelector', opts.fieldSelector);
  if (opts?.limit) qs.set('limit', String(opts.limit));
  const q = qs.toString();
  return call<T>({
    method: 'GET',
    path: `${k8sPathBase(ref)}/namespaces/${encodeURIComponent(ref.namespace)}/${ref.plural}${q ? '?' + q : ''}`,
  });
}

export async function k8sGetNamespaced<T = any>(
  ref: NamespacedRef,
  name: string
): Promise<T> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  return call<T>({
    method: 'GET',
    path: `${k8sPathBase(ref)}/namespaces/${encodeURIComponent(ref.namespace)}/${ref.plural}/${encodeURIComponent(name)}`,
  });
}

// Delete a namespaced resource. Used today only by the postgres
// destroy-data path to clean a PVC after ArgoCD has pruned its owning
// StatefulSet. Throws K8sApiError with status=404 if the object is already
// gone, which the caller treats as success.
export async function k8sDeleteNamespaced<T = any>(
  ref: NamespacedRef,
  name: string
): Promise<T> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  return call<T>({
    method: 'DELETE',
    path: `${k8sPathBase(ref)}/namespaces/${encodeURIComponent(ref.namespace)}/${ref.plural}/${encodeURIComponent(name)}`,
  });
}

// Pod logs are served as text/plain, not JSON, so we make the request
// ourselves rather than going through `call<T>` (which json-parses).
export async function k8sPodLogs(opts: {
  namespace: string;
  pod: string;
  container?: string;
  tailLines?: number;
  previous?: boolean;
  timestamps?: boolean;
}): Promise<string> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  const qs = new URLSearchParams();
  if (opts.container) qs.set('container', opts.container);
  qs.set('tailLines', String(Math.max(1, Math.min(opts.tailLines ?? 200, 5000))));
  if (opts.previous) qs.set('previous', 'true');
  if (opts.timestamps) qs.set('timestamps', 'true');
  const path = `/api/v1/namespaces/${encodeURIComponent(opts.namespace)}/pods/${encodeURIComponent(opts.pod)}/log?${qs.toString()}`;

  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        host: apiHost,
        port: Number(apiPort),
        method: 'GET',
        path,
        ca: readCa(),
        headers: {
          Authorization: `Bearer ${readToken()}`,
          // k8s API rejects `Accept: text/plain` on /log even though the
          // response body is plain text. */* gets it through and the body
          // is still the raw log stream.
          Accept: '*/*',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) resolve(body);
          else reject(new K8sApiError(status, body));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Delete an ArgoCD Application. The Application's
// `resources-finalizer.argocd.argoproj.io` finalizer ensures the controller
// prunes the project's workloads in the destination namespace BEFORE the
// Application itself is removed. Idempotent: 404 = already gone.
export async function deleteArgoApplication(opts: {
  name: string; namespace: string;
}): Promise<void> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  try {
    await call({
      method: 'DELETE',
      path: `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(opts.namespace)}/applications/${encodeURIComponent(opts.name)}`,
    });
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 404) return;
    throw err;
  }
}

// Delete a Namespace. Cascades to all namespaced resources (Pods, PVCs,
// Secrets, ConfigMaps, Deployments, Ingresses, …). The application layer
// enforces "name must be an owned project slug" before calling, so the
// portal SA's cluster-wide namespaces:delete grant is bounded in practice.
// Idempotent: 404 = already gone.
export async function deleteNamespace(name: string): Promise<void> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  try {
    await call({
      method: 'DELETE',
      path: `/api/v1/namespaces/${encodeURIComponent(name)}`,
    });
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 404) return;
    throw err;
  }
}

// ── Argo Application read + sync ───────────────────────────────────────────
//
// Used by the MCP `get_argo_status` tool so an agent can answer "is this
// app synced and healthy, and if degraded, why?" in one call instead of
// chaining Deployment / Pod / Event reads. The portal already has r/w on
// applications.argoproj.io in cv-projects-argocd (see portal.yaml).

export interface ArgoApplicationStatus {
  name: string;
  namespace: string;
  sync: {
    status: string;     // Synced | OutOfSync | Unknown
    revision?: string;
  };
  health: {
    status: string;     // Healthy | Progressing | Degraded | Suspended | Missing | Unknown
    message?: string;
  };
  conditions: Array<{ type: string; message: string; lastTransitionTime?: string }>;
  operationState?: {
    phase: string;            // Running | Succeeded | Failed | Error | Terminating
    message?: string;
    startedAt?: string;
    finishedAt?: string;
    syncResult?: { revision?: string };
  };
  resources: Array<{
    kind: string;
    name: string;
    namespace?: string;
    status?: string;          // Sync status
    health?: { status: string; message?: string };
  }>;
  reconciledAt?: string;
}

export async function getArgoApplication(opts: {
  name: string; namespace: string;
}): Promise<ArgoApplicationStatus | null> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  try {
    const obj = await call<any>({
      method: 'GET',
      path: `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(opts.namespace)}/applications/${encodeURIComponent(opts.name)}`,
    });
    const s = obj?.status || {};
    return {
      name: obj?.metadata?.name || opts.name,
      namespace: obj?.metadata?.namespace || opts.namespace,
      sync: {
        status: s.sync?.status || 'Unknown',
        revision: s.sync?.revision,
      },
      health: {
        status: s.health?.status || 'Unknown',
        message: s.health?.message,
      },
      conditions: Array.isArray(s.conditions) ? s.conditions.map((c: any) => ({
        type: c.type, message: c.message, lastTransitionTime: c.lastTransitionTime,
      })) : [],
      operationState: s.operationState ? {
        phase: s.operationState.phase,
        message: s.operationState.message,
        startedAt: s.operationState.startedAt,
        finishedAt: s.operationState.finishedAt,
        syncResult: s.operationState.syncResult ? {
          revision: s.operationState.syncResult.revision,
        } : undefined,
      } : undefined,
      resources: Array.isArray(s.resources) ? s.resources.map((r: any) => ({
        kind: r.kind,
        name: r.name,
        namespace: r.namespace,
        status: r.status,
        health: r.health ? { status: r.health.status, message: r.health.message } : undefined,
      })) : [],
      reconciledAt: s.reconciledAt,
    };
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 404) return null;
    throw err;
  }
}

// Trigger a sync by patching the Application's `operation` field. ArgoCD's
// controller picks this up and runs the sync; the field is cleared when
// the operation finishes. `prune: true` matches the syncPolicy we set when
// the Application was created. Returns silently if there's already an
// in-flight operation — ArgoCD rejects concurrent operations with a 409 in
// that case, which we swallow as a no-op.
export async function triggerArgoSync(opts: {
  name: string; namespace: string; prune?: boolean; revision?: string;
}): Promise<void> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  const patch = {
    operation: {
      sync: {
        revision: opts.revision || 'HEAD',
        prune: opts.prune !== false,
        // No CreateNamespace: the portal owns sealed namespace creation; the
        // project's namespace already exists by the time a sync is triggered.
        syncOptions: [],
      },
      initiatedBy: { username: 'corpo-valley-mcp' },
    },
  };
  try {
    await call({
      method: 'PATCH',
      path: `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(opts.namespace)}/applications/${encodeURIComponent(opts.name)}`,
      body: patch,
      contentType: 'application/merge-patch+json',
    });
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 409) return;
    throw err;
  }
}

// ── Pod delete (used by rollout-restart) ───────────────────────────────────
//
// Powers the MCP `restart_project` tool. Deleting pods is the rollout-restart
// path that DOESN'T fight ArgoCD's selfHeal — the Deployment's ReplicaSet
// recreates the pods, and ArgoCD sees no spec drift. Patching the Deployment
// template with `kubectl.kubernetes.io/restartedAt` would be reverted by
// selfHeal within seconds, so we don't go that route.
//
// Caller (MCP layer) enforces "namespace must equal an owned project slug",
// so the cluster-wide `pods delete` grant on the portal SA is bounded to
// project namespaces in practice.

export interface DeletedPod { name: string; namespace: string; }

export async function k8sDeletePodsByLabel(opts: {
  namespace: string; labelSelector?: string;
}): Promise<DeletedPod[]> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  const list = await k8sListNamespaced<{ items?: Array<{ metadata?: { name?: string; namespace?: string } }> }>(
    { apiGroup: '', version: 'v1', plural: 'pods', namespace: opts.namespace },
    { labelSelector: opts.labelSelector, limit: 100 }
  );
  const items = Array.isArray(list?.items) ? list.items : [];
  const deleted: DeletedPod[] = [];
  for (const it of items) {
    const name = it?.metadata?.name;
    if (!name) continue;
    try {
      await call({
        method: 'DELETE',
        path: `/api/v1/namespaces/${encodeURIComponent(opts.namespace)}/pods/${encodeURIComponent(name)}`,
      });
      deleted.push({ name, namespace: opts.namespace });
    } catch (err) {
      // 404 = already gone (concurrent restart). Swallow so the tool stays
      // idempotent. Anything else bubbles.
      if (err instanceof K8sApiError && err.status === 404) continue;
      throw err;
    }
  }
  return deleted;
}

// ── Tenant namespace baseline ──────────────────────────────────────────────
//
// The platform OWNS the project namespace and stamps it with a containment
// baseline BEFORE the tenant's ArgoCD ever deploys into it: Pod Security
// labels, a default-deny-egress NetworkPolicy (allow only DNS, the namespace's
// own pods, Kratos identity, and the public internet — everything in-cluster
// and the node/metadata are blocked), a ResourceQuota, and a LimitRange so
// even a tenant pod that declares no resources is bounded. These are created
// by the portal (not the tenant repo), so a tenant can't remove them; the
// AppProject whitelist additionally forbids tenants from creating their own
// NetworkPolicies to override the egress lock.
//
// CIDRs are cluster-specific; defaults match this microk8s/Calico install.
const POD_CIDR = process.env.CV_POD_CIDR || '10.1.0.0/16';
const SERVICE_CIDR = process.env.CV_SERVICE_CIDR || '10.152.183.0/24';
const NODE_CIDR = process.env.CV_NODE_CIDR || '192.168.87.0/24';
const METADATA_CIDR = '169.254.169.254/32';

function tenantNamespaceObject(slug: string) {
  // Labels: baseline PSA blocks the worst (privileged/hostPath/host-namespaces)
  // and the cv-projects-pod-bounds VAP enforces the same un-removably; warn/audit
  // at restricted surface what would tighten later. See TENANT_NS_LABELS.
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: slug, labels: TENANT_NS_LABELS } };
}

function tenantEgressPolicyObject(slug: string) {
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'cv-tenant-egress-baseline', namespace: slug,
      labels: { 'corpo-valley.com/managed': 'baseline' } },
    spec: {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [
        // DNS to kube-dns.
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
          ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        // Same-namespace traffic (app → its own Postgres, sibling containers).
        { to: [{ podSelector: {} }] },
        // Kratos public ONLY — for session/identity resolution. No other Ory.
        // Namespace derived from KRATOS_PUBLIC_URL so a non-default
        // namespacePrefix deployment doesn't pin egress to a nonexistent ns.
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': KRATOS_NAMESPACE } }, podSelector: { matchLabels: { app: 'ory-kratos' } } }],
          ports: [{ protocol: 'TCP', port: 4433 }] },
        // The public internet, but NOT anything in-cluster, on the node, or the
        // cloud-metadata endpoint. This blocks Keto-write, the Ory admin ports,
        // other tenants' Postgres, the portal's internal endpoints, the
        // registry, and the kubelet — while letting tenant apps call out.
        { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [POD_CIDR, SERVICE_CIDR, NODE_CIDR, METADATA_CIDR] } }] },
      ],
    },
  };
}

function tenantResourceQuotaObject(slug: string) {
  return {
    apiVersion: 'v1', kind: 'ResourceQuota',
    metadata: { name: 'cv-tenant-quota', namespace: slug,
      labels: { 'corpo-valley.com/managed': 'baseline' } },
    spec: { hard: {
      'requests.cpu': '2', 'limits.cpu': '4',
      'requests.memory': '2Gi', 'limits.memory': '4Gi',
      'pods': '12', 'persistentvolumeclaims': '3',
      'services.loadbalancers': '0', 'services.nodeports': '0',
    } },
  };
}

function tenantLimitRangeObject(slug: string) {
  return {
    apiVersion: 'v1', kind: 'LimitRange',
    metadata: { name: 'cv-tenant-limits', namespace: slug,
      labels: { 'corpo-valley.com/managed': 'baseline' } },
    spec: { limits: [{
      type: 'Container',
      defaultRequest: { cpu: '50m', memory: '64Mi' },
      default: { cpu: '500m', memory: '256Mi' },
      max: { cpu: '2', memory: '2Gi' },
    }] },
  };
}

// Create a resource, treating 409 (already exists) as success. Used for the
// baseline objects, which are write-once per project.
async function createOrIgnore(path: string, body: unknown): Promise<void> {
  try {
    await call({ method: 'POST', path, body });
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 409) return;
    throw err;
  }
}

// The PSA + tenant labels every project namespace must carry. Kept here so the
// seal can PATCH them onto a namespace that already exists (createOrIgnore
// would 409-skip and leave a pre-existing namespace unlabeled).
const TENANT_NS_LABELS: Record<string, string> = {
  'corpo-valley.com/tenant': 'true',
  'pod-security.kubernetes.io/enforce': 'baseline',
  'pod-security.kubernetes.io/warn': 'restricted',
  'pod-security.kubernetes.io/audit': 'restricted',
};

// ── Per-project MCP gateway wiring ─────────────────────────────────────────
//
// The per-project `/mcp` endpoint can't be cookie-gated (MCP clients speak OAuth
// bearer, not browser sessions). So the platform routes `/mcp` to the shared
// cv-mcp-gateway (which does the OAuth flow + reverse-proxies to the project's
// mcp container). The portal applies these two objects DIRECTLY (not via the
// tenant repo), so a) the tenant can't edit them, and b) the Ingress — which
// omits the Kratos auth-url — bypasses the cv-projects-ingress-bounds VAP
// (that policy only constrains the projects-argocd controller, not the portal
// SA). A tenant-authored /mcp Ingress without the auth-url is still rejected.
const MCP_GATEWAY_FQDN = process.env.MCP_GATEWAY_FQDN || 'mcp-gateway.cv-portal.svc.cluster.local';
const MCP_GATEWAY_SVC = 'cv-mcp-gateway';

function mcpGatewayExternalName(slug: string) {
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: MCP_GATEWAY_SVC, namespace: slug, labels: { 'corpo-valley.com/managed': 'mcp-gateway' } },
    spec: { type: 'ExternalName', externalName: MCP_GATEWAY_FQDN, ports: [{ name: 'http', port: 80 }] },
  };
}

function mcpGatewayIngress(slug: string) {
  const host = `${slug}.${PROJECTS_DOMAIN}`;
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
    metadata: {
      name: `${slug}-mcp`, namespace: slug,
      labels: { 'corpo-valley.com/managed': 'mcp-gateway' },
      annotations: {
        'nginx.ingress.kubernetes.io/ssl-redirect': 'false',
        // Send the original project Host to the gateway so it can derive the slug.
        'nginx.ingress.kubernetes.io/upstream-vhost': host,
        // NO auth-url: the gateway enforces OAuth bearer auth itself.
      },
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [{
        host,
        http: {
          // /mcp plus the OAuth discovery paths the client fetches at the host
          // root — all to the gateway. These are more specific than the main
          // ingress's `/`, so nginx routes them here (bypassing the cookie gate)
          // while `/` and `/api` stay cookie-gated on the main ingress.
          paths: [
            { path: '/mcp', pathType: 'Prefix', backend: { service: { name: MCP_GATEWAY_SVC, port: { number: 80 } } } },
            { path: '/.well-known/oauth-protected-resource', pathType: 'Prefix', backend: { service: { name: MCP_GATEWAY_SVC, port: { number: 80 } } } },
            { path: '/.well-known/oauth-authorization-server', pathType: 'Prefix', backend: { service: { name: MCP_GATEWAY_SVC, port: { number: 80 } } } },
            { path: '/.well-known/openid-configuration', pathType: 'Prefix', backend: { service: { name: MCP_GATEWAY_SVC, port: { number: 80 } } } },
          ],
        },
      }],
    },
  };
}

// Create (idempotent) the project's /mcp gateway routing. Call when the mcp
// capability is enabled.
export async function applyMcpGateway(slug: string): Promise<void> {
  if (!k8sEnabled()) return;
  await createOrIgnore(`/api/v1/namespaces/${encodeURIComponent(slug)}/services`, mcpGatewayExternalName(slug));
  await createOrIgnore(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(slug)}/ingresses`, mcpGatewayIngress(slug));
}

// Remove the project's /mcp gateway routing. Call when the mcp capability is
// disabled. Idempotent (404 = already gone).
export async function removeMcpGateway(slug: string): Promise<void> {
  if (!k8sEnabled()) return;
  // Delete both objects INDEPENDENTLY: if the Ingress delete fails with a
  // transient (non-404) error, we must still attempt the Service delete, and
  // vice versa. Aborting after the first failure could leave the unauthenticated
  // /mcp Ingress in place after the capability is "disabled". Collect errors and
  // re-throw an aggregate so a reconciler/caller still sees the failure.
  const errors: unknown[] = [];
  for (const path of [
    `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(slug)}/ingresses/${slug}-mcp`,
    `/api/v1/namespaces/${encodeURIComponent(slug)}/services/${MCP_GATEWAY_SVC}`,
  ]) {
    try { await call({ method: 'DELETE', path }); }
    catch (err) { if (!(err instanceof K8sApiError && err.status === 404)) errors.push(err); }
  }
  if (errors.length) throw errors[0];
}

// Stamp the platform-owned containment baseline onto a project namespace,
// creating the namespace if needed. Idempotent. Throws if the namespace can't
// be sealed (caller must NOT register the ArgoCD app in that case — fail
// closed, never deploy tenant code into an unsealed namespace). Call BEFORE
// registering the project's ArgoCD Application.
// True iff a namespace with this name already exists in the cluster. Used as a
// slug-availability preflight: the DB `projects.slug` UNIQUE column is not the
// authority for whether a slug is free, because teardown is best-effort and
// `keep_namespace` can free the DB row while the namespace (and its workloads +
// materialised Secrets) survives. Creating a new project on such a slug would
// hand the new owner the previous tenant's live namespace, so we refuse it.
export async function namespaceExists(slug: string): Promise<boolean> {
  if (!k8sEnabled()) return false;
  try {
    await call({ method: 'GET', path: `/api/v1/namespaces/${encodeURIComponent(slug)}` });
    return true;
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 404) return false;
    throw err;
  }
}

export async function applyNamespaceBaseline(slug: string): Promise<void> {
  if (!k8sEnabled()) return;
  await createOrIgnore('/api/v1/namespaces', tenantNamespaceObject(slug));
  // Always (re)assert the labels via PATCH — covers the case where the
  // namespace already existed (e.g. a recreate, or ArgoCD got there first) and
  // the create above 409-skipped. A namespace without enforce=baseline is not
  // sealed, so this is load-bearing, not cosmetic.
  await call({
    method: 'PATCH',
    path: `/api/v1/namespaces/${encodeURIComponent(slug)}`,
    body: { metadata: { labels: TENANT_NS_LABELS } },
    contentType: 'application/merge-patch+json',
  });
  await createOrIgnore(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(slug)}/networkpolicies`, tenantEgressPolicyObject(slug));
  await createOrIgnore(`/api/v1/namespaces/${encodeURIComponent(slug)}/resourcequotas`, tenantResourceQuotaObject(slug));
  await createOrIgnore(`/api/v1/namespaces/${encodeURIComponent(slug)}/limitranges`, tenantLimitRangeObject(slug));
}

export interface ArgoApplicationSpec {
  name: string;             // Application name (= project slug).
  namespace: string;        // ArgoCD instance namespace (cv-projects-argocd).
  project: string;          // AppProject name (`projects`).
  destNamespace: string;    // Where the workload lands (= project slug).
  repoUrl: string;          // Gitea clone URL (in-cluster).
  path: string;             // Path inside the repo (e.g. `k8s`).
  revision?: string;        // Defaults to `main`.
}

// Create (or no-op on 409) an ArgoCD Application in the projects ArgoCD. The
// projects ArgoCD watches its own namespace for Applications via its
// AppProject, so creating the resource is enough to trigger a sync.
export async function createArgoApplication(spec: ArgoApplicationSpec): Promise<void> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled (no SA token mount)' });
  }
  const body = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: spec.project,
      source: {
        repoURL: spec.repoUrl,
        targetRevision: spec.revision || 'main',
        path: spec.path,
        // recurse: true so user-managed paths like `k8s/secrets/` get synced
        // alongside the top-level Deployment/Service/Ingress scaffold.
        directory: { recurse: true },
      },
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: spec.destNamespace,
      },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        // No CreateNamespace: the portal pre-creates the SEALED namespace
        // (PSA labels + NetworkPolicy + quota) before this Application is
        // registered. If the namespace is somehow absent, the sync fails
        // closed rather than ArgoCD creating an unsealed one.
        syncOptions: [],
      },
    },
  };
  try {
    await call({
      method: 'POST',
      path: `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(spec.namespace)}/applications`,
      body,
    });
  } catch (err) {
    // Idempotent: an Application with this name already exists.
    if (err instanceof K8sApiError && err.status === 409) return;
    throw err;
  }
}
