# cooldeps configuration schema (normative, language-agnostic)

This is the **canonical specification** of cooldeps' configuration, written so any
port (the Go reference, a TypeScript implementation, etc.) can be **bit-for-bit
compatible**: given the same config file and the same environment, two conformant
implementations must produce the **same gate decision** for the same package
version.

The Go reference lives in `internal/config` (file + env loader) and
`internal/policy` (the gate engine). Where this document and the code disagree,
the code is the source of truth — please file an issue so this doc can be fixed.

## Model

There is **one configuration tree** with three sections — `server`, `cache`,
`policy` — supplied as a single YAML file and layered:

```
built-in defaults   <   config file   <   environment variables
```

- The **file** is located by the `COOLDEPS_CONFIG` environment variable. If unset,
  the server runs on built-in defaults plus any env overrides.
- **Environment variables** override individual scalar fields by a mechanical
  naming convention (§3). They win over the file.

Every key is optional; an omitted key keeps the default from the layer below.
See `cooldeps.example.yaml` for a fully-commented file at its defaults.

---

## 1. The config file

```yaml
server:   { ... }   # how the proxy runs and what it proxies to
cache:    { ... }   # storage + freshness tuning
policy:   { ... }   # the gate (cooldown / license / cve / overrides)
```

### 1.1 `server`

| Field | Type (§4) | Default | Constraint | Meaning |
|---|---|---|---|---|
| `addr` | string | `:8080` | `host:port`, port required | TCP listen address. |
| `statusEnabled` | boolean | `false` | — | Expose `GET /status` (version + counters); `404` when false. |
| `logLevel` | enum | `info` | `debug`\|`info`\|`warn`\|`error` | Log verbosity. |
| `npmUpstream` | URL | `https://registry.npmjs.org` | absolute `http(s)` + host | npm origin. |
| `pypiUpstream` | URL | `https://pypi.org` | absolute `http(s)` + host | PyPI origin. |
| `goUpstream` | URL | `https://proxy.golang.org` | absolute `http(s)` + host | Go module proxy origin. |
| `publicURL` | URL | _(derived from request)_ | absolute `http(s)` + host (when set) | Base used to rewrite npm tarball URLs back through the proxy. |

### 1.2 `cache`

| Field | Type | Default | Constraint | Meaning |
|---|---|---|---|---|
| `dataDir` | path | `/data` | — | Root for the metadata DB and artifact cache. |
| `artifacts` | boolean | `true` | — | Enable the on-disk artifact cache. |
| `artifactDir` | path | `<dataDir>/artifacts` | — | Override the artifact cache directory. |
| `artifactMaxBytes` | size | `40GiB` | `>= 1` when `artifacts` | LRU cap for the artifact cache. |
| `vulnTTL` | duration | `6h` | `>= 0` | How long an OSV/CVE result is cached before re-query. §7.4. |
| `metaTTL` | duration | `0` | `>= 0` | Re-fetch *found* metadata after this (license drift). `0` = forever. §7.4. |
| `metaNotFoundRefresh` | duration | `30m` | `>= 0` | How long a "not known upstream yet" record is trusted before re-checking. §7.4. |
| `fetchConcurrency` | integer | `8` | `>= 1` | Max concurrent upstream fetches per request. |

### 1.3 `policy`

```yaml
policy:
  license:
    allow: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC]  # SPDX ids; empty => allow anything not blocked
    block: [GPL-3.0, AGPL-3.0]
    warnOnUnknown: true        # unknown/missing license => warn (not block)
  releaseAge:
    minDays: 14                # the cooldown window; 0 disables the check
    warnOnly: false            # true => warn instead of block when too fresh
    blockOnUnknown: false      # true => block versions with no known release date
  cve:
    maxSeverity: HIGH          # block when a vuln >= this band; "" disables CVE checks
    warnOnly: false            # true => warn instead of block
    fetchSeverity: true        # resolve CVSS/GHSA bands for advisories with hits
  failOpen: false              # external APIs unreachable => false: BLOCK, true: WARN/allow
  overrides:
    allow: []                  # pin exact packages to ALLOW (bypass the gate)
    block: []                  # pin exact packages to BLOCK (incident response)
```

