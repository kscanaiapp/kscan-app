/**
 * Free Tier Utility Expansion — style challenge card (P2 shell).
 * Local-only, calm engagement. No social feed, no public posting.
 */

import React from 'react';
import {
  FREE_TIER_STYLE_CHALLENGES_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useStyleChallenges } from '../../hooks/useStyleChallenges';
import { UtilityBody, UtilityButton, UtilityCard, UtilityRow, UtilityTitle } from './freeTierUi';

export function StyleChallengeCard() {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_STYLE_CHALLENGES_ENABLED);
  const { nextChallenge, loading, complete } = useStyleChallenges();
  if (!enabled || loading || !nextChallenge) return null;

  return (
    <UtilityCard>
      <UtilityTitle kicker="Style challenge">{nextChallenge.title}</UtilityTitle>
      <UtilityBody>{nextChallenge.description}</UtilityBody>
      <UtilityRow>
        <UtilityButton
          label="Mark done"
          subtle
          onPress={() => complete(nextChallenge.id)}
        />
      </UtilityRow>
    </UtilityCard>
  );
}
