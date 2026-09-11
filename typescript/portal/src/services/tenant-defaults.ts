// Platform-wide tenant resource defaults, edited by an admin on
// /admin/resources. Follows the cooldeps-config.ts pattern: the chart values
// (tenant.* → CV_* env, parsed in platform-config.ts) SEED the defaults; once
// an admin saves, the single row in platform_tenant_defaults is the source of
// truth. A synchronous in-memory cache (seeded from the env at module load,
// refreshed by load/save) lets every existing TENANT_* consumer — quota/limit
// builders, capability YAML generators — read the current defaults without
// threading a promise through, and keeps behaviour without a DB row identical
// to the pre-DB era.
//
// NOT covered here (deliberately): the VAP-pinned chart values — the per-volume
// storage cap (tenant.storage.maxPerVolume → TENANT_MAX_PVC_SIZE) and the
// capability images. Those pin admission policies the portal can't rewrite, so
// they stay chart-owned hard caps.

import { pool } from './projects';
import {
  TENANT_MAX_MEMORY, TENANT_MAX_MEMORY_REQUESTS, TENANT_MAX_MEMORY_PER_CONTAINER,
  TENANT_DEFAULT_MEMORY, TENANT_DEFAULT_MEMORY_REQUEST,
  TENANT_MAX_CPU, TENANT_MAX_CPU_REQUESTS, TENANT_MAX_CPU_PER_CONTAINER,
  TENANT_DEFAULT_CPU, TENANT_DEFAULT_CPU_REQUEST,
  TENANT_MAX_STORAGE, TENANT_DEFAULT_STORAGE, TENANT_MAX_PVC_SIZE,
  TENANT_MAX_PODS, TENANT_MAX_PVCS,
  isQuantity, isCount, quantityToNumber,
} from './platform-config';
import type { TenantResourceOverrides } from './k8s';

// Every operator-tunable per-project knob, fully resolved (no field optional).
// Key names match TenantResourceOverrides so an override record can be laid
// over a defaults record directly. `defaultStorage` is the size each capability
// data volume (Postgres/Garage PVC) is provisioned at.
export interface TenantDefaults {
  // memory: ResourceQuota totals + LimitRange per-container bounds/defaults
  max: string;
  maxRequests: string;
  maxPerContainer: string;
  default: string;
  defaultRequest: string;
  // cpu: same shape
  cpuMax: string;
  cpuMaxRequests: string;
  cpuMaxPerContainer: string;
  cpuDefault: string;
  cpuDefaultRequest: string;
  // storage + object counts
  maxStorage: string;
  defaultStorage: string;
  maxPods: string;
  maxPvcs: string;
}

// Field kinds, used for validation on load (a persisted row is operator data,
// but a bad value must never reach a k8s API object) and by the admin routes.
const QUANTITY_KEYS = [
  'max', 'maxRequests', 'maxPerContainer', 'default', 'defaultRequest',
  'cpuMax', 'cpuMaxRequests', 'cpuMaxPerContainer', 'cpuDefault', 'cpuDefaultRequest',
  'maxStorage', 'defaultStorage',
] as const;
const COUNT_KEYS = ['maxPods', 'maxPvcs'] as const;
export const TENANT_DEFAULT_KEYS = [...QUANTITY_KEYS, ...COUNT_KEYS] as const;
export type TenantDefaultKey = (typeof TENANT_DEFAULT_KEYS)[number];

function isValidValue(key: TenantDefaultKey, v: unknown): v is string {
  return (COUNT_KEYS as readonly string[]).includes(key) ? isCount(v as any) : isQuantity(v as any);
}

