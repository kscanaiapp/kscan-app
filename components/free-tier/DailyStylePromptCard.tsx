/**
 * Free Tier Utility Expansion — "What to wear today" card.
 * Flag-guarded; renders nothing unless enabled. Local data only.
 */

import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import {
  FREE_TIER_DAILY_STYLE_PROMPT_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useDailyStylePrompt } from '../../hooks/useDailyStylePrompt';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  SuggestedOutfit,
  WearTrackingEntry,
} from '../../services/free-tier/wardrobeUtilityTypes';
import {
  FT_COLORS,
  UtilityBody,
  UtilityButton,
  UtilityCard,
  UtilityRow,
  UtilityTitle,
} from './freeTierUi';

export function DailyStylePromptCard(props: {
  items: NormalizedItem[];
  outfits?: SuggestedOutfit[];
  feedback?: Record<string, OutfitFeedbackEntry>;
  wear?: Record<string, WearTrackingEntry>;
  onWearThis?: (pick: { item?: NormalizedItem; outfit?: SuggestedOutfit }) => void;
  onSaveAsLook?: (outfit: SuggestedOutfit) => void;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_DAILY_STYLE_PROMPT_ENABLED);
  const { pick, dismissed, hydrated, showAnother, notToday } = useDailyStylePrompt({
    items: props.items,
    outfits: props.outfits,
    feedback: props.feedback,
    wear: props.wear,
  });
  if (!enabled || !hydrated || dismissed) return null;

  if (pick.kind === 'empty') {
    return (
      <UtilityCard>
        <UtilityTitle kicker="Today's pick">What to wear today</UtilityTitle>
        <UtilityBody>{pick.reason}</UtilityBody>
      </UtilityCard>
    );
  }

  const item = pick.kind === 'item' ? pick.item : pick.outfit?.items?.[0];
  const headline =
    pick.kind === 'outfit'
      ? pick.outfit?.title ?? 'Try this saved look'
      : item?.title ?? ([item?.color, item?.category].filter(Boolean).join(' ') || 'Try this saved item today');

  return (
    <UtilityCard>
      <UtilityTitle kicker="Today's pick">What to wear today</UtilityTitle>
      <View style={styles.pickRow}>
        {item?.imageUri ? (
          <Image source={{ uri: item.imageUri }} style={styles.thumb} />
        ) : null}
        <View style={styles.pickText}>
          <Text style={styles.headline} numberOfLines={2}>
            {headline}
          </Text>
          <UtilityBody>{pick.reason}</UtilityBody>
        </View>
      </View>
      <UtilityRow>
        <UtilityButton
          label="Wear this"
          onPress={() =>
            props.onWearThis?.({ item: pick.item, outfit: pick.outfit })
          }
        />
        {pick.kind === 'outfit' && pick.outfit && props.onSaveAsLook ? (
          <UtilityButton
            label="Save as look"
            subtle
            onPress={() => props.onSaveAsLook?.(pick.outfit as SuggestedOutfit)}
          />
        ) : null}
        <UtilityButton label="Show another" subtle onPress={showAnother} />
        <UtilityButton label="Not today" subtle onPress={notToday} />
      </UtilityRow>
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  pickRow: { flexDirection: 'row', marginBottom: 4 },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
    marginRight: 12,
    backgroundColor: FT_COLORS.surfaceSoft,
  },
  pickText: { flex: 1 },
  headline: { fontSize: 14, fontWeight: '600', color: FT_COLORS.plum, marginBottom: 2 },
});
