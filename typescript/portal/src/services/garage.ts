// Per-project Garage (S3-compatible object storage) lifecycle — the storage
// capability. Structurally a twin of services/postgres.ts: we commit a
// StatefulSet + headless Service to the user's repo at k8s/garage.yaml and a
// SealedSecret carrying the credentials at k8s/secrets/garage.sealed.yaml.
// ArgoCD syncs both into the project's namespace and the kubelet pulls the
// platform's self-bootstrapping Garage image.
//
// Why a custom image (GARAGE_IMAGE): a fresh Garage node serves nothing until
// a cluster layout is assigned/applied and a bucket + access key exist, and the
// upstream image is distroless. The platform image (corpo-valley-main
// containers/garage) wraps Garage with an idempotent entrypoint that, on every
// start, brings the node up and ensures the layout/bucket/key — IMPORTING the
// access key we pre-generate here so the app's sealed credentials always match
// what Garage will accept. So the per-project resource stays a single-container
// StatefulSet, exactly like Postgres.
//
// Blast radius: the store lives in the project's own namespace; no other
// project can reach it (default-deny egress + namespace isolation), and the
// volumeClaimTemplate PVC is bound to the namespace.
//
// "Only exists as needed": enable commits the files; disable removes them
// (ArgoCD prunes). The PVC stays on disable so re-enable picks up the same
// objects (volumeClaimTemplate PVC name is stable: `data-garage-0`); pass
// destroy_data=true to also clean the PVC via the k8s API.
//
// Credential continuity: the generated secrets are stored (encrypted) in the
// projects row so disable/enable cycles reuse the same access key against the
// same data directory. Cleared on destroy_data so the next enable starts fresh.

import * as crypto from 'crypto';
import {
  getFile, upsertRepoFile, deleteRepoFile,
} from './gitea';
import { buildSealedSecretYaml } from './seal';
import { k8sDeleteNamespaced, k8sEnabled } from './k8s';
import { GARAGE_IMAGE, GARAGE_STORAGE_CLASS } from './platform-config';

const GARAGE_MANIFEST_PATH = 'k8s/garage.yaml';
const GARAGE_SEALED_PATH = 'k8s/secrets/garage.sealed.yaml';
const GARAGE_SECRET_NAME = 'garage';
// The single bucket the entrypoint provisions and the app reads/writes.
const GARAGE_BUCKET = 'app';

// Everything the app + the in-pod bootstrap need. All four secrets are
// regenerable but must stay STABLE across a disable/enable cycle so the
// re-imported key still authorises against the existing data — hence they're
// persisted (encrypted) in the projects row, like the Postgres password.
export interface GarageCredentials {
  // Garage cluster RPC shared secret — 32-byte hex (Garage requires hex here).
  rpcSecret: string;
  // Token for the node's admin API (used by the entrypoint over localhost).
  adminToken: string;
  // S3 access key id / secret the app authenticates with and the entrypoint
  // imports into Garage. `GK`-prefixed id mirrors Garage's own key format.
  accessKeyId: string;
  secretAccessKey: string;
}

export function generateGarageCredentials(): GarageCredentials {
  return {
    rpcSecret: crypto.randomBytes(32).toString('hex'),
    adminToken: crypto.randomBytes(24).toString('base64url'),
    accessKeyId: 'GK' + crypto.randomBytes(12).toString('hex'),
    secretAccessKey: crypto.randomBytes(32).toString('hex'),
  };
}

// The app-facing S3 connection details. The endpoint resolves to the headless
// Service in the project's own namespace; path-style addressing is required
// because Garage doesn't do virtual-host-style buckets by default.
export interface GarageConnection {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: string;
}

export function buildConnection(): GarageConnection {
  return {
    endpoint: 'http://garage:3900',
    region: 'garage',
    bucket: GARAGE_BUCKET,
    forcePathStyle: 'true',
  };
}

// StatefulSet + headless Service. The `corpo-valley.com/managed=garage` label
// is what the platform's cv-projects-garage-bounds VAP keys on; if the user
// removes it, the VAP stops applying — but it also stops being "the" garage the
// platform recognises (the portal's enable check looks for this exact path).
export function buildGarageManifest(slug: string): string {
  return `# Corpo Valley — per-project Garage (S3-compatible object storage).
# Managed by the platform via the portal's Storage card. Edits to this file
# will be overwritten on the next enable. To remove storage, use the portal
# (or the disable_storage MCP tool); do not delete this file by hand.
---
apiVersion: v1
kind: Service
metadata:
  name: garage
  namespace: ${slug}
  labels:
    app: garage
    corpo-valley.com/managed: garage
spec:
  clusterIP: None
  selector:
    app: garage
  ports:
    - name: s3
      port: 3900
      targetPort: 3900
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: garage
  namespace: ${slug}
  labels:
    app: garage
    corpo-valley.com/managed: garage
spec:
  serviceName: garage
  replicas: 1
  selector:
    matchLabels:
      app: garage
  template:
    metadata:
      labels:
        app: garage
        corpo-valley.com/managed: garage
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: garage
          image: ${GARAGE_IMAGE}
          imagePullPolicy: IfNotPresent
          # GARAGE_RPC_SECRET / GARAGE_ADMIN_TOKEN configure the daemon; the
          # S3_* keys are read by the entrypoint (to import the access key) and
          # are the same values the app container reads from this Secret.
          envFrom:
            - secretRef:
                name: ${GARAGE_SECRET_NAME}
          ports:
            - name: s3
              containerPort: 3900
            - name: admin
              containerPort: 3903
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: 50m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          readinessProbe:
            httpGet:
              path: /health
              port: admin
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: admin
            initialDelaySeconds: 30
            periodSeconds: 30
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
${GARAGE_STORAGE_CLASS !== undefined ? `        storageClassName: ${GARAGE_STORAGE_CLASS}\n` : ''}        resources:
          requests:
            storage: 5Gi
`;
}

