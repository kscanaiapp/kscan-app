/**
 * Free Tier Utility Expansion — deterministic post-save nudge (P2 shell).
 */

import React from 'react';
import {
  FREE_TIER_UTILITY_ENABLED,
} from '../../constants/freeTierUtilityFlags';
import { pickPostSaveNudge } from '../../services/free-tier/postSaveNudges';
import { UtilityBody, UtilityButton, UtilityCard, UtilityRow } from './freeTierUi';

export function PostSaveNudge(props: {
  totalSaved: number;
  weeklySaveCount?: number;
  hasCareNote?: boolean;
  hasRating?: boolean;
  onAddCareNote?: () => void;
  onRateLook?: () => void;
}) {
  if (!FREE_TIER_UTILITY_ENABLED) return null;
  const nudge = pickPostSaveNudge({
    totalSaved: props.totalSaved,
    weeklySaveCount: props.weeklySaveCount ?? 0,
    hasCareNote: !!props.hasCareNote,
    hasRating: !!props.hasRating,
  });

  return (
    <UtilityCard>
      <UtilityBody>{nudge.message}</UtilityBody>
      <UtilityRow>
        {nudge.suggestedAction === 'add_care_note' && props.onAddCareNote ? (
          <UtilityButton label="Add a care note" subtle onPress={props.onAddCareNote} />
        ) : null}
        {nudge.suggestedAction === 'rate_look' && props.onRateLook ? (
          <UtilityButton label="Rate this look" subtle onPress={props.onRateLook} />
        ) : null}
      </UtilityRow>
    </UtilityCard>
  );
}
