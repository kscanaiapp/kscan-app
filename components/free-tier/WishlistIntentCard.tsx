/**
 * Free Tier Utility Expansion — wishlist / shopping intent card.
 * Intent capture only: no price tracking, retailers, or availability claims.
 */

import React from 'react';
import {
  FREE_TIER_WISHLIST_INTENT_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useWishlistIntent } from '../../hooks/useWishlistIntent';
import { WISHLIST_INTENT_LABELS } from '../../services/free-tier/wishlistIntent';
import type {
  NormalizedItem,
  WishlistIntentKind,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { UtilityBody, UtilityCard, UtilityChip, UtilityRow, UtilityTitle } from './freeTierUi';

const INTENT_ORDER: WishlistIntentKind[] = [
  'want_similar',
  'wishlist',
  'compare_later',
  'own_it',
  'not_interested',
];

export function WishlistIntentCard(props: { item?: NormalizedItem | null }) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_WISHLIST_INTENT_ENABLED);
  const { intents, loading, setIntent, clearIntent } = useWishlistIntent();
  if (!enabled || !props.item || loading) return null;
  const current = intents[props.item.id]?.intent;

  return (
    <UtilityCard>
      <UtilityTitle kicker="Shopping intent">Keep track of this piece</UtilityTitle>
      <UtilityBody>Save your intent — no retailers, just your own notes.</UtilityBody>
      <UtilityRow>
        {INTENT_ORDER.map((kind) => (
          <UtilityChip
            key={kind}
            label={WISHLIST_INTENT_LABELS[kind]}
            active={current === kind}
            onPress={() => {
              const item = props.item as NormalizedItem;
              if (current === kind) clearIntent(item.id);
              else setIntent(item.id, kind, item.title);
            }}
          />
        ))}
      </UtilityRow>
    </UtilityCard>
  );
}
