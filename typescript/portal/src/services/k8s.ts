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
import {
  KRATOS_NAMESPACE, PROJECTS_DOMAIN,
  TENANT_MAX_MEMORY, TENANT_MAX_MEMORY_REQUESTS, TENANT_MAX_MEMORY_PER_CONTAINER,
  TENANT_DEFAULT_MEMORY, TENANT_DEFAULT_MEMORY_REQUEST,
  TENANT_MAX_CPU, TENANT_MAX_CPU_REQUESTS, TENANT_MAX_CPU_PER_CONTAINER,
  TENANT_DEFAULT_CPU, TENANT_DEFAULT_CPU_REQUEST,
  TENANT_MAX_STORAGE, TENANT_MAX_PODS, TENANT_MAX_PVCS,
  quantityToNumber, isQuantity,
} from './platform-config';

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

// JSON merge-patch (RFC 7386) a namespaced resource. Used by the cooldeps admin
// reconcile to overwrite the ConfigMap's `cooldeps.yaml` key and to stamp a
// rollout-restart annotation on the Deployment. The portal SA is granted patch
// on exactly those two named objects in cv-cooldeps (chart RBAC).
export async function k8sMergePatchNamespaced<T = any>(
  ref: NamespacedRef, name: string, patch: unknown
): Promise<T> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  return call<T>({
    method: 'PATCH',
    path: `${k8sPathBase(ref)}/namespaces/${encodeURIComponent(ref.namespace)}/${ref.plural}/${encodeURIComponent(name)}`,
    body: patch,
    contentType: 'application/merge-patch+json',
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

// GET an arbitrary path on a Service through the API server's service-proxy
// subresource (`/api/v1/namespaces/<ns>/services/<scheme>:<name>:<port>/proxy/<path>`).
// Unlike hitting the Service's ClusterIP directly, this rides the API server's
// TLS + our ServiceAccount token, so an in-cluster MITM can't impersonate the
// target. The proxied endpoint may not return JSON (sealed-secrets serves PEM),
// so — like k8sPodLogs — we read the raw body rather than going through call<T>.
export async function k8sServiceProxyGet(opts: {
  namespace: string;
  service: string;
  path: string; // must begin with '/'
  scheme?: 'http' | 'https';
  port?: string | number;
}): Promise<string> {
  if (!k8sEnabled()) {
    throw new K8sApiError(0, { message: 'k8s integration disabled' });
  }
  // Service-proxy resource-name form: `<name>`, `<name>:<port>`, or
  // `<scheme>:<name>:<port>`. Colons must stay literal, so this segment is NOT
  // URL-encoded; service/scheme/port are operator-controlled (from the
  // controller URL), never user input.
  const svc =
    opts.scheme && opts.port !== undefined ? `${opts.scheme}:${opts.service}:${opts.port}`
    : opts.port !== undefined ? `${opts.service}:${opts.port}`
    : opts.service;
  const sub = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  const path = `/api/v1/namespaces/${encodeURIComponent(opts.namespace)}/services/${svc}/proxy${sub}`;

  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      { host: apiHost, port: Number(apiPort), method: 'GET', path, ca: readCa(),
        headers: { Authorization: `Bearer ${readToken()}`, Accept: '*/*' } },
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
// and the node/metadata are blocked), a default-deny-INGRESS NetworkPolicy
// (admit only the ingress controller, same-namespace pods, and the node for
// kubelet probes — a second belt so a forged X-CV-* request from another
// tenant is refused even if the egress CIDRs are misconfigured), a
// ResourceQuota, and a LimitRange so even a tenant pod that declares no
// resources is bounded. These are created by the portal (not the tenant repo),
// so a tenant can't remove them; the AppProject whitelist additionally forbids
// tenants from creating their own NetworkPolicies to override the lock.
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

// The label the deploying chart stamps on whichever namespace hosts the ingress
// controller (ingress-nginx on EKS, `ingress` on microk8s, kube-system on
// default k3s, …). Selecting by this label instead of a hardcoded namespace
// name keeps the ingress baseline CNI/distro-agnostic — the operator labels
// their controller namespace and this policy follows.
// Namespaces the ingress lock must admit (besides same-namespace + node),
// selected by the auto-applied `kubernetes.io/metadata.name` label so no
// namespace needs a custom label stamped on it (the ingress controller often
// lives in an addon namespace the chart doesn't own):
//  - the ingress controller — real user traffic. Default `ingress` (the
//    microk8s addon ns); set CV_INGRESS_NAMESPACE for other clusters
//    (`ingress-nginx` on EKS, `kube-system` for default k3s Traefik, …).
//  - the mcp-gateway, which reverse-proxies DIRECTLY to the tenant `<slug>-mcp`
//    pod cross-namespace (see mcp-gateway/src/index.ts) — admit it or every
//    project's /mcp breaks. Default the portal namespace; set
//    CV_MCP_GATEWAY_NAMESPACE if the platform uses a non-default namespacePrefix.
const INGRESS_CONTROLLER_NAMESPACE = process.env.CV_INGRESS_NAMESPACE || 'ingress';
const MCP_GATEWAY_NAMESPACE = process.env.CV_MCP_GATEWAY_NAMESPACE || 'cv-portal';

function nsNameSelector(name: string) {
  return { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } } };
}

// The INGRESS side of the tenant lock: flip tenant pods to default-deny inbound
// and admit only (a) the ingress controller — real user traffic, auth-
// subrequested with X-CV-* overwritten at the edge; (b) the mcp-gateway, which
// proxies to the tenant /mcp pod; (c) same-namespace pods — the app container
// reaching its OWN Postgres/Garage; and (d) the node CIDR, so kubelet
// liveness/readiness probes are not dropped (a lock that blocks probes would
// hang every rollout). This is a SECOND, independent belt to the egress
// baseline: even if the egress CIDRs are misconfigured for a given cluster, a
// forged X-CV-Perm request from another tenant's pod is refused here because its
// source is none of the admitted origins.
function tenantIngressPolicyObject(slug: string) {
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'cv-tenant-ingress-baseline', namespace: slug,
      labels: { 'corpo-valley.com/managed': 'baseline' } },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress'],
      ingress: [
        { from: [nsNameSelector(INGRESS_CONTROLLER_NAMESPACE)] },
        { from: [nsNameSelector(MCP_GATEWAY_NAMESPACE)] },
        { from: [{ podSelector: {} }] },
        { from: [{ ipBlock: { cidr: NODE_CIDR } }] },
      ],
    },
  };
}

