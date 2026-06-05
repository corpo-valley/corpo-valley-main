// Project capabilities the portal can compose into a new project.
//
// A project is no longer "a template" — it's the Community Center template
// repo plus a chosen set of capability modules. Every project gets the
// website; database and MCP are optional. The capability set drives:
//   - which k8s containers/services/ingress paths the portal generates
//     (see services/manifests.ts), and
//   - whether per-project Postgres is auto-enabled (database ⇒ yes).
//
// All projects generate from the single Gitea template repo
// `corpo-valley/community-center`, which carries all three modules. Pushing
// changes to that Gitea repo is done via scripts/sync-community-center-template.sh.

export const TEMPLATE_GITEA_OWNER = process.env.GITEA_TEMPLATE_OWNER || 'corpo-valley';
export const TEMPLATE_GITEA_REPO = process.env.GITEA_TEMPLATE_REPO || 'community-center';

// The website capability is implicit and always present, so it isn't a
// toggle. The optional capabilities are the ones the user checks on.
export const OPTIONAL_CAPABILITIES = ['database', 'mcp'] as const;
export type OptionalCapability = (typeof OPTIONAL_CAPABILITIES)[number];

export interface Capabilities {
  // The website is always on; kept here so callers can pass the full set
  // around without special-casing.
  website: true;
  database: boolean;
  mcp: boolean;
  // "data/views are shared across users". Only meaningful when database or
  // mcp is on; flips per-user isolation off (CV_SHARED=true in the manifest).
  shared: boolean;
}

export interface CapabilityDef {
  // Stable key used in the API/form.
  key: OptionalCapability | 'shared';
  // Checkbox label shown to non-technical users.
  label: string;
  // One-line helper text.
  description: string;
}

// Surfaced as the project-create checkboxes (the website checkbox is shown
// checked + disabled in the UI; these are the ones the user controls).
export const CAPABILITY_CHECKBOXES: CapabilityDef[] = [
  {
    key: 'shared',
    label: 'data/views are shared across users',
    description: 'Off by default, each person only sees their own data. On, everyone shares one view.',
  },
  {
    key: 'mcp',
    label: 'users can connect to this project via MCP',
    description: 'Exposes an MCP endpoint at /mcp so agents can use this project as a tool.',
  },
];

export function defaultCapabilities(): Capabilities {
  return { website: true, database: false, mcp: false, shared: false };
}

// Parse a capability set from loose input (form body or MCP args). Accepts
// either a flat object ({ database: true, mcp: true, shared: false }) or the
// form's checkbox values (strings "on"/"true"). The website is always on.
export function parseCapabilities(input: unknown): Capabilities {
  const obj = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
  const truthy = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
  const database = truthy(obj.database);
  const mcp = truthy(obj.mcp);
  // Sharing only matters when there's user data to share.
  const shared = (database || mcp) && truthy(obj.shared);
  return { website: true, database, mcp, shared };
}

// True when the project's Deployment expects a per-project Postgres to be
// running — i.e. the database capability is on. The portal auto-enables
// Postgres on create so the Secret lands before ArgoCD first syncs.
export function requiresPostgres(caps: Capabilities): boolean {
  return caps.database;
}

// Compact list form for logging / API responses.
export function capabilityList(caps: Capabilities): string[] {
  const list = ['website'];
  if (caps.database) list.push('database');
  if (caps.mcp) list.push('mcp');
  if (caps.shared) list.push('shared');
  return list;
}