| Path | Type | Default | Notes |
|---|---|---|---|
| `license.allow` | string[] | `[MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC]` | SPDX ids. **Empty ⇒ allow anything not in `block`** (blocklist-only mode). |
| `license.block` | string[] | `[GPL-3.0, AGPL-3.0]` | Deny list; checked even if also in `allow`. |
| `license.warnOnUnknown` | boolean | `true` | No license reported: `true` ⇒ warn, `false` ⇒ no opinion. |
| `releaseAge.minDays` | integer | `14` | `>= 0`. Versions younger than this are blocked. **`0` disables the cooldown** (incl. unknown-date handling). |
| `releaseAge.warnOnly` | boolean | `false` | `true` ⇒ a too-fresh version warns instead of blocks. |
| `releaseAge.blockOnUnknown` | boolean | `false` | `true` ⇒ block when no release date is known. |
| `cve.maxSeverity` | enum | `HIGH` | `NONE`/`LOW`/`MEDIUM`/`HIGH`/`CRITICAL` (case-insensitive; `MODERATE`=`MEDIUM`). **`""` disables CVE checks** (and skips OSV lookups). |
| `cve.warnOnly` | boolean | `false` | `true` ⇒ an offending CVE warns instead of blocks. |
| `cve.fetchSeverity` | boolean | `true` | `false` ⇒ skip CVSS resolution; every advisory counts as `Unknown` (fail-safe, §4.7). |
| `failOpen` | boolean | `false` | Behavior when deps.dev/OSV are unreachable. §7.3. |
| `overrides.allow` | pin[] | `[]` | Pins forced to ALLOW. §6. |
| `overrides.block` | pin[] | `[]` | Pins forced to BLOCK. §6. |

---

## 2. Disabling / loosening checks (common recipes)

Because the file overlays the defaults, you must set these **explicitly** —
omitting a key keeps the stricter default.

| Goal | Setting |
|---|---|
| Block only specific licenses, allow the rest | `license.allow: []` + `license.block: [...]` |
| No license gating at all | `license: { allow: [], block: [], warnOnUnknown: false }` |
| No CVE blocking | `cve.maxSeverity: ""` |
| No cooldown blocking | `releaseAge.minDays: 0` |
| Never auto-block (also survive API outages) | all of the above + `failOpen: true` |

`overrides.block` pins still block regardless — that's the intended
incident-response path.

---

## 3. Environment overrides (REQUIRED convention)

Any **scalar** field is overridable by an environment variable whose name encodes
its path:

```
COOLDEPS_<SECTION>_<FIELD>            COOLDEPS_SERVER_ADDR, COOLDEPS_CACHE_METATTL
COOLDEPS_POLICY_<SUBSECTION>_<FIELD>  COOLDEPS_POLICY_CVE_MAXSEVERITY
COOLDEPS_POLICY_<FIELD>              COOLDEPS_POLICY_FAILOPEN
```

The path segments are the YAML keys **uppercased** with no other transformation
(`metaTTL` → `METATTL`, `npmUpstream` → `NPMUPSTREAM`). A variable parses with the
**same grammar** as the file field it targets (§4). An **empty** value means
"unset" (use the file/default), so env cannot set a field to the empty string —
notably, `cve.maxSeverity: ""` (disable CVE) must be done in the file.

**List fields are file-only** (`license.allow`/`block`, `overrides.allow`/`block`)
— there is no env form.

Complete list of override variables:

```
COOLDEPS_SERVER_ADDR            COOLDEPS_CACHE_DATADIR             COOLDEPS_POLICY_FAILOPEN
COOLDEPS_SERVER_STATUSENABLED   COOLDEPS_CACHE_ARTIFACTS           COOLDEPS_POLICY_LICENSE_WARNONUNKNOWN
COOLDEPS_SERVER_LOGLEVEL        COOLDEPS_CACHE_ARTIFACTDIR         COOLDEPS_POLICY_RELEASEAGE_MINDAYS
COOLDEPS_SERVER_NPMUPSTREAM     COOLDEPS_CACHE_ARTIFACTMAXBYTES    COOLDEPS_POLICY_RELEASEAGE_WARNONLY
COOLDEPS_SERVER_PYPIUPSTREAM    COOLDEPS_CACHE_VULNTTL             COOLDEPS_POLICY_RELEASEAGE_BLOCKONUNKNOWN
COOLDEPS_SERVER_GOUPSTREAM      COOLDEPS_CACHE_METATTL             COOLDEPS_POLICY_CVE_MAXSEVERITY
COOLDEPS_SERVER_PUBLICURL       COOLDEPS_CACHE_METANOTFOUNDREFRESH COOLDEPS_POLICY_CVE_WARNONLY
                                COOLDEPS_CACHE_FETCHCONCURRENCY    COOLDEPS_POLICY_CVE_FETCHSEVERITY
```

> A port MAY derive these names mechanically from its config struct rather than
> hard-coding them, but the resulting names MUST match this list exactly.

---

## 4. Value grammars (shared, REQUIRED)

These types must parse identically across ports and across the file/env layers.
They follow the Go reference's parsers; reimplement them rather than assuming the
host language's native parsing matches.