// The tenant NetworkPolicies are cluster-specific in two ways operators must
// configure off microk8s: the CIDRs above, and a policy-ENFORCING CNI (default
// flannel on k3s and stock AWS VPC-CNI do not enforce NetworkPolicy, which would
// silently disable the whole tenant lock). Warn once, loudly, if the CIDRs are
// still the microk8s defaults so a misconfigured cluster is obvious rather than
// silently unisolated.
let cidrConfigWarned = false;
function warnClusterNetpolConfigOnce(): void {
  if (cidrConfigWarned) return;
  cidrConfigWarned = true;
  if (!process.env.CV_POD_CIDR || !process.env.CV_SERVICE_CIDR || !process.env.CV_NODE_CIDR) {
    console.warn(
      `[k8s] tenant NetworkPolicy baseline is using DEFAULT CIDRs for this microk8s/Calico install ` +
      `(pod=${POD_CIDR}, service=${SERVICE_CIDR}, node=${NODE_CIDR}). On any other cluster set ` +
      `CV_POD_CIDR/CV_SERVICE_CIDR/CV_NODE_CIDR (and, if they differ, CV_INGRESS_NAMESPACE / ` +
      `CV_MCP_GATEWAY_NAMESPACE), or tenant isolation will be misconfigured. NetworkPolicy also ` +
      `requires a policy-enforcing CNI (Calico/Cilium); default flannel (k3s) and stock AWS VPC-CNI ` +
      `do NOT enforce it, which silently disables the tenant lock.`,
    );
  }
}

