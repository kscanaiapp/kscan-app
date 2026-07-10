/**
 * Free Tier Utility Expansion — lightweight local style challenges.
 * No social feed, no public posting, no backend.
 */

import {
  FREE_TIER_STORAGE_KEYS,
  type FreeTierUtilityMeta,
  type StyleChallenge,
} from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

const KEY = FREE_TIER_STORAGE_KEYS.utilityMeta;

export const STYLE_CHALLENGES: StyleChallenge[] = [
  {
    id: 'challenge_work_outfit',
    title: 'Build a work outfit',
    description: 'Combine saved items into one work-ready look.',
  },
  {
    id: 'challenge_three_ways',
    title: 'Style one item three ways',
    description: 'Pick a favorite saved piece and try three pairings.',
  },
  {
    id: 'challenge_share_look',
    title: 'Share a favorite look',
    description: 'Share one saved look with a friend.',
  },
  {
    id: 'challenge_rate_outfit',
    title: 'Rate one saved outfit',
    description: 'Rating looks makes suggestions more useful.',
  },
  {
    id: 'challenge_weekend_collection',
    title: 'Create a weekend collection',
    description: 'Group your casual staples into a collection.',
  },
];

export async function loadCompletedChallengeIds(): Promise<string[]> {
  const meta = await readStore<FreeTierUtilityMeta>(KEY, {});
  return Array.isArray(meta.completedChallengeIds) ? meta.completedChallengeIds : [];
}

export async function markChallengeCompleted(
  challengeId: string,
  userId?: string
): Promise<string[]> {
  if (!challengeId) return loadCompletedChallengeIds();
  const meta = await updateStore<FreeTierUtilityMeta>(
    KEY,
    {},
    (current) => {
      const existing = Array.isArray(current.completedChallengeIds)
        ? current.completedChallengeIds
        : [];
      if (existing.includes(challengeId)) return current;
      return { ...current, completedChallengeIds: [...existing, challengeId] };
    },
    userId
  );
  return meta.completedChallengeIds ?? [];
}
