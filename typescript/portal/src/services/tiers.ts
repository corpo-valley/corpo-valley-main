export const TIERS = ['EVERYONE', 'BETA', 'ALPHA', 'ADMIN'] as const;
export type Tier = (typeof TIERS)[number];

export function tierLevel(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function hasAccess(userTier: Tier, requiredTier: Tier): boolean {
  return tierLevel(userTier) >= tierLevel(requiredTier);
}

export function highestTier(tiers: Tier[]): Tier {
  if (tiers.length === 0) return 'EVERYONE';
  return tiers.reduce((max, t) => (tierLevel(t) > tierLevel(max) ? t : max));
}

export function isTier(value: string): value is Tier {
  return TIERS.includes(value as Tier);
}