// Per-project resource overrides an admin may pass to reconcileTenantResources
// to raise ONE project above the chart defaults (overrides are up-only; the
// route enforces that). Every field is optional; an omitted field falls back to
// the chart-configured value. Callers MUST have validated each supplied value
// (isQuantity / isCount, platform-config) first — these flow into a k8s API
// object, so a bad value would be rejected by the apiserver. The memory field
// names are kept short (`max`, `default`, …) for back-compat; cpu/storage/count
// fields are prefixed.
export interface TenantResourceOverrides {
  // memory (ResourceQuota + LimitRange)
  max?: string;
  maxRequests?: string;
  maxPerContainer?: string;
  default?: string;
  defaultRequest?: string;
  // cpu (ResourceQuota + LimitRange)
  cpuMax?: string;
  cpuMaxRequests?: string;
  cpuMaxPerContainer?: string;
  cpuDefault?: string;
  cpuDefaultRequest?: string;
  // ResourceQuota requests.storage (total of all PVCs) + object counts
  maxStorage?: string;
  maxPods?: string;
  maxPvcs?: string;
}

// Resolve the desired value of a field: an admin override wins; otherwise keep
// the project's CURRENT live value; otherwise the chart default. So a field the
// admin left blank stays UNCHANGED rather than being reset to the chart default
// (which would clobber an earlier per-project bump). `cur` is the live object's
// value, read by reconcileTenantResources; empty on the write-once create path.
function tenantResourceQuotaObject(
  slug: string, o: TenantResourceOverrides = {}, curHard: Record<string, string> = {},
) {
  const pick = (ov: string | undefined, key: string, def: string) => ov ?? curHard[key] ?? def;
  return {
    apiVersion: 'v1', kind: 'ResourceQuota',
    metadata: { name: 'cv-tenant-quota', namespace: slug,
      labels: { 'corpo-valley.com/managed': 'baseline' } },
    // Each field: operator-tunable via the chart (tenant.* → CV_*), per-project
    // raisable by an admin, and preserved-as-is when neither is supplied.
    spec: { hard: {
      'requests.cpu': pick(o.cpuMaxRequests, 'requests.cpu', TENANT_MAX_CPU_REQUESTS),
      'limits.cpu': pick(o.cpuMax, 'limits.cpu', TENANT_MAX_CPU),
      'requests.memory': pick(o.maxRequests, 'requests.memory', TENANT_MAX_MEMORY_REQUESTS),
      'limits.memory': pick(o.max, 'limits.memory', TENANT_MAX_MEMORY),
      'requests.storage': pick(o.maxStorage, 'requests.storage', TENANT_MAX_STORAGE),
      'pods': pick(o.maxPods, 'pods', TENANT_MAX_PODS),
      'persistentvolumeclaims': pick(o.maxPvcs, 'persistentvolumeclaims', TENANT_MAX_PVCS),
      // Deliberate hardening — always RE-ASSERTED (never preserved from live, so
      // a tampered quota can't keep a nonzero LB/NodePort allowance).
      'services.loadbalancers': '0', 'services.nodeports': '0',
    } },
  };
}

