/**
 * Free Tier Utility Expansion — seasonal closet nudge (P2 shell).
 * Renders only when saved items carry season tags. No notifications.
 */

import React, { useMemo } from 'react';
import {
  FREE_TIER_UTILITY_ENABLED,
} from '../../constants/freeTierUtilityFlags';
import { getSeasonalNudge } from '../../services/free-tier/seasonalNudges';
import type {
  CareNoteEntry,
  NormalizedItem,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { UtilityBody, UtilityCard, UtilityTitle } from './freeTierUi';

export function SeasonalNudgeCard(props: {
  items: NormalizedItem[];
  care?: Record<string, CareNoteEntry>;
}) {
  const nudge = useMemo(
    () => getSeasonalNudge(props.items, { care: props.care }),
    [props.items, props.care]
  );
  if (!FREE_TIER_UTILITY_ENABLED || !nudge) return null;

  return (
    <UtilityCard>
      <UtilityTitle kicker={'Season · ' + nudge.season}>{nudge.headline}</UtilityTitle>
      <UtilityBody>{nudge.body}</UtilityBody>
    </UtilityCard>
  );
}
