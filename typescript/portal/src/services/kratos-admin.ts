import { Configuration, IdentityApi, Identity } from '@ory/client';

const kratosAdminUrl = process.env.KRATOS_ADMIN_URL || 'http://localhost:4434';

const identityApi = new IdentityApi(
  new Configuration({ basePath: kratosAdminUrl })
);

export interface IdentityTraits {
  email: string;
  preferred_username?: string;
  name?: { first?: string; last?: string };
}

export async function listIdentities(
  page: number = 0,
  pageSize: number = 25
): Promise<{ identities: Identity[]; hasMore: boolean }> {
  const { data } = await identityApi.listIdentities({
    pageSize,
    page,
  });
  return {
    identities: data,
    hasMore: data.length === pageSize,
  };
}

export async function getIdentity(id: string): Promise<Identity> {
  const { data } = await identityApi.getIdentity({ id });
  return data;
}

export async function createIdentity(traits: IdentityTraits): Promise<Identity> {
  const { data } = await identityApi.createIdentity({
    createIdentityBody: {
      schema_id: 'person',
      traits,
    },
  });
  return data;
}

export async function updateIdentityTraits(
  id: string,
  traits: IdentityTraits
): Promise<Identity> {
  // Patch only the traits field; everything else stays as-is.
  const { data } = await identityApi.patchIdentity({
    id,
    jsonPatch: [{ op: 'replace', path: '/traits', value: traits }],
  });
  return data;
}

export interface RecoveryCode {
  recovery_code: string;
  recovery_link: string;
  expires_at: string;
}

// Domain used for synthetic bot email addresses. The bot inbox doesn't
// receive mail; we only need a unique email-shaped string Kratos accepts as
// the password-method identifier. Override with BOT_EMAIL_DOMAIN env var.
const BOT_EMAIL_DOMAIN = process.env.BOT_EMAIL_DOMAIN || 'bot.corpo-valley.com';

function deriveBotUsername(human: Identity): string | null {
  const traits = (human.traits ?? {}) as any;
  if (traits.preferred_username) return `${traits.preferred_username}.bot`;
  if (traits.email && traits.email.includes('@')) {
    return `${traits.email.split('@')[0]}.bot`;
  }
  return null;
}

// Parse the next-page cursor out of Kratos's RFC 5988 `Link` header
// (`<…?page_token=…>; rel="next"`). Absent on the last page → undefined.
function nextIdentitiesPageToken(linkHeader: unknown): string | undefined {
  if (typeof linkHeader !== 'string' || !linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!m) continue;
    try {
      const tok = new URL(m[1], 'http://x').searchParams.get('page_token');
      if (tok) return tok;
    } catch { /* malformed Link entry — skip */ }
  }
  return undefined;
}

// Look up an existing identity by email. Kratos has no direct email lookup, so
// we page through identities and filter. Follow the cursor to completion so a
// match beyond the first page — e.g. a squatter on `<victim>.bot@…` sorted past
// the first 250 identities — is still found (the bot-ownership backstop in
// ensureBotForHuman relies on this pre-check seeing the collision).
async function findIdentityByEmail(email: string): Promise<Identity | null> {
  const target = email.toLowerCase();
  let pageToken: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const resp = await identityApi.listIdentities({ pageSize: 250, pageToken });
    const hit = resp.data.find(
      (i) => ((i.traits as any) ?? {}).email?.toLowerCase() === target,
    );
    if (hit) return hit;
    const next = nextIdentitiesPageToken((resp.headers as Record<string, unknown> | undefined)?.link);
    if (!next) break;
    pageToken = next;
  }
  return null;
}

// Idempotently provision a `<username>.bot` companion identity for a human.
// Returns the bot identity (existing or newly created), or null if we can't
// derive a username (e.g., the human has neither preferred_username nor a
// usable email). The bot has no credentials — it can't sign in via password.
// Only adopt an existing identity as this human's bot if it is actually tagged
// as a bot owned by this human. Otherwise (e.g. someone self-registered the
// `<victim>.bot` username/email to squat the mapping) refuse — we must never
// hand bot provisioning to an identity we didn't create for this human.
function isBotOwnedBy(identity: Identity, humanId: string): boolean {
  const meta = (identity.metadata_public ?? {}) as Record<string, any>;
  return meta.type === 'bot' && meta.human_id === humanId;
}

export async function ensureBotForHuman(human: Identity): Promise<Identity | null> {
  const botUsername = deriveBotUsername(human);
  if (!botUsername) return null;

  const botEmail = `${botUsername}@${BOT_EMAIL_DOMAIN}`;

  const existing = await findIdentityByEmail(botEmail);
  if (existing) {
    if (isBotOwnedBy(existing, human.id)) return existing;
    console.error('[kratos-admin] bot collision: an identity already holds', botEmail, 'but it is not this human\'s bot — refusing to adopt.');
    return null;
  }

  const humanTraits = (human.traits ?? {}) as any;
  const traits: IdentityTraits = {
    email: botEmail,
    preferred_username: botUsername,
  };
  if (humanTraits.name) {
    traits.name = humanTraits.name;
  }

  try {
    const { data } = await identityApi.createIdentity({
      createIdentityBody: {
        schema_id: 'person',
        traits,
        metadata_public: { type: 'bot', human_id: human.id },
      },
    });
    return data;
  } catch (err: any) {
    // Race or squat: another identity already holds this username/email. Only
    // return it if it is genuinely this human's bot; otherwise refuse.
    if (err?.response?.status === 409) {
      const found = await findIdentityByEmail(botEmail);
      if (found && isBotOwnedBy(found, human.id)) return found;
      console.error('[kratos-admin] bot username/email', botUsername, 'is taken by a non-bot identity — refusing to adopt.');
      return null;
    }
    throw err;
  }
}

// Issues a one-time recovery code an admin can hand to the user. Kratos
// also returns a self-service recovery URL the user can visit directly.
export async function createRecoveryCodeForIdentity(
  identityId: string,
  expiresIn: string = '1h'
): Promise<RecoveryCode> {
  const { data } = await identityApi.createRecoveryCodeForIdentity({
    createRecoveryCodeForIdentityBody: {
      identity_id: identityId,
      expires_in: expiresIn,
    },
  });
  return {
    recovery_code: data.recovery_code,
    recovery_link: data.recovery_link,
    expires_at: data.expires_at ?? '',
  };
}