function tenantLimitRangeObject(
  slug: string, o: TenantResourceOverrides = {}, curLimit: any = undefined,
) {
  // Same precedence as the quota: override → current live value → chart default.
  // The LimitRange `limits` is an array (JSON merge-patch replaces it wholesale),
  // so we must emit the COMPLETE entry — hence reading each current sub-field.
  const curReq = curLimit?.defaultRequest || {};
  const curDef = curLimit?.default || {};
  const curMax = curLimit?.max || {};
  return {
    apiVersion: 'v1', kind: 'LimitRange',
    metadata: { name: 'cv-tenant-limits', namespace: slug,
      labels: { 'corpo-valley.com/managed': 'baseline' } },
    spec: { limits: [{
      type: 'Container',
      defaultRequest: {
        cpu: o.cpuDefaultRequest ?? curReq.cpu ?? TENANT_DEFAULT_CPU_REQUEST,
        memory: o.defaultRequest ?? curReq.memory ?? TENANT_DEFAULT_MEMORY_REQUEST,
      },
      default: {
        cpu: o.cpuDefault ?? curDef.cpu ?? TENANT_DEFAULT_CPU,
        memory: o.default ?? curDef.memory ?? TENANT_DEFAULT_MEMORY,
      },
      max: {
        cpu: o.cpuMaxPerContainer ?? curMax.cpu ?? TENANT_MAX_CPU_PER_CONTAINER,
        memory: o.maxPerContainer ?? curMax.memory ?? TENANT_MAX_MEMORY_PER_CONTAINER,
      },
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

// Merge-patch a named resource into its desired state; if it doesn't exist yet,
// create it. Unlike createOrIgnore (write-once), this UPDATES an existing
// object — used to push a changed budget onto a project whose baseline objects
// were already created. `collection` is the list path (…/resourcequotas);
// `name` is the object's metadata.name.
async function patchOrCreate(collection: string, name: string, body: unknown): Promise<'patched' | 'created'> {
  try {
    await call({
      method: 'PATCH',
      path: `${collection}/${encodeURIComponent(name)}`,
      body,
      contentType: 'application/merge-patch+json',
    });
    return 'patched';
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 404) {
      await call({ method: 'POST', path: collection, body });
      return 'created';
    }
    throw err;
  }
}

// GET a named object, returning null on 404 (rather than throwing) so callers
// can branch on existence. Other errors propagate.
async function getNamespacedOrNull(path: string): Promise<any | null> {
  try {
    return await call<any>({ method: 'GET', path });
  } catch (err) {
    if (err instanceof K8sApiError && err.status === 404) return null;
    throw err;
  }
}

// Reconcile ONE project's ResourceQuota + LimitRange. We GET the live objects
// FIRST and resolve each field as override → current live value → chart default,
// so an admin's partial edit changes ONLY the fields they supplied and leaves
// the rest untouched (a blank form field = unchanged). Because
// applyNamespaceBaseline creates these write-once, an admin's per-project bump
// only reaches an existing namespace through this call. Admin-triggered; see
// routes/admin.ts. Returns null when the k8s client is disabled (local dev).
// Throws (404) if the namespace doesn't exist — the caller validates first.
export async function reconcileTenantResources(
  slug: string,
  o: TenantResourceOverrides = {},
): Promise<{ quota: 'patched' | 'created'; limits: 'patched' | 'created' } | null> {
  if (!k8sEnabled()) return null;
  const ns = encodeURIComponent(slug);
  const quotaColl = `/api/v1/namespaces/${ns}/resourcequotas`;
  const limitsColl = `/api/v1/namespaces/${ns}/limitranges`;
  // Read current state first so unspecified fields are preserved, not reset.
  const curQuota = await getNamespacedOrNull(`${quotaColl}/cv-tenant-quota`);
  const curLimits = await getNamespacedOrNull(`${limitsColl}/cv-tenant-limits`);
  const quota = await patchOrCreate(
    quotaColl, 'cv-tenant-quota',
    tenantResourceQuotaObject(slug, o, curQuota?.spec?.hard),
  );
  const limits = await patchOrCreate(
    limitsColl, 'cv-tenant-limits',
    tenantLimitRangeObject(slug, o, curLimits?.spec?.limits?.[0]),
  );
  return { quota, limits };
}

// The project data volumes the platform manages, and the StatefulSet that owns
// each. PVC name follows the volumeClaimTemplate convention `<vct>-<sts>-<ord>`;
// both use vct `data`, single replica → ordinal 0. (postgres.ts / garage.ts.)
const MANAGED_PVCS = [
  { pvc: 'data-postgres-0', sts: 'postgres', capability: 'database' },
  { pvc: 'data-garage-0', sts: 'garage', capability: 'storage' },
] as const;

// Is this StorageClass online-expandable? A PVC can only be grown when its class
// has `allowVolumeExpansion: true`; otherwise k8s rejects the size patch. An
// absent class name (the cluster default, which the provisioner stamps onto the
// PVC anyway) or any read error → treat as not expandable, so the caller falls
// back to the manual-migration help page rather than attempting a doomed patch.
async function storageClassAllowsExpansion(name: string | undefined): Promise<boolean> {
  if (!name) return false;
  try {
    const sc = await call<any>({
      method: 'GET',
      path: `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`,
    });
    return sc?.allowVolumeExpansion === true;
  } catch {
    return false;
  }
}

// kubectl-rollout-restart equivalent: stamp a pod-template annotation so the
// StatefulSet controller recreates the pod, letting the kubelet finish an
// online filesystem resize that came back `FileSystemResizePending`.
async function restartStatefulSet(slug: string, name: string): Promise<void> {
  await call({
    method: 'PATCH',
    path: `/apis/apps/v1/namespaces/${encodeURIComponent(slug)}/statefulsets/${encodeURIComponent(name)}`,
    contentType: 'application/strategic-merge-patch+json',
    body: { spec: { template: { metadata: { annotations: {
      'corpo-valley.com/restartedAt': new Date().toISOString(),
    } } } } },
  });
}

export interface StorageReconcileEntry {
  pvc: string;
  capability: string;
  from?: string;
  to: string;
  // expanded: PVC grown (restarted true if a pod bounce was needed to finish).
  // unsupported: StorageClass can't expand — admin must migrate (help page).
  // noop: requested size ≤ current. absent: capability not enabled here.
  // error: the patch itself failed (e.g. quota too low) — see `note`.
  result: 'expanded' | 'unsupported' | 'noop' | 'absent' | 'error';
  restarted?: boolean;
  note?: string;
}

// Grow ONE project's managed data volumes (Postgres/Garage PVCs) to `size`,
// up-only. Raise the ResourceQuota `requests.storage` ceiling FIRST (caller
// passes it via reconcileTenantResources) or the apiserver rejects the PVC
// patch. Each PVC is handled independently and reported; a class that can't
// expand yields `unsupported` (→ help page) rather than failing the request.
// Returns null when the k8s client is disabled (local dev).
export async function reconcileTenantStorage(
  slug: string,
  size: string,
): Promise<StorageReconcileEntry[] | null> {
  if (!k8sEnabled()) return null;
  // Defensive: callers (routes/admin.ts) validate `size`, but this is exported —
  // never let an unvalidated value reach a PVC patch (NaN comparisons would slip
  // past the up-only/noop checks below).
  if (!isQuantity(size)) throw new Error(`reconcileTenantStorage: invalid size ${JSON.stringify(size)}`);
  const ns = encodeURIComponent(slug);
  const want = quantityToNumber(size);
  const out: StorageReconcileEntry[] = [];

  for (const { pvc, capability } of MANAGED_PVCS) {
    const collection = `/api/v1/namespaces/${ns}/persistentvolumeclaims`;
    let current: any;
    try {
      current = await call<any>({ method: 'GET', path: `${collection}/${encodeURIComponent(pvc)}` });
    } catch (err) {
      if (err instanceof K8sApiError && err.status === 404) {
        out.push({ pvc, capability, to: size, result: 'absent' });
        continue;
      }
      throw err;
    }

    const from: string | undefined = current?.spec?.resources?.requests?.storage;
    if (from !== undefined && quantityToNumber(from) >= want) {
      out.push({ pvc, capability, from, to: size, result: 'noop' });
      continue;
    }

    if (!(await storageClassAllowsExpansion(current?.spec?.storageClassName))) {
      out.push({ pvc, capability, from, to: size, result: 'unsupported' });
      continue;
    }

    try {
      await call({
        method: 'PATCH',
        path: `${collection}/${encodeURIComponent(pvc)}`,
        contentType: 'application/merge-patch+json',
        body: { spec: { resources: { requests: { storage: size } } } },
      });
    } catch (err: any) {
      out.push({ pvc, capability, from, to: size, result: 'error', note: err?.message });
      continue;
    }

    // Many CSI drivers expand the volume online but need the pod recreated to
    // grow the filesystem; surfaced as a FileSystemResizePending condition.
    let restarted = false;
    try {
      const after = await call<any>({ method: 'GET', path: `${collection}/${encodeURIComponent(pvc)}` });
      const pending = (after?.status?.conditions || []).some(
        (c: any) => c?.type === 'FileSystemResizePending',
      );
      if (pending) {
        await restartStatefulSet(slug, MANAGED_PVCS.find((m) => m.pvc === pvc)!.sts);
        restarted = true;
      }
    } catch { /* best-effort: the resize still completes once the pod cycles */ }

    out.push({ pvc, capability, from, to: size, result: 'expanded', restarted });
  }
  return out;
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
  warnClusterNetpolConfigOnce();
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
  await createOrIgnore(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(slug)}/networkpolicies`, tenantIngressPolicyObject(slug));
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
