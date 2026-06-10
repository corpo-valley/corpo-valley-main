import { Configuration, OAuth2Api, OAuth2Client } from '@ory/client';
import crypto from 'crypto';

const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';

const hydra = new OAuth2Api(
  new Configuration({ basePath: hydraAdminUrl })
);

// Metadata tag value identifying platform API keys (vs. first-party OIDC
// service clients). A user's keys are filtered by `type === API_KEY_TYPE`
// + `owner_id === <kratos-id>`.
export const API_KEY_TYPE = 'api-key';

// Parse the cursor for the next page out of Hydra's RFC 5988 `Link` header.
// Hydra paginates clients with a cursor it returns as `page_token` in a
// `Link: <…?page_token=…>; rel="next"` entry; the entry is absent on the last
// page. Returns the token, or undefined when there is no next page.
function nextPageToken(linkHeader: unknown): string | undefined {
  if (typeof linkHeader !== 'string' || !linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!m) continue;
    try {
      // Base URL only matters for parsing relative hrefs; the query is what we want.
      const tok = new URL(m[1], 'http://x').searchParams.get('page_token');
      if (tok) return tok;
    } catch { /* malformed Link entry — skip */ }
  }
  return undefined;
}

// List ALL OAuth2 clients, following Hydra's cursor pagination to completion.
// listUserApiKeys filters this set client-side, so a single 250-client page
// would silently hide a user's keys (and their revoke buttons) once the
// platform-wide client population grows past one page. Iterate until there is
// no `rel="next"`, with a hard cap as an anti-runaway backstop.
export async function listClients(): Promise<OAuth2Client[]> {
  const PAGE_SIZE = 250;
  const MAX_PAGES = 1000; // backstop: 250k clients before we stop following links
  const all: OAuth2Client[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await hydra.listOAuth2Clients({ pageSize: PAGE_SIZE, pageToken });
    all.push(...resp.data);
    const next = nextPageToken((resp.headers as Record<string, unknown> | undefined)?.link);
    if (!next) break;
    pageToken = next;
  }
  return all;
}

export async function getClient(id: string): Promise<OAuth2Client> {
  const { data } = await hydra.getOAuth2Client({ id });
  return data;
}

export async function createClient(opts: {
  id: string;
  name: string;
  tier: string;
  redirectUris?: string[];
  grantTypes?: string[];
  metadata?: Record<string, string>;
}): Promise<{ client: OAuth2Client; secret: string }> {
  const secret = crypto.randomBytes(32).toString('hex');
  const { data } = await hydra.createOAuth2Client({
    oAuth2Client: {
      client_id: opts.id,
      client_name: opts.name,
      client_secret: secret,
      grant_types: opts.grantTypes || ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile email',
      redirect_uris: opts.redirectUris || [],
      token_endpoint_auth_method: 'client_secret_post',
      metadata: { tier: opts.tier, ...opts.metadata },
    },
  });
  return { client: data, secret };
}

export async function deleteClient(id: string): Promise<void> {
  await hydra.deleteOAuth2Client({ id });
}

export async function updateClientMetadata(
  id: string,
  metadata: Record<string, string>
): Promise<void> {
  const existing = await getClient(id);
  await hydra.setOAuth2Client({
    id,
    oAuth2Client: {
      ...existing,
      metadata: { ...(existing.metadata as Record<string, string> || {}), ...metadata },
    },
  });
}

export function getClientTier(client: OAuth2Client): string {
  const meta = client.metadata as Record<string, string> | undefined;
  return meta?.tier || 'EVERYONE';
}

// ── Generic platform API keys ──────────────────────────────
// API keys are Hydra OAuth2 clients using the client_credentials grant.
// They are platform-wide (not per-downstream-service): a holder exchanges
// client_id + client_secret for a token at HYDRA_PUBLIC_URL and uses it
// against any platform API. We tag them with metadata
// `{ owner_id, type: "api-key" }` so a user's keys can be listed/owned-checked.

export async function createApiKey(
  ownerId: string
): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = `cvkey-${ownerId.slice(0, 8)}-${Date.now()}`;
  const secret = crypto.randomBytes(32).toString('hex');
  await hydra.createOAuth2Client({
    oAuth2Client: {
      client_id: clientId,
      client_name: `API Key (${ownerId.slice(0, 8)})`,
      client_secret: secret,
      grant_types: ['client_credentials'],
      response_types: [],
      scope: 'openid',
      token_endpoint_auth_method: 'client_secret_post',
      metadata: { owner_id: ownerId, type: API_KEY_TYPE },
    },
  });
  return { clientId, clientSecret: secret };
}

export async function listUserApiKeys(ownerId: string): Promise<OAuth2Client[]> {
  const all = await listClients();
  return all.filter((c) => {
    const meta = c.metadata as Record<string, string> | undefined;
    return meta?.owner_id === ownerId && meta?.type === API_KEY_TYPE;
  });
}

export async function isKeyOwnedBy(clientId: string, ownerId: string): Promise<boolean> {
  try {
    const client = await getClient(clientId);
    const meta = client.metadata as Record<string, string> | undefined;
    return meta?.owner_id === ownerId && meta?.type === API_KEY_TYPE;
  } catch {
    return false;
  }
}