// The chart seed: exactly the values the env-parsed TENANT_* constants carry,
// so a deployment that never opens /admin/resources behaves identically to one
// running the pre-DB portal.
export const CHART_TENANT_DEFAULTS: TenantDefaults = {
  max: TENANT_MAX_MEMORY,
  maxRequests: TENANT_MAX_MEMORY_REQUESTS,
  maxPerContainer: TENANT_MAX_MEMORY_PER_CONTAINER,
  default: TENANT_DEFAULT_MEMORY,
  defaultRequest: TENANT_DEFAULT_MEMORY_REQUEST,
  cpuMax: TENANT_MAX_CPU,
  cpuMaxRequests: TENANT_MAX_CPU_REQUESTS,
  cpuMaxPerContainer: TENANT_MAX_CPU_PER_CONTAINER,
  cpuDefault: TENANT_DEFAULT_CPU,
  cpuDefaultRequest: TENANT_DEFAULT_CPU_REQUEST,
  maxStorage: TENANT_MAX_STORAGE,
  defaultStorage: TENANT_DEFAULT_STORAGE,
  maxPods: TENANT_MAX_PODS,
  maxPvcs: TENANT_MAX_PVCS,
};

export interface TenantDefaultsRecord {
  config: TenantDefaults;
  updatedAt: string | null;
  updatedBy: string | null;
  // false until an admin saves — the form then shows the chart seed.
  persisted: boolean;
}

// In-memory cache backing the synchronous tenantDefaults() getter. Seeded from
// the env at module load so every consumer works before (or without) the DB
// row; index.ts refreshes it from the DB right after migrate().
let cached: TenantDefaultsRecord = {
  config: { ...CHART_TENANT_DEFAULTS }, updatedAt: null, updatedBy: null, persisted: false,
};

// The current platform defaults (chart seed until a row is loaded/saved).
// Synchronous by design — see the cache note above.
export function tenantDefaults(): TenantDefaults {
  return cached.config;
}

// Defensive merge for a persisted row: only known keys carrying a valid
// quantity/count are taken; anything else (a row written before a field
// existed, or a hand-edited bad value) falls back to the chart seed.
function mergeWithChartSeed(c: Partial<TenantDefaults> | null | undefined): TenantDefaults {
  const out = { ...CHART_TENANT_DEFAULTS };
  for (const key of TENANT_DEFAULT_KEYS) {
    const v = (c as any)?.[key];
    if (isValidValue(key, v)) out[key] = v;
  }
  return out;
}

// Load the persisted defaults (if any), refresh the cache, and return the
// record. Called at startup and by the admin index page.
export async function loadTenantDefaults(): Promise<TenantDefaultsRecord> {
  const { rows } = await pool.query<{ config: Partial<TenantDefaults>; updated_at: Date; updated_by: string | null }>(
    'SELECT config, updated_at, updated_by FROM platform_tenant_defaults WHERE id = 1'
  );
  if (!rows.length) {
    cached = { config: { ...CHART_TENANT_DEFAULTS }, updatedAt: null, updatedBy: null, persisted: false };
  } else {
    cached = {
      config: mergeWithChartSeed(rows[0].config),
      updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
      updatedBy: rows[0].updated_by,
      persisted: true,
    };
  }
  return cached;
}

export async function saveTenantDefaults(config: TenantDefaults, updatedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform_tenant_defaults (id, config, updated_at, updated_by)
     VALUES (1, $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(config), updatedBy]
  );
  cached = { config: { ...config }, updatedAt: new Date().toISOString(), updatedBy, persisted: true };
}

// Resolve a project's EFFECTIVE values: platform defaults overlaid with its
// stored overrides. Overrides are up-only relative to the CURRENT defaults, so
// a stored override that a later defaults raise has overtaken is ignored (the
// higher default wins) — the invariant "no project below the platform floor"
// holds even when defaults move after the override was written. Values are
// re-validated on the way in (jsonb is operator data, but nothing unvalidated
// may reach a k8s API object).
export function effectiveForProject(
  overrides: TenantResourceOverrides | Record<string, string> | null | undefined,
): TenantDefaults {
  const out = { ...tenantDefaults() };
  if (!overrides) return out;
  for (const key of TENANT_DEFAULT_KEYS) {
    const v = (overrides as Record<string, unknown>)[key];
    if (!isValidValue(key, v)) continue;
    if (quantityToNumber(v) < quantityToNumber(out[key])) continue; // up-only
    out[key] = v;
  }
  return out;
}

// ── Cross-field validation ──────────────────────────────────────────────────

export class TenantDefaultsError extends Error {}

