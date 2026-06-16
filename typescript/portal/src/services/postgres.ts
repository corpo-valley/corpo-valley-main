// Per-project Postgres lifecycle.
//
// Option A (per-project pod): we commit a StatefulSet + headless Service to
// the user's repo at k8s/postgres.yaml and a SealedSecret carrying the
// credentials at k8s/secrets/postgres.sealed.yaml. ArgoCD syncs both into
// the project's namespace and the kubelet pulls postgres:16-alpine.
//
// Blast radius: the database lives in the project's namespace alongside the
// user's app. No other project can reach it (NetworkPolicy + namespace
// isolation), and the volumeClaimTemplate PVC is bound to the namespace.
//
// "Only exists as needed": enable commits the files; disable removes them
// (ArgoCD prunes). The PVC stays on disable so re-enable picks up the same
// data (volumeClaimTemplate PVC name is stable: `data-postgres-0`); pass
// destroy_data=true to also clean the PVC via the k8s API.
//
// Credential continuity: the generated password is stored in the projects
// row so disable/enable cycles reuse the same password against the same
// data directory. Cleared on destroy_data so the next enable starts fresh.

import * as crypto from 'crypto';
import {
  getFile, upsertRepoFile, deleteRepoFile,
} from './gitea';
import { buildSealedSecretYaml } from './seal';
import { k8sDeleteNamespaced, k8sEnabled } from './k8s';
import { POSTGRES_STORAGE_CLASS, TENANT_DEFAULT_STORAGE, POSTGRES_IMAGE } from './platform-config';

// Workflow file path inside a project repo. Used both by the postgres
// flow (no direct touch) and by the pin-token backfill which refreshes
// build.yaml on existing projects.
export const PROJECT_BUILD_WORKFLOW_PATH = '.gitea/workflows/build.yaml';

const POSTGRES_MANIFEST_PATH = 'k8s/postgres.yaml';
const POSTGRES_SEALED_PATH = 'k8s/secrets/postgres.sealed.yaml';
const POSTGRES_SECRET_NAME = 'postgres';

export function generatePostgresPassword(): string {
  // 24 random bytes → 32-char base64url. URL-safe so it round-trips through
  // a connection-string without percent-encoding.
  return crypto.randomBytes(24).toString('base64url');
}

export interface PostgresCredentials {
  user: string;
  db: string;
  password: string;
  // postgres://<user>:<password>@postgres:5432/<db> — resolves to the headless
  // Service in the project's own namespace.
  url: string;
}

export function buildCredentials(password: string): PostgresCredentials {
  const user = 'app';
  const db = 'app';
  return {
    user, db, password,
    url: `postgres://${user}:${encodeURIComponent(password)}@postgres:5432/${db}`,
  };
}

// StatefulSet + headless Service. The `corpo-valley.com/managed=postgres`
// label is what the platform's cv-projects-postgres-bounds VAP keys on; if
// the user removes it, the VAP stops applying — but it also stops being
// "the" postgres the platform recognises (e.g. the portal's enable check
// looks for this exact file path).
export function buildPostgresManifest(slug: string): string {
  return `# Corpo Valley — per-project Postgres.
# Managed by the platform via the portal's Database card. Edits to this file
# will be overwritten on the next enable. To remove the database, use the
# portal (or the disable_postgres MCP tool); do not delete this file by hand.
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: ${slug}
  labels:
    app: postgres
    corpo-valley.com/managed: postgres
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: ${slug}
  labels:
    app: postgres
    corpo-valley.com/managed: postgres
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
        corpo-valley.com/managed: postgres
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 70
        runAsGroup: 70
        fsGroup: 70
      containers:
        - name: postgres
          image: ${POSTGRES_IMAGE}
          imagePullPolicy: IfNotPresent
          envFrom:
            - secretRef:
                name: ${POSTGRES_SECRET_NAME}
          env:
            # postgres:alpine refuses to initdb on top of a non-empty mount
            # (the PVC root contains lost+found etc.). Point PGDATA at a
            # subdirectory so initdb is happy on a fresh PVC.
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - name: postgres
              containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 512Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "app", "-d", "app"]
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 5432
            initialDelaySeconds: 30
            periodSeconds: 30
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
${POSTGRES_STORAGE_CLASS !== undefined ? `        storageClassName: ${POSTGRES_STORAGE_CLASS}\n` : ''}        resources:
          requests:
            storage: ${TENANT_DEFAULT_STORAGE}
`;
}

