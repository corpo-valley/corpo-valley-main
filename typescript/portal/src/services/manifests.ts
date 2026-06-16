// Generates a project's k8s manifests from its capability set.
//
// A project's running shape is one Deployment whose pod has one container per
// enabled capability (all from the same image, different command + port), one
// Service per capability, and one path-routed Ingress. The portal regenerates
// these three files whenever the capability set changes (project create, or the
// set_capabilities tool) and commits them to the project repo; ArgoCD applies
// them and the Build workflow's pin keeps every container's image tag current.
//
// Keep the emitted YAML in sync with the reference copies the template ships
// in community-center/k8s/ — same containers, ports, probes, and security
// context, just filtered to the enabled capabilities.

import { getFile, upsertRepoFile } from './gitea';
import type { Capabilities } from './templates';
import {
  CV_REGISTRY, PORTAL_PUBLIC_URL, PORTAL_INTERNAL_URL, PROJECTS_DOMAIN,
  TENANT_DEFAULT_MEMORY, TENANT_DEFAULT_MEMORY_REQUEST,
  TENANT_DEFAULT_CPU, TENANT_DEFAULT_CPU_REQUEST, isQuantity,
} from './platform-config';

const REGISTRY = CV_REGISTRY;
// Placeholder tag before the first Build runs; the pin endpoint rewrites it.
const BOOTSTRAP_TAG = 'bootstrap';

const PORTS = { website: 8080, database: 3000, storage: 7000, mcp: 9000 } as const;

interface ManifestOpts {
  owner: string;
  repo: string;
  slug: string;
  caps: Capabilities;
  // The project's current k8s/deployment.yaml, if it already exists. Used to
  // preserve each container's owner-tuned `resources:` across a regeneration
  // (Layer 2). composeProjectManifests supplies this; callers that build a
  // brand-new project leave it unset (everything gets the chart defaults).
  existingDeployment?: string | null;
}

// cpu/memory defaults stamped into a newly added container both come from the
// chart via platform-config now, and match the LimitRange's default/defaultRequest
// so a fresh container agrees with what the platform would inject anyway. An
// owner's hand-tuned values are preserved across regeneration regardless.

// A container's resource quantities carried forward from an existing manifest.
// Every field is either undefined (use the default) or a string already
// validated by isQuantity — never raw YAML scraped from the repo.
interface ResourceValues {
  reqCpu?: string;
  reqMem?: string;
  limCpu?: string;
  limMem?: string;
}

