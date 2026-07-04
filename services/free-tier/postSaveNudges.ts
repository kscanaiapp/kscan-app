/**
 * Free Tier Utility Expansion — deterministic post-save nudges.
 * No AI, no backend. Pure function of local counters.
 */

export interface PostSaveNudgeInput {
  totalSaved: number;
  weeklySaveCount: number;
  hasCareNote: boolean;
  hasRating: boolean;
}

export interface PostSaveNudgeResult {
  message: string;
  suggestedAction?: 'add_care_note' | 'rate_look' | 'none';
}

export function pickPostSaveNudge(input: PostSaveNudgeInput): PostSaveNudgeResult {
  const total = Math.max(0, input.totalSaved | 0);
  const weekly = Math.max(0, input.weeklySaveCount | 0);

  if (total === 1) {
    return {
      message: 'Nice — your closet memory is growing.',
      suggestedAction: 'add_care_note',
    };
  }
  if (!input.hasRating) {
    return { message: 'Want to rate this look?', suggestedAction: 'rate_look' };
  }
  if (!input.hasCareNote) {
    return { message: 'Want to add a care note?', suggestedAction: 'add_care_note' };
  }
  if (weekly >= 3) {
    return {
      message: "You've saved " + weekly + ' items this week.',
      suggestedAction: 'none',
    };
  }
  return { message: 'Nice — your closet memory is growing.', suggestedAction: 'none' };
}
