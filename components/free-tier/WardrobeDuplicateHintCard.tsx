/**
 * Free Tier Utility Expansion — possible-duplicate hint.
 * Attribute similarity only; never claims an exact or visual match.
 */

import React from 'react';
import {
  FREE_TIER_DUPLICATE_HINTS_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useDuplicateHints } from '../../hooks/useDuplicateHints';
import type { NormalizedItem } from '../../services/free-tier/wardrobeUtilityTypes';
import { UtilityBody, UtilityCard, UtilityChip, UtilityRow, UtilityTitle } from './freeTierUi';

export function WardrobeDuplicateHintCard(props: {
  candidate: NormalizedItem | null | undefined;
  savedItems: NormalizedItem[];
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_DUPLICATE_HINTS_ENABLED);
  const result = useDuplicateHints(props.candidate, props.savedItems);
  if (!enabled || !result.hasPossibleDuplicate) return null;
  return (
    <UtilityCard>
      <UtilityTitle kicker={'Possible duplicate · ' + result.confidence + ' confidence'}>
        You may already have something similar
      </UtilityTitle>
      <UtilityBody>
        {result.matchingItemIds.length === 1
          ? 'One similar saved item was found in your closet memory.'
          : result.matchingItemIds.length + ' similar saved items were found in your closet memory.'}
      </UtilityBody>
      <UtilityRow>
        {result.reasonLabels.map((reason) => (
          <UtilityChip key={reason} label={reason} />
        ))}
      </UtilityRow>
    </UtilityCard>
  );
}
