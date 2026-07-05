/**
 * Free Tier Utility Expansion — style challenges hook (P2 shell).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  STYLE_CHALLENGES,
  loadCompletedChallengeIds,
  markChallengeCompleted,
} from '../services/free-tier/styleChallenges';

export function useStyleChallenges() {
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadCompletedChallengeIds()
      .then((ids) => {
        if (live) setCompletedIds(ids);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const complete = useCallback(async (challengeId: string) => {
    setCompletedIds(await markChallengeCompleted(challengeId));
  }, []);

  const nextChallenge =
    STYLE_CHALLENGES.find((c) => !completedIds.includes(c.id)) ?? null;

  return { challenges: STYLE_CHALLENGES, completedIds, nextChallenge, loading, complete };
}
