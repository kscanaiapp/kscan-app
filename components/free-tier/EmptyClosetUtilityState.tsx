/**
 * Free Tier Utility Expansion — action-oriented empty state.
 */

import React from 'react';
import {
  FREE_TIER_UTILITY_ENABLED,
} from '../../constants/freeTierUtilityFlags';
import { UtilityBody, UtilityButton, UtilityCard, UtilityRow, UtilityTitle } from './freeTierUi';

export function EmptyClosetUtilityState(props: {
  onStartScan?: () => void;
  variant?: 'closet' | 'ratings' | 'collections';
}) {
  if (!FREE_TIER_UTILITY_ENABLED) return null;
  const variant = props.variant ?? 'closet';

  const copy =
    variant === 'ratings'
      ? 'Rate outfits to make your closet more useful.'
      : variant === 'collections'
        ? 'Create collections for work, travel, or nights out.'
        : 'Each saved item unlocks notes, ratings, and outfit ideas.';

  return (
    <UtilityCard>
      <UtilityTitle kicker="Closet memory">
        Save a scan to start building your closet memory
      </UtilityTitle>
      <UtilityBody>{copy}</UtilityBody>
      <UtilityRow>
        {props.onStartScan ? (
          <UtilityButton label="Scan something" onPress={props.onStartScan} />
        ) : null}
      </UtilityRow>
    </UtilityCard>
  );
}
