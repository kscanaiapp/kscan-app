/**
 * Free Tier Utility Expansion — feature flags.
 *
 * Every flag defaults to FALSE and can only be enabled via env/config
 * (EXPO_PUBLIC_*). Nothing in this layer changes default app behavior
 * unless FREE_TIER_UTILITY_ENABLED is explicitly turned on.
 *
 * Branch: feature/free-tier-utility-expansion-v1
 */

const isTrue = (value?: string): boolean => value === 'true';

/** Master switch. All free-tier utility UI is mounted only when this is true. */
export const FREE_TIER_UTILITY_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED
);

export const FREE_TIER_OUTFIT_GENERATOR_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_OUTFIT_GENERATOR_ENABLED
);

export const FREE_TIER_DAILY_STYLE_PROMPT_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_DAILY_STYLE_PROMPT_ENABLED
);

export const FREE_TIER_WARDROBE_STATS_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_WARDROBE_STATS_ENABLED
);

export const FREE_TIER_SHARE_CARD_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_SHARE_CARD_ENABLED
);

export const FREE_TIER_COLLECTIONS_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_COLLECTIONS_ENABLED
);

export const FREE_TIER_DUPLICATE_HINTS_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_DUPLICATE_HINTS_ENABLED
);

export const FREE_TIER_BRAND_SIZING_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_BRAND_SIZING_ENABLED
);

export const FREE_TIER_OUTFIT_RATING_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_OUTFIT_RATING_ENABLED
);

export const FREE_TIER_CARE_NOTES_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_CARE_NOTES_ENABLED
);

export const FREE_TIER_COST_PER_WEAR_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_COST_PER_WEAR_ENABLED
);

export const FREE_TIER_WISHLIST_INTENT_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_WISHLIST_INTENT_ENABLED
);

export const FREE_TIER_CLOSET_FILTERS_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_CLOSET_FILTERS_ENABLED
);

export const FREE_TIER_WEAR_AGAIN_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_WEAR_AGAIN_ENABLED
);

export const FREE_TIER_ACTIVITY_LOG_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_ACTIVITY_LOG_ENABLED
);

export const FREE_TIER_STYLE_CHALLENGES_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_STYLE_CHALLENGES_ENABLED
);

/**
 * Convenience guard: a sub-feature is live only when both the master switch
 * and its own flag are enabled.
 */
export function isFreeTierFeatureEnabled(subFlag: boolean): boolean {
  return FREE_TIER_UTILITY_ENABLED && subFlag;
}