// Read `key:` from inside the `section:` ("requests"/"limits") sub-block of a
// single container's text. Indentation-bounded: we stop at the first line whose
// indent falls back to (or below) the section header's, so a `memory:` under
// `limits:` can't be misread as one under `requests:`. The returned scalar is
// stripped of any surrounding quotes; the CALLER validates it as a quantity.
function valueUnder(block: string, section: 'requests' | 'limits', key: 'cpu' | 'memory'): string | undefined {
  const sec = new RegExp(`^([ \\t]*)${section}:[ \\t]*$`, 'm').exec(block);
  if (!sec) return undefined;
  const sectionIndent = sec[1].length;
  const lines = block.slice(sec.index + sec[0].length).split('\n');
  const kv = new RegExp(`^[ \\t]*${key}:[ \\t]*(\\S+)[ \\t]*$`);
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.replace(/^[ \t]+/, '').length;
    if (indent <= sectionIndent) break; // left the section's sub-block
    const m = kv.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

// Pull one container's resource quantities out of an existing, hand-editable
// deployment.yaml. UNTRUSTED INPUT: each value is accepted only if isQuantity
// passes, and only that validated scalar is ever returned — never surrounding
// YAML — so a doctored manifest cannot inject structure into the file we
// regenerate. An absent/garbage value simply falls back to the default.
function containerResources(block: string): ResourceValues {
  const ok = (s: string | undefined) => (isQuantity(s) ? s : undefined);
  return {
    reqCpu: ok(valueUnder(block, 'requests', 'cpu')),
    reqMem: ok(valueUnder(block, 'requests', 'memory')),
    limCpu: ok(valueUnder(block, 'limits', 'cpu')),
    limMem: ok(valueUnder(block, 'limits', 'memory')),
  };
}

// Map each known container name → its current resource values, read from the
// existing deployment.yaml. We slice the file into per-container blocks by the
// list-item `- name: <known>` markers (anchored to the names we generate, like
// detectCapabilities) and bound each block at the next such marker. Containers
// absent from the file (or a brand-new project) just won't appear in the map.
const CONTAINER_NAMES = ['static-site', 'database', 'storage', 'mcp'] as const;

function extractContainerResources(existing: string | null | undefined): Map<string, ResourceValues> {
  const out = new Map<string, ResourceValues>();
  if (!existing) return out;
  // Isolate the `containers:` list first, so a `- name:` that lives inside an
  // env/ports entry (more deeply indented) or the `metadata.name` slug can't be
  // mistaken for a container boundary — an attacker setting an env var
  // `- name: database` must not be able to forge or split a container block.
  const ch = /^([ \t]*)containers:[ \t]*$/m.exec(existing);
  if (!ch) return out;
  const cIndent = ch[1].length;
  const afterLines = existing.slice(ch.index + ch[0].length).split('\n');
  const regionLines: string[] = [];
  for (const line of afterLines) {
    if (line.trim() !== '') {
      const indent = line.length - line.replace(/^[ \t]+/, '').length;
      if (indent <= cIndent) break; // reached a sibling key (e.g. volumes:)
    }
    regionLines.push(line);
  }
  const region = regionLines.join('\n');
  // Container list items are the SHALLOWEST `- name:` entries in that region;
  // anything more indented is a nested env/ports entry and is ignored.
  const itemRe = /^([ \t]*)-[ \t]+name:[ \t]*([A-Za-z0-9-]+)[ \t]*$/gm;
  const all: Array<{ name: string; index: number; indent: number }> = [];
  for (let m = itemRe.exec(region); m; m = itemRe.exec(region)) {
    all.push({ name: m[2], index: m.index, indent: m[1].length });
  }
  if (all.length === 0) return out;
  const itemIndent = Math.min(...all.map((x) => x.indent));
  const starts = all.filter((x) => x.indent === itemIndent);
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : region.length;
    // Only carry forward containers we actually manage. First block wins if a
    // name somehow repeats.
    if ((CONTAINER_NAMES as readonly string[]).includes(starts[i].name) && !out.has(starts[i].name)) {
      out.set(starts[i].name, containerResources(region.slice(starts[i].index, end)));
    }
  }
  return out;
}

function image(owner: string, repo: string): string {
  return `${REGISTRY}/${owner}/${repo}:${BOOTSTRAP_TAG}`;
}

