// Runtime configuration for the optional cooldeps gating proxy, edited by an
// admin on /admin/cooldeps. The chart seeds the initial cv-cooldeps ConfigMap;
// once an admin saves, the single row in platform_cooldeps_config is the source
// of truth and we reconcile the ConfigMap (+ roll the Deployment) from it.
//
// We deliberately render only the keys an admin manages — server.statusEnabled,
// server.logLevel, and the whole policy block. server.addr and cache.dataDir
// are forced by the image's baked env (COOLDEPS_SERVER_ADDR / _CACHE_DATADIR),
// which take precedence over the file, and everything else falls back to
// cooldeps' built-in defaults. cooldeps reads its config once at startup, so a
// save patches the ConfigMap then triggers a rollout restart.

import { pool } from './projects';
import {
  COOLDEPS_ENABLED, COOLDEPS_NAMESPACE,
} from './platform-config';
import {
  k8sEnabled, k8sMergePatchNamespaced, NamespacedRef,
} from './k8s';

export type CveSeverity = '' | 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CooldepsPolicy {
  releaseAge: { minDays: number; warnOnly: boolean; blockOnUnknown: boolean };
  cve: { maxSeverity: CveSeverity; warnOnly: boolean };
  license: { allow: string[]; block: string[]; warnOnUnknown: boolean };
  failOpen: boolean;
  overrides: { allow: string[]; block: string[] };
}

export interface CooldepsConfig {
  logLevel: LogLevel;
  statusEnabled: boolean;
  policy: CooldepsPolicy;
}

export interface CooldepsConfigRecord {
  config: CooldepsConfig;
  updatedAt: string | null;
  updatedBy: string | null;
  // false until an admin saves — the form then shows built-in defaults.
  persisted: boolean;
}

// Built-in defaults — kept in lockstep with the chart's cooldeps.policy block so
// a deployment that never opens the admin page behaves identically whether the
// portal or the chart rendered the ConfigMap.
export const DEFAULT_COOLDEPS_CONFIG: CooldepsConfig = {
  logLevel: 'info',
  statusEnabled: false,
  policy: {
    releaseAge: { minDays: 14, warnOnly: false, blockOnUnknown: false },
    cve: { maxSeverity: 'HIGH', warnOnly: false },
    license: {
      allow: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'],
      block: ['GPL-3.0', 'AGPL-3.0'],
      warnOnUnknown: true,
    },
    failOpen: false,
    overrides: { allow: [], block: [] },
  },
};

export function cooldepsEnabled(): boolean {
  return COOLDEPS_ENABLED;
}

