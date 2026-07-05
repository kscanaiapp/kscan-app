/**
 * Free Tier Utility Expansion — share button (plain-text share only).
 */

import React from 'react';
import {
  FREE_TIER_SHARE_CARD_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useShareOutfit } from '../../hooks/useShareOutfit';
import type {
  NormalizedItem,
  SavedOutfit,
  SuggestedOutfit,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { UtilityButton } from './freeTierUi';

export function ShareOutfitButton(props: {
  item?: NormalizedItem | null;
  outfit?: SuggestedOutfit | SavedOutfit | null;
  subtle?: boolean;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_SHARE_CARD_ENABLED);
  const { sharing, shareItem, shareOutfit } = useShareOutfit();
  if (!enabled || (!props.item && !props.outfit)) return null;
  return (
    <UtilityButton
      label={sharing ? 'Sharing…' : 'Share this look'}
      subtle={props.subtle}
      disabled={sharing}
      onPress={() => {
        if (props.outfit) shareOutfit(props.outfit);
        else shareItem(props.item);
      }}
    />
  );
}