// One container block for a capability. `command` starts that module from the
// shared image; `port` is the container's named port the Service targets.
function containerBlock(opts: {
  name: string;
  image: string;
  command: string;
  portName: string;
  port: number;
  env: Array<{ name: string; value?: string; secret?: { name: string; key: string } }>;
  // Owner-tuned resources carried forward from the existing manifest, if any.
  // Each field is already isQuantity-validated; absent fields use the defaults
  // (both cpu and memory from the chart). Always emitted via this fixed template,
  // so only validated scalars — never repo YAML — reach the generated file.
  resources?: ResourceValues;
}): string {
  const envLines = opts.env.length
    ? ['          env:'].concat(opts.env.map((e) => {
        if (e.secret) {
          return `            - name: ${e.name}\n` +
                 `              valueFrom:\n` +
                 `                secretKeyRef:\n` +
                 `                  name: ${e.secret.name}\n` +
                 `                  key: ${e.secret.key}`;
        }
        // JSON.stringify produces a valid YAML double-quoted scalar with quotes,
        // backslashes, and newlines escaped — so a value can never break out of
        // the string and inject arbitrary Deployment YAML, even if a future
        // caller passes a user-influenced env value (today they're all constants).
        return `            - name: ${e.name}\n              value: ${JSON.stringify(e.value ?? '')}`;
      }))
    : [];
  return [
    `        - name: ${opts.name}`,
    `          image: ${opts.image}`,
    `          imagePullPolicy: IfNotPresent`,
    `          command: ["node", "${opts.command}"]`,
    `          ports:`,
    `            - name: ${opts.portName}`,
    `              containerPort: ${opts.port}`,
    ...envLines,
    `          resources:`,
    `            requests:`,
    `              cpu: ${opts.resources?.reqCpu ?? TENANT_DEFAULT_CPU_REQUEST}`,
    `              memory: ${opts.resources?.reqMem ?? TENANT_DEFAULT_MEMORY_REQUEST}`,
    `            limits:`,
    `              cpu: ${opts.resources?.limCpu ?? TENANT_DEFAULT_CPU}`,
    `              memory: ${opts.resources?.limMem ?? TENANT_DEFAULT_MEMORY}`,
    `          securityContext:`,
    `            allowPrivilegeEscalation: false`,
    `            readOnlyRootFilesystem: true`,
    `            capabilities:`,
    `              drop: ["ALL"]`,
    `          volumeMounts:`,
    `            - name: tmp`,
    `              mountPath: /tmp`,
    `              subPath: ${opts.name}`,
    `          readinessProbe:`,
    `            httpGet:`,
    `              path: /readyz`,
    `              port: ${opts.portName}`,
    `            initialDelaySeconds: 5`,
    `            periodSeconds: 10`,
    `          livenessProbe:`,
    `            httpGet:`,
    `              path: /healthz`,
    `              port: ${opts.portName}`,
    `            initialDelaySeconds: 15`,
    `            periodSeconds: 30`,
  ].join('\n');
}

export function buildDeploymentYaml(opts: ManifestOpts): string {
  const img = image(opts.owner, opts.repo);
  const sharedVal = opts.caps.shared ? 'true' : 'false';
  // Carry forward each container's owner-tuned resources from the existing
  // manifest; a container that isn't there yet (newly enabled capability, or a
  // brand-new project) gets undefined → the chart defaults.
  const prior = extractContainerResources(opts.existingDeployment);

  // Cross-capability credentials: EVERY container in the pod gets the creds for
  // ALL enabled stateful capabilities, not just the one it serves. These
  // containers are the same project image, in one pod, written by one author,
  // so per-capability cred siloing blocked legitimate cross-capability app
  // logic (e.g. the storage server recording a download into the database) for
  // negligible blast-radius gain. A cred is only projected when its capability
  // is enabled — so the referenced Secret (postgres / garage) always exists.
  const sharedCreds: Array<{ name: string; value?: string; secret?: { name: string; key: string } }> = [];
  if (opts.caps.database) {
    sharedCreds.push({ name: 'DATABASE_URL', secret: { name: 'postgres', key: 'DATABASE_URL' } });
  }
  if (opts.caps.storage) {
    // S3 connection + credentials from the per-project `garage` Secret
    // (services/garage.ts seals it); all six keys projected individually.
    for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_FORCE_PATH_STYLE', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      sharedCreds.push({ name: key, secret: { name: 'garage', key } });
    }
  }
  // Per-container env = its own PORT + the shared data-mode flag + every
  // enabled capability's creds.
  const envFor = (port: number) => [
    { name: 'PORT', value: String(port) },
    { name: 'CV_SHARED', value: sharedVal },
    ...sharedCreds,
  ];

  const containers: string[] = [
    containerBlock({
      name: 'static-site', image: img, command: 'static-site/server.js',
      portName: 'http-site', port: PORTS.website,
      env: envFor(PORTS.website),
      resources: prior.get('static-site'),
    }),
  ];
  if (opts.caps.database) {
    containers.push(containerBlock({
      name: 'database', image: img, command: 'database/server.js',
      portName: 'http-api', port: PORTS.database,
      env: envFor(PORTS.database),
      resources: prior.get('database'),
    }));
  }
  if (opts.caps.storage) {
    containers.push(containerBlock({
      name: 'storage', image: img, command: 'storage/server.js',
      portName: 'http-files', port: PORTS.storage,
      env: envFor(PORTS.storage),
      resources: prior.get('storage'),
    }));
  }
  if (opts.caps.mcp) {
    containers.push(containerBlock({
      name: 'mcp', image: img, command: 'mcp/server.js',
      portName: 'http-mcp', port: PORTS.mcp,
      env: envFor(PORTS.mcp),
      resources: prior.get('mcp'),
    }));
  }
  return `# Generated by the Corpo Valley portal from this project's capabilities.
# One container per enabled capability, all from the same image. Toggle
# capabilities in the portal and the platform rewrites this — but it PRESERVES
# each container's \`resources:\` block, so you can tune cpu/memory here and your
# values stick (the platform only fills defaults for a newly added capability).
# Memory is also bounded by the project's ResourceQuota/LimitRange. The image
# tag is pinned by the Build workflow on every push to main.
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${opts.slug}
  namespace: ${opts.slug}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${opts.slug}
  template:
    metadata:
      labels:
        app: ${opts.slug}
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
${containers.join('\n')}
      volumes:
        - name: tmp
          emptyDir: {}
`;
}

