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

const REGISTRY = process.env.CV_REGISTRY || 'registry.cv-registry.svc.cluster.local:5000';
// Placeholder tag before the first Build runs; the pin endpoint rewrites it.
const BOOTSTRAP_TAG = 'bootstrap';

const PORTS = { website: 8080, database: 3000, mcp: 9000 } as const;

interface ManifestOpts {
  owner: string;
  repo: string;
  slug: string;
  caps: Capabilities;
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
    `              cpu: 25m`,
    `              memory: 64Mi`,
    `            limits:`,
    `              cpu: 250m`,
    `              memory: 256Mi`,
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
  const containers: string[] = [
    containerBlock({
      name: 'static-site', image: img, command: 'static-site/server.js',
      portName: 'http-site', port: PORTS.website,
      env: [{ name: 'PORT', value: String(PORTS.website) }],
    }),
  ];
  if (opts.caps.database) {
    containers.push(containerBlock({
      name: 'database', image: img, command: 'database/server.js',
      portName: 'http-api', port: PORTS.database,
      env: [
        { name: 'PORT', value: String(PORTS.database) },
        { name: 'CV_SHARED', value: sharedVal },
        { name: 'DATABASE_URL', secret: { name: 'postgres', key: 'DATABASE_URL' } },
      ],
    }));
  }
  if (opts.caps.mcp) {
    containers.push(containerBlock({
      name: 'mcp', image: img, command: 'mcp/server.js',
      portName: 'http-mcp', port: PORTS.mcp,
      env: [
        { name: 'PORT', value: String(PORTS.mcp) },
        { name: 'CV_SHARED', value: sharedVal },
      ],
    }));
  }
  return `# Generated by the Corpo Valley portal from this project's capabilities.
# One container per enabled capability, all from the same image. Don't
# hand-edit — toggle capabilities in the portal and the platform rewrites this.
# The image tag is pinned by the Build workflow on every push to main.
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
  paths.push(pathBlock('/', opts.slug));
  return `# Generated by the Corpo Valley portal. Path-routed to the per-capability
# Services. auth-url gates every request through Kratos's session check; the
# forwarded Kratos cookie reaches the backend containers, where the
# database/mcp capabilities re-validate it to identify the caller. Don't
# hand-edit.
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${opts.slug}
  namespace: ${opts.slug}
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
    nginx.ingress.kubernetes.io/auth-url: "http://ory-kratos-public.cv-ory.svc.cluster.local:4433/sessions/whoami"
    nginx.ingress.kubernetes.io/auth-signin: "https://portal.corpo-valley.com/login"
    nginx.ingress.kubernetes.io/auth-signin-redirect-param: "return_to"
spec:
  ingressClassName: nginx
  rules:
    - host: ${opts.slug}.projects.corpo-valley.com
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
  if (!file) return { website: true, database: false, mcp: false, shared: false };
  const c = file.content;
  // Anchored to the container-name lines / the CV_SHARED env entry so a slug,
  // env value, or comment containing "database"/"mcp"/"true" can't false-match.
  const database = /^\s*-\s*name:\s*database\s*$/m.test(c);
  const mcp = /^\s*-\s*name:\s*mcp\s*$/m.test(c);
  const shared = /name:\s*CV_SHARED\s*\n\s*value:\s*"true"/.test(c);
  return { website: true, database, mcp, shared };
}

// Generate the three manifests and commit them to the project repo, each
// replacing whatever the template shipped (or a prior capability set). Done as
// individual upserts so each carries the previous blob sha. Idempotent: an
// unchanged file produces no commit.
export async function composeProjectManifests(opts: ManifestOpts): Promise<void> {
  const files: Array<{ path: string; content: string }> = [
    { path: 'k8s/deployment.yaml', content: buildDeploymentYaml(opts) },
    { path: 'k8s/service.yaml', content: buildServiceYaml(opts) },
    { path: 'k8s/ingress.yaml', content: buildIngressYaml(opts) },
  ];
  for (const f of files) {
    const existing = await getFile({ owner: opts.owner, repo: opts.repo, path: f.path }).catch(() => null);
    if (existing && existing.content === f.content) continue;
    await upsertRepoFile({
      owner: opts.owner, repo: opts.repo,
      path: f.path, content: f.content, sha: existing?.sha,
      message: `Corpo Valley: generate ${f.path} for capabilities`,
    });
  }
}