// ── Validation ─────────────────────────────────────────────────────────────
// Inputs land in a YAML file, so every free-text value is charset-restricted to
// keep an admin (or a compromised admin session) from injecting YAML structure.

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const CVE_SEVERITIES: CveSeverity[] = ['', 'NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// SPDX-ish license identifiers: letters, digits, dot, plus, hyphen.
const LICENSE_RE = /^[A-Za-z0-9.+-]{1,64}$/;
// Override pin: "[ecosystem:]name[@version]" — conservative safe charset.
const OVERRIDE_RE = /^[A-Za-z0-9._/@:+-]{1,128}$/;

export class CooldepsConfigError extends Error {}

function asInt(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CooldepsConfigError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

function asBool(v: unknown): boolean {
  // HTML checkboxes arrive as 'on'/'true' when checked, absent when not.
  return v === true || v === 'true' || v === 'on' || v === '1';
}

function cleanList(v: unknown, re: RegExp, field: string): string[] {
  // Accept a string[] (from JSON) or a newline/comma-separated textarea value.
  const raw: string[] = Array.isArray(v)
    ? v.map((x) => String(x))
    : String(v ?? '').split(/[\n,]/);
  const out: string[] = [];
  for (const item of raw) {
    const s = item.trim();
    if (!s) continue;
    if (!re.test(s)) {
      throw new CooldepsConfigError(`"${s}" is not a valid ${field} entry.`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// Build a validated config from raw form/JSON input, throwing CooldepsConfigError
// on the first bad field so the admin gets a clear message.
export function parseCooldepsConfig(input: Record<string, unknown>): CooldepsConfig {
  const logLevel = String(input.logLevel ?? 'info').trim() as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new CooldepsConfigError(`logLevel must be one of ${LOG_LEVELS.join(', ')}.`);
  }
  const maxSeverity = String(input.cveMaxSeverity ?? '').trim().toUpperCase() as CveSeverity;
  if (!CVE_SEVERITIES.includes(maxSeverity)) {
    throw new CooldepsConfigError(`CVE max severity must be one of ${CVE_SEVERITIES.filter(Boolean).join(', ')} (or empty to disable).`);
  }
  return {
    logLevel,
    statusEnabled: asBool(input.statusEnabled),
    policy: {
      releaseAge: {
        minDays: asInt(input.minDays, 'Cooldown (minDays)', 0, 3650),
        warnOnly: asBool(input.releaseAgeWarnOnly),
        blockOnUnknown: asBool(input.releaseAgeBlockOnUnknown),
      },
      cve: {
        maxSeverity,
        warnOnly: asBool(input.cveWarnOnly),
      },
      license: {
        allow: cleanList(input.licenseAllow, LICENSE_RE, 'license'),
        block: cleanList(input.licenseBlock, LICENSE_RE, 'license'),
        warnOnUnknown: asBool(input.licenseWarnOnUnknown),
      },
      failOpen: asBool(input.failOpen),
      overrides: {
        allow: cleanList(input.overridesAllow, OVERRIDE_RE, 'override pin'),
        block: cleanList(input.overridesBlock, OVERRIDE_RE, 'override pin'),
      },
    },
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export async function loadCooldepsConfig(): Promise<CooldepsConfigRecord> {
  const { rows } = await pool.query<{ config: CooldepsConfig; updated_at: string; updated_by: string | null }>(
    'SELECT config, updated_at, updated_by FROM platform_cooldeps_config WHERE id = 1'
  );
  if (!rows.length) {
    return { config: DEFAULT_COOLDEPS_CONFIG, updatedAt: null, updatedBy: null, persisted: false };
  }
  return {
    // Defensive merge so a config persisted before a field was added still loads.
    config: mergeWithDefaults(rows[0].config),
    updatedAt: rows[0].updated_at,
    updatedBy: rows[0].updated_by,
    persisted: true,
  };
}

function mergeWithDefaults(c: Partial<CooldepsConfig> | null | undefined): CooldepsConfig {
  const d = DEFAULT_COOLDEPS_CONFIG;
  const p = (c?.policy ?? {}) as Partial<CooldepsPolicy>;
  return {
    logLevel: c?.logLevel ?? d.logLevel,
    statusEnabled: c?.statusEnabled ?? d.statusEnabled,
    policy: {
      releaseAge: { ...d.policy.releaseAge, ...(p.releaseAge ?? {}) },
      cve: { ...d.policy.cve, ...(p.cve ?? {}) },
      license: { ...d.policy.license, ...(p.license ?? {}) },
      failOpen: p.failOpen ?? d.policy.failOpen,
      overrides: { ...d.policy.overrides, ...(p.overrides ?? {}) },
    },
  };
}

export async function saveCooldepsConfig(config: CooldepsConfig, updatedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform_cooldeps_config (id, config, updated_at, updated_by)
     VALUES (1, $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(config), updatedBy]
  );
}

// ── YAML render ──────────────────────────────────────────────────────────────

function yStr(s: string): string {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function yList(items: string[], indent: string): string {
  if (!items.length) return ' []';
  return '\n' + items.map((i) => `${indent}- ${yStr(i)}`).join('\n');
}

// Emit the cooldeps.yaml the ConfigMap carries. Mirrors the chart's structure
// for the keys an admin manages; the rest is left to image env + cooldeps
// defaults (see file header).
export function renderCooldepsYaml(cfg: CooldepsConfig): string {
  const p = cfg.policy;
  return [
    '# Managed by the Corpo Valley portal (/admin/cooldeps). Edits here are',
    '# overwritten on the next admin save.',
    'server:',
    `  statusEnabled: ${cfg.statusEnabled}`,
    `  logLevel: ${yStr(cfg.logLevel)}`,
    'policy:',
    '  releaseAge:',
    `    minDays: ${p.releaseAge.minDays}`,
    `    warnOnly: ${p.releaseAge.warnOnly}`,
    `    blockOnUnknown: ${p.releaseAge.blockOnUnknown}`,
    '  cve:',
    `    maxSeverity: ${yStr(p.cve.maxSeverity)}`,
    `    warnOnly: ${p.cve.warnOnly}`,
    '  license:',
    `    allow:${yList(p.license.allow, '      ')}`,
    `    block:${yList(p.license.block, '      ')}`,
    `    warnOnUnknown: ${p.license.warnOnUnknown}`,
    `  failOpen: ${p.failOpen}`,
    '  overrides:',
    `    allow:${yList(p.overrides.allow, '      ')}`,
    `    block:${yList(p.overrides.block, '      ')}`,
    '',
  ].join('\n');
}

// ── Reconcile to the cluster ──────────────────────────────────────────────────

export interface CooldepsReconcileResult {
  applied: boolean;
  restarted: boolean;
  reason?: string;
}

const CONFIGMAP_REF: NamespacedRef = { apiGroup: '', version: 'v1', plural: 'configmaps', namespace: COOLDEPS_NAMESPACE };
const DEPLOYMENT_REF: NamespacedRef = { apiGroup: 'apps', version: 'v1', plural: 'deployments', namespace: COOLDEPS_NAMESPACE };

// Overwrite the cooldeps.yaml ConfigMap key and roll the Deployment so cooldeps
// reloads. A no-op (applied:false) when cooldeps or k8s isn't wired, so the
// admin save still persists to the DB in dev.
export async function reconcileCooldepsConfig(cfg: CooldepsConfig): Promise<CooldepsReconcileResult> {
  if (!COOLDEPS_ENABLED) return { applied: false, restarted: false, reason: 'cooldeps is not enabled on this deployment' };
  if (!k8sEnabled()) return { applied: false, restarted: false, reason: 'kubernetes integration is disabled' };

  const yaml = renderCooldepsYaml(cfg);
  await k8sMergePatchNamespaced(CONFIGMAP_REF, 'cooldeps-config', {
    data: { 'cooldeps.yaml': yaml },
  });

  // Rollout restart: stamp the pod template so the Deployment rolls a new pod
  // that re-reads the config. Same idiom as `kubectl rollout restart`.
  await k8sMergePatchNamespaced(DEPLOYMENT_REF, 'cooldeps', {
    spec: { template: { metadata: { annotations: { 'corpo-valley.com/restartedAt': new Date().toISOString() } } } },
  });

  return { applied: true, restarted: true };
}
