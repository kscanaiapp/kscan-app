/**
 * Free Tier Utility Expansion — daily style prompt ("What to wear today").
 * Deterministic per calendar day. Local data only; no notifications,
 * no calendar permissions, no weather dependency.
 */

import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  SuggestedOutfit,
  WearTrackingEntry,
} from './wardrobeUtilityTypes';

export interface DailyPick {
  kind: 'item' | 'outfit' | 'empty';
  item?: NormalizedItem;
  outfit?: SuggestedOutfit;
  reason: string;
  dateKey: string;
}

export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function seedFrom(text: string): number {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return Math.abs(seed);
}

const WEEKDAY_OCCASIONS = ['work', 'office', 'business', 'smart'];
const WEEKEND_OCCASIONS = ['casual', 'weekend', 'brunch', 'relaxed'];

function occasionScore(item: NormalizedItem, now: Date): number {
  const tags = (item.occasionTags ?? []).map((t) => t.toLowerCase());
  if (tags.length === 0) return 0;
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;
  const wanted = isWeekend ? WEEKEND_OCCASIONS : WEEKDAY_OCCASIONS;
  return wanted.some((w) => tags.some((t) => t.includes(w))) ? 3 : 0;
}

export interface DailyPickInputs {
  items: NormalizedItem[];
  outfits?: SuggestedOutfit[];
  feedback?: Record<string, OutfitFeedbackEntry>;
  wear?: Record<string, WearTrackingEntry>;
  /** Bumped by "Show another" so the user can shuffle within the same day. */
  shuffleOffset?: number;
  now?: Date;
}

/**
 * Pick one item or outfit for today. Preference order:
 * recently saved but unrated → highly rated / "would wear again" →
 * weekday/weekend occasion fit → everything else. Deterministic per day.
 */
export function getDailyPick(inputs: DailyPickInputs): DailyPick {
  const now = inputs.now ?? new Date();
  const dateKey = todayKey(now);
  const items = Array.isArray(inputs.items) ? inputs.items : [];
  if (items.length === 0) {
    return {
      kind: 'empty',
      reason: 'Save a scan to start building your closet memory.',
      dateKey,
    };
  }

  const feedback = inputs.feedback ?? {};
  const scored = items.map((item) => {
    const entry = feedback[item.id];
    const negative = (entry?.tags ?? []).some(
      (t) => t === 'Would not wear' || t === 'Not practical'
    );
    let score = 1;
    let reason = 'Try this saved item today';
    if (negative) score = -100;
    if (!entry && item.savedAt) {
      score += 4;
      reason = 'Recently saved — give it a try today';
    }
    if (entry && typeof entry.rating === 'number' && entry.rating >= 4) {
      score += 5;
      reason = 'You rated this highly before';
    }
    if ((entry?.tags ?? []).includes('Would wear again')) {
      score += 5;
      reason = 'You marked this "would wear again"';
    }
    score += occasionScore(item, now);
    return { item, score, reason };
  });

  const eligible = scored.filter((s) => s.score > 0);
  if (eligible.length === 0) {
    return {
      kind: 'empty',
      reason: 'Rate outfits to make your closet more useful.',
      dateKey,
    };
  }

  eligible.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const topPool = eligible.slice(0, Math.min(5, eligible.length));
  const offset = Math.max(0, inputs.shuffleOffset ?? 0);
  const index = (seedFrom(dateKey) + offset) % topPool.length;

  // Prefer surfacing a full outfit when one contains today's picked item.
  const chosen = topPool[index];
  const outfit = (inputs.outfits ?? []).find((o) =>
    o.itemIds.includes(chosen.item.id)
  );
  if (outfit) {
    return { kind: 'outfit', outfit, reason: chosen.reason, dateKey };
  }
  return { kind: 'item', item: chosen.item, reason: chosen.reason, dateKey };
}