export async function buildGarageSealedYaml(opts: {
  slug: string; creds: GarageCredentials;
}): Promise<string> {
  const conn = buildConnection();
  return buildSealedSecretYaml({
    namespace: opts.slug,
    name: GARAGE_SECRET_NAME,
    data: {
      GARAGE_RPC_SECRET: opts.creds.rpcSecret,
      GARAGE_ADMIN_TOKEN: opts.creds.adminToken,
      S3_ACCESS_KEY_ID: opts.creds.accessKeyId,
      S3_SECRET_ACCESS_KEY: opts.creds.secretAccessKey,
      S3_ENDPOINT: conn.endpoint,
      S3_BUCKET: conn.bucket,
      S3_REGION: conn.region,
      S3_FORCE_PATH_STYLE: conn.forcePathStyle,
    },
  });
}

export async function garageEnabled(opts: {
  owner: string; repo: string;
}): Promise<boolean> {
  // Source of truth: file present in repo. Stateless — no DB lookup needed.
  const file = await getFile({ owner: opts.owner, repo: opts.repo, path: GARAGE_MANIFEST_PATH }).catch(() => null);
  return !!file;
}

// Idempotent enable. If the files are already there, this still re-writes them
// with the current template (catches platform-side template bumps) but keeps
// the same credentials so the existing data directory is still usable.
export async function enableGarage(opts: {
  owner: string; repo: string; slug: string; creds: GarageCredentials;
}): Promise<{ secret_name: string; endpoint: string; bucket: string }> {
  const manifestYaml = buildGarageManifest(opts.slug);
  const sealedYaml = await buildGarageSealedYaml({ slug: opts.slug, creds: opts.creds });

  const existingManifest = await getFile({ owner: opts.owner, repo: opts.repo, path: GARAGE_MANIFEST_PATH }).catch(() => null);
  await upsertRepoFile({
    owner: opts.owner, repo: opts.repo,
    path: GARAGE_MANIFEST_PATH,
    content: manifestYaml,
    sha: existingManifest?.sha,
    message: existingManifest ? 'Corpo Valley: refresh garage manifest' : 'Corpo Valley: enable garage',
  });

  const existingSealed = await getFile({ owner: opts.owner, repo: opts.repo, path: GARAGE_SEALED_PATH }).catch(() => null);
  await upsertRepoFile({
    owner: opts.owner, repo: opts.repo,
    path: GARAGE_SEALED_PATH,
    content: sealedYaml,
    sha: existingSealed?.sha,
    message: existingSealed ? 'Corpo Valley: refresh garage credentials' : 'Corpo Valley: seal garage credentials',
  });

  const conn = buildConnection();
  return { secret_name: GARAGE_SECRET_NAME, endpoint: conn.endpoint, bucket: conn.bucket };
}

// Idempotent disable. Removes the manifest + sealed secret; ArgoCD prunes the
// StatefulSet, Service, and unsealed Secret. The PVC (created from the
// volumeClaimTemplate) is NOT owned by the StatefulSet and survives.
export async function disableGarage(opts: {
  owner: string; repo: string;
}): Promise<{ removed_manifest: boolean; removed_secret: boolean }> {
  const manifest = await getFile({ owner: opts.owner, repo: opts.repo, path: GARAGE_MANIFEST_PATH }).catch(() => null);
  const sealed = await getFile({ owner: opts.owner, repo: opts.repo, path: GARAGE_SEALED_PATH }).catch(() => null);

  if (manifest) {
    await deleteRepoFile({
      owner: opts.owner, repo: opts.repo,
      path: GARAGE_MANIFEST_PATH,
      sha: manifest.sha,
      message: 'Corpo Valley: disable garage',
    });
  }
  if (sealed) {
    await deleteRepoFile({
      owner: opts.owner, repo: opts.repo,
      path: GARAGE_SEALED_PATH,
      sha: sealed.sha,
      message: 'Corpo Valley: remove garage credentials',
    });
  }
  return { removed_manifest: !!manifest, removed_secret: !!sealed };
}

// Hard reset. After disableGarage has pruned the StatefulSet, delete the PVC so
// the next enable starts on a fresh data directory. The caller is expected to
// also clear the stored credentials so fresh ones get generated.
export async function destroyGaragePvc(slug: string): Promise<{ deleted: boolean }> {
  if (!k8sEnabled()) return { deleted: false };
  // volumeClaimTemplate naming: <vct-name>-<sts-name>-<ordinal>. Our vct is
  // `data`, sts is `garage`, single replica → `data-garage-0`.
  try {
    await k8sDeleteNamespaced(
      { apiGroup: '', version: 'v1', plural: 'persistentvolumeclaims', namespace: slug },
      'data-garage-0'
    );
    return { deleted: true };
  } catch (err: any) {
    if (err?.status === 404) return { deleted: false };
    throw err;
  }
}
