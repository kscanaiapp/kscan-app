/**
 * Free Tier Utility Expansion — wear-again suggestions (local only).
 */

import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from './wardrobeUtilityTypes';
import { currentSeason } from './seasonalNudges';

export interface WearAgainSuggestion {
  item: NormalizedItem;
  reason: string;
}

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export function getWearAgainSuggestions(
  items: NormalizedItem[],
  extras?: {
    feedback?: Record<string, OutfitFeedbackEntry>;
    wear?: Record<string, WearTrackingEntry>;
    limit?: number;
    now?: Date;
  }
): WearAgainSuggestion[] {
  const safeItems = Array.isArray(items) ? items : [];
  const feedback = extras?.feedback ?? {};
  const wear = extras?.wear ?? {};
  const now = extras?.now ?? new Date();
  const season = currentSeason(now);

  const scored: Array<{ suggestion: WearAgainSuggestion; score: number }> = [];
  for (const item of safeItems) {
    const entry = feedback[item.id];
    const tags = entry?.tags ?? [];
    if (tags.includes('Would not wear') || tags.includes('Not practical')) continue;

    let score = 0;
    let reason = 'This saved item may work well this week';
    if (typeof entry?.rating === 'number' && entry.rating >= 4) {
      score += 3;
      reason = 'You liked this before';
    }
    if (tags.includes('Would wear again')) {
      score += 3;
      reason = 'You marked this "would wear again"';
    }
    const lastWorn = wear[item.id]?.lastWornAt;
    if (lastWorn) {
      const elapsed = now.getTime() - new Date(lastWorn).getTime();
      if (Number.isFinite(elapsed) && elapsed > TWO_WEEKS_MS) {
        score += 2;
        reason = 'Consider wearing this again soon';
      }
    }
    if ((item.seasonTags ?? []).some((t) => t.toLowerCase().includes(season))) {
      score += 1;
    }
    if (score > 0) scored.push({ suggestion: { item, reason }, score });
  }

  scored.sort((a, b) => b.score - a.score || a.suggestion.item.id.localeCompare(b.suggestion.item.id));
  return scored.slice(0, extras?.limit ?? 3).map((s) => s.suggestion);
}