function serviceBlock(slug: string, name: string, targetPort: string): string {
  return `---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${slug}
spec:
  selector:
    app: ${slug}
  ports:
    - name: http
      port: 80
      targetPort: ${targetPort}`;
}

export function buildServiceYaml(opts: ManifestOpts): string {
  const blocks = [serviceBlock(opts.slug, opts.slug, 'http-site')];
  if (opts.caps.database) blocks.push(serviceBlock(opts.slug, `${opts.slug}-api`, 'http-api'));
  if (opts.caps.storage) blocks.push(serviceBlock(opts.slug, `${opts.slug}-files`, 'http-files'));
  if (opts.caps.mcp) blocks.push(serviceBlock(opts.slug, `${opts.slug}-mcp`, 'http-mcp'));
  return `# Generated by the Corpo Valley portal. One Service per capability,
# each forwarding to that capability's container port. Don't hand-edit.
${blocks.join('\n')}
`;
}

function pathBlock(path: string, serviceName: string): string {
  return `          - path: ${path}
            pathType: Prefix
            backend:
              service:
                name: ${serviceName}
                port:
                  number: 80`;
}

export function buildIngressYaml(opts: ManifestOpts): string {
  // Most-specific paths first. The website's `/` is always last so it only
  // catches what the capability paths didn't. NOTE: `/mcp` is intentionally NOT
  // here — when the mcp capability is on, the portal applies a SEPARATE Ingress
  // (k8s.ts applyMcpGateway) that routes /mcp to the cv-mcp-gateway without the
  // Kratos cookie gate, because MCP clients authenticate with OAuth bearer, not
  // a browser session. This Ingress keeps the cookie gate for / and /api.
  const paths: string[] = [];
  if (opts.caps.database) paths.push(pathBlock('/api', `${opts.slug}-api`));
  if (opts.caps.storage) paths.push(pathBlock('/files', `${opts.slug}-files`));
  paths.push(pathBlock('/', opts.slug));
  return `# Generated by the Corpo Valley portal. Path-routed to the per-capability
# Services. auth-url gates every request through the portal's project-access
# check: visitors without an active session bounce to login, signed-in members
# without \`read\` on this project get 403 at the edge, and allowed requests
# reach the containers carrying the trusted identity headers X-CV-User-Id /
# X-CV-User-Email / X-CV-Perm (nginx overwrites any client-supplied copies —
# your code may trust them; see ACCESS.md). Don't hand-edit.
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${opts.slug}
  namespace: ${opts.slug}
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
    nginx.ingress.kubernetes.io/auth-url: "${PORTAL_INTERNAL_URL}/access/site/${opts.slug}"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-CV-User-Id, X-CV-User-Email, X-CV-Perm"
    nginx.ingress.kubernetes.io/auth-signin: "${PORTAL_PUBLIC_URL}/login"
    nginx.ingress.kubernetes.io/auth-signin-redirect-param: "return_to"
spec:
  ingressClassName: nginx
  rules:
    - host: ${opts.slug}.${PROJECTS_DOMAIN}
      http:
        paths:
${paths.join('\n')}
`;
}

