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

// Look up an existing identity by email. Kratos has no direct email lookup,
// so we list identities and filter. Cheap enough at this scale.
async function findIdentityByEmail(email: string): Promise<Identity | null> {
  // listIdentities returns 250 max per page; for now we just pull the first
  // page since we have < 100 users. Paginate if this grows.
  const { data } = await identityApi.listIdentities({ pageSize: 250 });
  return (
    data.find(
      (i) =>
        ((i.traits as any) ?? {}).email?.toLowerCase() === email.toLowerCase(),
    ) ?? null
  );
}

// Idempotently provision a `<username>.bot` companion identity for a human.
// Returns the bot identity (existing or newly created), or null if we can't
// derive a username (e.g., the human has neither preferred_username nor a
// usable email). The bot has no credentials — it can't sign in via password.
export async function ensureBotForHuman(human: Identity): Promise<Identity | null> {
  const botUsername = deriveBotUsername(human);
  if (!botUsername) return null;

  const botEmail = `${botUsername}@${BOT_EMAIL_DOMAIN}`;

  const existing = await findIdentityByEmail(botEmail);
  if (existing) return existing;

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
    // Race: another caller created it between findIdentityByEmail and now.
    if (err?.response?.status === 409) {
      return await findIdentityByEmail(botEmail);
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