export async function buildPostgresSealedYaml(opts: {
  slug: string; password: string;
}): Promise<string> {
  const creds = buildCredentials(opts.password);
  // POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD initialise the cluster on
  // first start (consumed by the entrypoint script). DATABASE_URL is what the
  // user's app reads — same secret, two paths in.
  return buildSealedSecretYaml({
    namespace: opts.slug,
    name: POSTGRES_SECRET_NAME,
    data: {
      POSTGRES_USER: creds.user,
      POSTGRES_DB: creds.db,
      POSTGRES_PASSWORD: creds.password,
      DATABASE_URL: creds.url,
    },
  });
}

export async function postgresEnabled(opts: {
  owner: string; repo: string;
}): Promise<boolean> {
  // Source of truth: file present in repo. Stateless — no DB lookup needed.
  const file = await getFile({ owner: opts.owner, repo: opts.repo, path: POSTGRES_MANIFEST_PATH }).catch(() => null);
  return !!file;
}

// Idempotent enable. If the file is already there, this still re-writes it
// with the current template (catches platform-side template bumps) but keeps
// the same password so the existing data directory is still readable.
export async function enablePostgres(opts: {
  owner: string; repo: string; slug: string; password: string;
}): Promise<{ secret_name: string; env_var: string }> {
  const manifestYaml = buildPostgresManifest(opts.slug);
  const sealedYaml = await buildPostgresSealedYaml({ slug: opts.slug, password: opts.password });

  const existingManifest = await getFile({ owner: opts.owner, repo: opts.repo, path: POSTGRES_MANIFEST_PATH }).catch(() => null);
  await upsertRepoFile({
    owner: opts.owner, repo: opts.repo,
    path: POSTGRES_MANIFEST_PATH,
    content: manifestYaml,
    sha: existingManifest?.sha,
    message: existingManifest ? 'Corpo Valley: refresh postgres manifest' : 'Corpo Valley: enable postgres',
  });

  const existingSealed = await getFile({ owner: opts.owner, repo: opts.repo, path: POSTGRES_SEALED_PATH }).catch(() => null);
  await upsertRepoFile({
    owner: opts.owner, repo: opts.repo,
    path: POSTGRES_SEALED_PATH,
    content: sealedYaml,
    sha: existingSealed?.sha,
    message: existingSealed ? 'Corpo Valley: refresh postgres credentials' : 'Corpo Valley: seal postgres credentials',
  });

  return { secret_name: POSTGRES_SECRET_NAME, env_var: 'DATABASE_URL' };
}

// Idempotent disable. Removes the manifest + sealed secret; ArgoCD prunes
// the StatefulSet, Service, and unsealed Secret. The PVC (created from the
// volumeClaimTemplate) is NOT owned by the StatefulSet and survives.
export async function disablePostgres(opts: {
  owner: string; repo: string;
}): Promise<{ removed_manifest: boolean; removed_secret: boolean }> {
  const manifest = await getFile({ owner: opts.owner, repo: opts.repo, path: POSTGRES_MANIFEST_PATH }).catch(() => null);
  const sealed = await getFile({ owner: opts.owner, repo: opts.repo, path: POSTGRES_SEALED_PATH }).catch(() => null);

  if (manifest) {
    await deleteRepoFile({
      owner: opts.owner, repo: opts.repo,
      path: POSTGRES_MANIFEST_PATH,
      sha: manifest.sha,
      message: 'Corpo Valley: disable postgres',
    });
  }
  if (sealed) {
    await deleteRepoFile({
      owner: opts.owner, repo: opts.repo,
      path: POSTGRES_SEALED_PATH,
      sha: sealed.sha,
      message: 'Corpo Valley: remove postgres credentials',
    });
  }
  return { removed_manifest: !!manifest, removed_secret: !!sealed };
}

// Hard reset. After disablePostgres has pruned the StatefulSet, delete the
// PVC so the next enable starts on a fresh data directory. The caller is
// expected to also clear the stored password so a fresh one gets generated.
export async function destroyPostgresPvc(slug: string): Promise<{ deleted: boolean }> {
  if (!k8sEnabled()) return { deleted: false };
  // volumeClaimTemplate naming: <vct-name>-<sts-name>-<ordinal>. Our vct is
  // `data`, sts is `postgres`, single replica → `data-postgres-0`.
  try {
    await k8sDeleteNamespaced(
      { apiGroup: '', version: 'v1', plural: 'persistentvolumeclaims', namespace: slug },
      'data-postgres-0'
    );
    return { deleted: true };
  } catch (err: any) {
    // 404 = nothing to clean (already gone or never created). Anything else
    // bubbles up — the caller decides how loud to be about it.
    if (err?.status === 404) return { deleted: false };
    throw err;
  }
}