// Read a project's currently-deployed capability set from its generated
// k8s/deployment.yaml (the source of truth for what's running). The website is
// always on; database/mcp are inferred from the presence of their containers,
// and `shared` from the CV_SHARED env entry.
//
// Fail-closed: getFile returns null ONLY on a genuine 404 (file absent → a
// website-only project), and THROWS on any other error. We deliberately don't
// swallow those — a transient Gitea read error must propagate, because callers
// like set_capabilities merge onto this result and a wrong read would
// destructively drop a container (and its Service/Ingress path) from a project
// that actually has it.
export async function detectCapabilities(opts: {
  owner: string; repo: string;
}): Promise<Capabilities> {
  const file = await getFile({ owner: opts.owner, repo: opts.repo, path: 'k8s/deployment.yaml' });
  if (!file) return { website: true, database: false, storage: false, mcp: false, shared: false };
  const c = file.content;
  // Anchored to the container-name lines / the CV_SHARED env entry so a slug,
  // env value, or comment containing "database"/"storage"/"mcp"/"true" can't
  // false-match.
  const database = /^\s*-\s*name:\s*database\s*$/m.test(c);
  const storage = /^\s*-\s*name:\s*storage\s*$/m.test(c);
  const mcp = /^\s*-\s*name:\s*mcp\s*$/m.test(c);
  const shared = /name:\s*CV_SHARED\s*\n\s*value:\s*"true"/.test(c);
  return { website: true, database, storage, mcp, shared };
}

// Generate the three manifests and commit them to the project repo, each
// replacing whatever the template shipped (or a prior capability set). Done as
// individual upserts so each carries the previous blob sha. Idempotent: an
// unchanged file produces no commit.
export async function composeProjectManifests(opts: ManifestOpts): Promise<void> {
  // Fetch the current deployment up front so regeneration can preserve the
  // owner's resource tuning (Layer 2). Reused below as the deployment's
  // existing blob for the sha + idempotency compare, so this is one GET, not
  // two. A 404 (or any read error) → null → the chart defaults are used.
  const existingDeployment = await getFile({ owner: opts.owner, repo: opts.repo, path: 'k8s/deployment.yaml' }).catch(() => null);
  const files: Array<{ path: string; content: string; prefetched?: typeof existingDeployment }> = [
    {
      path: 'k8s/deployment.yaml',
      content: buildDeploymentYaml({ ...opts, existingDeployment: existingDeployment?.content ?? null }),
      prefetched: existingDeployment,
    },
    { path: 'k8s/service.yaml', content: buildServiceYaml(opts) },
    { path: 'k8s/ingress.yaml', content: buildIngressYaml(opts) },
  ];
  for (const f of files) {
    const existing = f.prefetched !== undefined
      ? f.prefetched
      : await getFile({ owner: opts.owner, repo: opts.repo, path: f.path }).catch(() => null);
    if (existing && existing.content === f.content) continue;
    await upsertRepoFile({
      owner: opts.owner, repo: opts.repo,
      path: f.path, content: f.content, sha: existing?.sha,
      message: `Corpo Valley: generate ${f.path} for capabilities`,
    });
  }
}
