/**
 * Free Tier Utility Expansion — outfit/item rating card (1–5 stars + tags).
 * Local only; kept separate from the Style DNA feedback layer.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import {
  FREE_TIER_OUTFIT_RATING_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useOutfitFeedback } from '../../hooks/useOutfitFeedback';
import { OUTFIT_FEEDBACK_TAGS } from '../../services/free-tier/wardrobeUtilityTypes';
import { FT_COLORS, UtilityCard, UtilityChip, UtilityRow, UtilityTitle } from './freeTierUi';

export function OutfitRatingCard(props: { targetId?: string; title?: string }) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_OUTFIT_RATING_ENABLED);
  const { feedback, loading, rate, toggleTag } = useOutfitFeedback();
  if (!enabled || !props.targetId || loading) return null;
  const entry = feedback[props.targetId];

  return (
    <UtilityCard>
      <UtilityTitle kicker="How did it wear?">
        {props.title ?? 'Rate this look'}
      </UtilityTitle>
      <UtilityRow>
        {[1, 2, 3, 4, 5].map((star) => (
          <Pressable
            key={star}
            accessibilityRole="button"
            accessibilityLabel={star + ' star' + (star > 1 ? 's' : '')}
            onPress={() => rate(props.targetId as string, star)}
            style={styles.starButton}
          >
            <Text
              style={[
                styles.star,
                (entry?.rating ?? 0) >= star && styles.starActive,
              ]}
            >
              ★
            </Text>
          </Pressable>
        ))}
      </UtilityRow>
      <UtilityRow>
        {OUTFIT_FEEDBACK_TAGS.map((tag) => (
          <UtilityChip
            key={tag}
            label={tag}
            active={(entry?.tags ?? []).includes(tag)}
            onPress={() => toggleTag(props.targetId as string, tag)}
          />
        ))}
      </UtilityRow>
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  starButton: { padding: 4, marginRight: 2 },
  star: { fontSize: 26, color: FT_COLORS.border },
  starActive: { color: FT_COLORS.gold },
});