// Enforce the relationships between fields that individually-valid quantities
// can still violate. Applied to the platform defaults on save AND to a
// project's effective values (defaults ⊕ overrides), so a per-project bump
// can't create an internally inconsistent quota either.
export function validateTenantDefaults(v: TenantDefaults): void {
  const n = quantityToNumber;
  const rules: Array<[boolean, string]> = [
    [n(v.maxRequests) <= n(v.max),
      `Memory request budget (${v.maxRequests}) must not exceed max memory (${v.max}).`],
    [n(v.defaultRequest) <= n(v.default),
      `Default memory request (${v.defaultRequest}) must not exceed the default memory limit (${v.default}).`],
    [n(v.default) <= n(v.maxPerContainer),
      `Default memory limit (${v.default}) must not exceed the per-container memory ceiling (${v.maxPerContainer}).`],
    [n(v.maxPerContainer) <= n(v.max),
      `Per-container memory ceiling (${v.maxPerContainer}) must not exceed max memory (${v.max}).`],
    [n(v.cpuMaxRequests) <= n(v.cpuMax),
      `CPU request budget (${v.cpuMaxRequests}) must not exceed max CPU (${v.cpuMax}).`],
    [n(v.cpuDefaultRequest) <= n(v.cpuDefault),
      `Default CPU request (${v.cpuDefaultRequest}) must not exceed the default CPU limit (${v.cpuDefault}).`],
    [n(v.cpuDefault) <= n(v.cpuMaxPerContainer),
      `Default CPU limit (${v.cpuDefault}) must not exceed the per-container CPU ceiling (${v.cpuMaxPerContainer}).`],
    [n(v.cpuMaxPerContainer) <= n(v.cpuMax),
      `Per-container CPU ceiling (${v.cpuMaxPerContainer}) must not exceed max CPU (${v.cpuMax}).`],
    // The chart-owned per-volume admission cap: provisioning a data volume
    // larger than the cv-projects-*-bounds VAPs allow would be rejected at
    // admission, so refuse the default up front.
    [n(v.defaultStorage) <= n(TENANT_MAX_PVC_SIZE),
      `Data volume size (${v.defaultStorage}) exceeds the chart's per-volume cap of ${TENANT_MAX_PVC_SIZE} (tenant.storage.maxPerVolume) — admission would reject the PVC.`],
    // Every capability data volume is a PVC; the platform manages two
    // (Postgres + Garage), so a lower PVC count bricks capability enables.
    [Number(v.maxPvcs) >= 2,
      `Max PersistentVolumeClaims (${v.maxPvcs}) must be at least 2 — the platform's Postgres and Garage data volumes are PVCs.`],
  ];
  for (const [ok, message] of rules) {
    if (!ok) throw new TenantDefaultsError(message);
  }
}

// ── Audit trail ─────────────────────────────────────────────────────────────
//
// Every defaults save, per-project save/clear, and apply-all sweep appends a
// row to cv_resource_audit (scope 'defaults' or the project slug). Best-effort
// by design: the change has already been persisted/applied when this runs, so
// an audit-insert hiccup is logged rather than failing the admin's request —
// the console.log the routes emit remains the fallback record.

export interface ResourceAuditEntry {
  actorEmail: string;
  scope: string;
  change: Record<string, unknown>;
  createdAt: string;
}

export async function recordResourceAudit(
  actorEmail: string, scope: string, change: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO cv_resource_audit (actor_email, scope, change) VALUES ($1, $2, $3)',
      [actorEmail, scope, JSON.stringify(change)]
    );
  } catch (err: any) {
    console.error(`[resources] audit insert failed (scope=${scope}):`, err?.message);
  }
}

// Most recent audit entries for a scope, newest first.
export async function listResourceAudit(scope: string, limit = 10): Promise<ResourceAuditEntry[]> {
  const { rows } = await pool.query<{ actor_email: string; scope: string; change: Record<string, unknown>; created_at: Date }>(
    'SELECT actor_email, scope, change, created_at FROM cv_resource_audit WHERE scope = $1 ORDER BY created_at DESC LIMIT $2',
    [scope, limit]
  );
  return rows.map((r) => ({
    actorEmail: r.actor_email,
    scope: r.scope,
    change: r.change ?? {},
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  }));
}