### 4.1 boolean
Accepted (matching Go's `strconv.ParseBool`):
`1`, `t`, `T`, `TRUE`, `true`, `True` ⇒ **true**;
`0`, `f`, `F`, `FALSE`, `false`, `False` ⇒ **false**. Anything else is malformed.

### 4.2 integer
Base-10 signed integer. Range checks happen in validation, not parsing.

### 4.3 duration
Go `time.ParseDuration` syntax: a possibly-signed decimal with a required unit,
chainable. Units: `ns`, `us` (`µs`), `ms`, `s`, `m`, `h`. Examples: `6h`, `30m`,
`90s`, `1.5h`, `2h45m`, `0`. In YAML, write it as a string/scalar — it is **not**
a raw number of nanoseconds.

### 4.4 size (bytes)
A decimal (optionally fractional) with an **optional, case-insensitive** unit:

| Suffix | Multiplier | | Suffix | Multiplier |
|---|---|---|---|---|
| _(none)_ | 1 | | `KiB`/`MiB`/`GiB`/`TiB` | 2^10 / 2^20 / 2^30 / 2^40 |
| `KB`/`MB`/`GB`/`TB` | 1e3 / 1e6 / 1e9 / 1e12 | | | |

Result truncated to whole bytes. Examples: `40GiB`, `500MB`, `1.5GiB`, `1048576`.

### 4.5 URL
Absolute URL, scheme `http` or `https`, non-empty host.

### 4.6 SPDX license id / expression
Matched against `allow`/`block` as an SPDX id or simple expression (`OR`/`AND` +
parens; `WITH <exception>` judged by the base id). The reference uses a
simplified evaluator, not a full SPDX parser; match it for single ids, `A OR B`,
`(A AND B) OR C`.

### 4.7 severity band
Ordered, worst-last: `NONE` < `LOW` < `MEDIUM` < `HIGH` < `CRITICAL` < **`Unknown`**.
Parsed case-insensitively; `MODERATE` = `MEDIUM`. Any unrecognized value (incl. an
empty severity on a *vuln record*) is `Unknown`, which sorts **above CRITICAL** so
an unscored advisory is always at least as bad as the threshold (fail-safe).

---

## 5. Load & validation behavior (REQUIRED)

A conformant port MUST:

1. **Layer** defaults → file (if `COOLDEPS_CONFIG` set) → env, in that order.
2. **Overlay, not replace.** A partial file changes only the keys it specifies;
   an env override changes only its one field.
3. **Reject unknown keys** in the file (a typo like `cache.vulnTTLL` must error,
   not silently leave the default). The Go reference uses YAML strict decoding.
4. **Fail loud on malformed values.** A file field or env var that doesn't parse
   for its type is an error — never a silent fallback.
5. **Collect, then report.** Gather all malformed-value and validation errors and
   report them together.
6. **Validate** the assembled tree (the "Constraint" columns + `policy` rules in
   §6.1) and treat any violation as fatal.
7. **Exit non-zero without serving** on any error.

An **empty string** env value is treated as "unset", not malformed.

---

## 6. Override pin grammar (REQUIRED)

An override entry is a string in one of these forms (most-specific first):

| Form | Example | Matches |
|---|---|---|
| `ecosystem:name@version` | `npm:left-pad@1.3.0` | that exact version in that ecosystem |
| `ecosystem:name` | `pypi:requests` | every version of that package in that ecosystem |
| `name@version` | `left-pad@1.3.0` | that version in **any** ecosystem |
| `name` | `left-pad` | every version of that name in **any** ecosystem |

- **Ecosystem prefix** = text before the first `:`, matched case-insensitively
  against `npm`, `pypi`, `go`. If it isn't one of those, there is no prefix.
- **Version** = text after the **last** `@`; a **leading** `@` is part of the name
  (scoped npm: `@types/node@1.2.3` ⇒ name `@types/node`, version `1.2.3`).
- **Names compared case-insensitively** (lowercased on both sides).
- Empty version/ecosystem means "any".

### 6.1 `policy` validation rules
- `cve.maxSeverity`, if non-empty, must be a recognized band.
- `releaseAge.minDays` must be `>= 0`.
- No override entry may be empty/blank.

---

## 7. Decision & freshness semantics (REQUIRED)

Computed per (ecosystem, name, version).

### 7.1 Decision ladder
Decisions are ordered `allow < warn < block`. Each check emits one; the final
decision is the **maximum** and **all** reasons accumulate.

### 7.2 Check semantics
- **releaseAge**: skipped entirely if `minDays <= 0`. Else if the publish date is
  known and `now − publishDate < minDays` ⇒ block (warn if `warnOnly`). If unknown
  ⇒ block iff `blockOnUnknown`, else warn.
- **license**: empty license ⇒ warn iff `warnOnUnknown` (else no opinion). A known
  license in `block` ⇒ block; with a non-empty `allow`, anything not in it ⇒ block;
  with an empty `allow`, anything not blocked passes.
- **cve**: skipped if `maxSeverity == ""`. Else any advisory `severity AtLeast
  maxSeverity` ⇒ block (warn if `warnOnly`). `Unknown` severity counts as offending.

> **Verdicts are not cached — only raw metadata is.** The releaseAge comparison
> uses `now` at evaluation, so a too-fresh version becomes allowed automatically
> once it crosses `minDays`, with no re-fetch. Recompute the decision each request.

### 7.3 Overrides & degraded mode
- **Overrides are evaluated first and win.** A matching `block` pin ⇒ block; else a
  matching `allow` pin ⇒ allow. `block` beats `allow`.
- **Degraded** (metadata APIs unreachable): honor a matching override pin if any;
  otherwise the verdict is `warn`/allow when `failOpen: true`, else `block`.

### 7.4 Cache freshness
- **Metadata, found**: cached **forever** by default (publish date is immutable).
  If `metaTTL > 0`, re-fetch once `now − fetchedAt >= metaTTL`; if that refresh
  **fails**, serve the stale row rather than degrading.
- **Metadata, not found upstream yet**: re-check once
  `now − fetchedAt >= metaNotFoundRefresh`.
- **Vuln results**: TTL `vulnTTL`; stale ⇒ re-query. A *transient* severity-lookup
  failure MUST NOT be persisted (so one OSV blip doesn't cache an over-blocking
  `Unknown`).
- **Artifacts**: immutable by URL; never time-expired, only LRU-evicted at
  `artifactMaxBytes`.

---

## 8. Conformance checklist

- [ ] layers defaults → file → env with overlay semantics (§5);
- [ ] file located via `COOLDEPS_CONFIG`; unknown keys rejected (§5);
- [ ] env overrides via the exact `COOLDEPS_*` names in §3; lists are file-only;
- [ ] boolean/integer/duration/size/URL parsed exactly per §4;
- [ ] fail-loud (collect-all, exit non-zero) on malformed/invalid config (§5);
- [ ] override pin grammar incl. scoped npm names (§6);
- [ ] decision ladder, check semantics, override precedence, degraded posture (§7.1–7.3);
- [ ] `Unknown` severity and unknown license treated fail-safe (§4.7, §7.2);
- [ ] verdicts recomputed per request; freshness rules applied (§7.4).

---

## 9. JSON Schema for the config file

Draft 2020-12. Covers structure, types, and enums; the cross-field semantics in
§7 and the duration/size string grammars (§4) are validated in code, not here.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/hashtagcyber/cooldeps/cooldeps.schema.json",
  "title": "cooldeps configuration",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "server": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "addr": { "type": "string" },
        "statusEnabled": { "type": "boolean" },
        "logLevel": { "enum": ["debug", "info", "warn", "error"] },
        "npmUpstream": { "type": "string", "format": "uri" },
        "pypiUpstream": { "type": "string", "format": "uri" },
        "goUpstream": { "type": "string", "format": "uri" },
        "publicURL": { "type": "string" }
      }
    },
    "cache": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "dataDir": { "type": "string" },
        "artifacts": { "type": "boolean" },
        "artifactDir": { "type": "string" },
        "artifactMaxBytes": { "type": ["string", "integer"], "description": "size: 40GiB, 500MB, or raw bytes" },
        "vulnTTL": { "type": "string", "description": "duration: 6h, 30m, 0" },
        "metaTTL": { "type": "string", "description": "duration; 0 = forever" },
        "metaNotFoundRefresh": { "type": "string", "description": "duration" },
        "fetchConcurrency": { "type": "integer", "minimum": 1 }
      }
    },
    "policy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "license": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "allow": { "type": "array", "items": { "type": "string" } },
            "block": { "type": "array", "items": { "type": "string" } },
            "warnOnUnknown": { "type": "boolean" }
          }
        },
        "releaseAge": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "minDays": { "type": "integer", "minimum": 0 },
            "warnOnly": { "type": "boolean" },
            "blockOnUnknown": { "type": "boolean" }
          }
        },
        "cve": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "maxSeverity": {
              "comment": "Case-insensitive in code; '' disables CVE checks.",
              "enum": ["", "NONE", "LOW", "MEDIUM", "MODERATE", "HIGH", "CRITICAL"]
            },
            "warnOnly": { "type": "boolean" },
            "fetchSeverity": { "type": "boolean" }
          }
        },
        "failOpen": { "type": "boolean" },
        "overrides": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "allow": { "type": "array", "items": { "type": "string", "minLength": 1 } },
            "block": { "type": "array", "items": { "type": "string", "minLength": 1 } }
          }
        }
      }
    }
  }
}
```
