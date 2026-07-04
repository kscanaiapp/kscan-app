/**
 * Free Tier Utility Expansion — outfit generator section.
 * Rules-based suggestions from saved items. Not AI; copy says "suggested"/"try".
 */

import React from 'react';
import {
  FREE_TIER_OUTFIT_GENERATOR_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useOutfitGenerator } from '../../hooks/useOutfitGenerator';
import { useShareOutfit } from '../../hooks/useShareOutfit';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { SavedOutfitCard } from './SavedOutfitCard';
import { UtilityBody, UtilityButton, UtilityCard, UtilityTitle } from './freeTierUi';

export function OutfitGeneratorCard(props: {
  items: NormalizedItem[];
  feedback?: Record<string, OutfitFeedbackEntry>;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_OUTFIT_GENERATOR_ENABLED);
  const { outfits, totalAvailable, showMore, saveLook } = useOutfitGenerator(
    props.items,
    props.feedback
  );
  const { shareOutfit } = useShareOutfit();
  if (!enabled) return null;

  if (outfits.length === 0) {
    return (
      <UtilityCard>
        <UtilityTitle kicker="Style this together">Outfit ideas</UtilityTitle>
        <UtilityBody>
          Save a few more pieces — tops, bottoms, layers — and outfit ideas from
          your saved items will appear here.
        </UtilityBody>
      </UtilityCard>
    );
  }

  return (
    <>
      <UtilityTitle kicker="Suggested from your saved items">
        You have the pieces for these looks
      </UtilityTitle>
      {outfits.map((outfit) => (
        <SavedOutfitCard
          key={outfit.id}
          outfit={outfit}
          onSaveLook={saveLook}
          onShare={(o) => shareOutfit(o)}
        />
      ))}
      {outfits.length < totalAvailable ? (
        <UtilityButton label="More ideas" subtle onPress={showMore} />
      ) : null}
    </>
  );
}
