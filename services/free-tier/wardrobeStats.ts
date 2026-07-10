/**
 * Free Tier Utility Expansion — wardrobe stats / style summary.
 * All figures are derived from locally saved items only.
 */

import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from './wardrobeUtilityTypes';

export interface RankedLabel {
  label: string;
  count: number;
}

export interface WardrobeStats {
  totalItems: number;
  topCategories: RankedLabel[];
  topColors: RankedLabel[];
  topBrands: RankedLabel[];
  topOccasions: RankedLabel[];
  averageRating?: number;
  ratedCount: number;
  mostWorn?: { item: NormalizedItem; wearCount: number };
  /** 0–1 progress toward a "formed" closet memory (25 saved items). */
  closetMemoryProgress: number;
  progressLabel: string;
}

function rank(values: Array<string | undefined>, limit = 3): RankedLabel[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    const key = value.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function computeWardrobeStats(
  items: NormalizedItem[],
  extras?: {
    feedback?: Record<string, OutfitFeedbackEntry>;
    wear?: Record<string, WearTrackingEntry>;
  }
): WardrobeStats {
  const safeItems = Array.isArray(items) ? items : [];
  const feedback = extras?.feedback ?? {};
  const wear = extras?.wear ?? {};

  const ratings = safeItems
    .map((item) => feedback[item.id]?.rating)
    .filter((r): r is number => typeof r === 'number' && r >= 1 && r <= 5);
  const averageRating =
    ratings.length > 0
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : undefined;

  let mostWorn: WardrobeStats['mostWorn'];
  for (const item of safeItems) {
    const entry = wear[item.id];
    if (entry && entry.wearCount > 0) {
      if (!mostWorn || entry.wearCount > mostWorn.wearCount) {
        mostWorn = { item, wearCount: entry.wearCount };
      }
    }
  }

  const total = safeItems.length;
  const progress = Math.max(0, Math.min(1, total / 25));
  let progressLabel = 'Save a scan to start building your closet memory.';
  if (total >= 1 && total < 5) progressLabel = 'Your wardrobe is starting to form';
  else if (total >= 5 && total < 15) progressLabel = 'Your closet memory is growing';
  else if (total >= 15) progressLabel = 'Your style at a glance';

  return {
    totalItems: total,
    topCategories: rank(safeItems.map((i) => i.category)),
    topColors: rank(safeItems.map((i) => i.color)),
    topBrands: rank(safeItems.map((i) => i.brand)),
    topOccasions: rank(safeItems.flatMap((i) => i.occasionTags ?? [])),
    averageRating,
    ratedCount: ratings.length,
    mostWorn,
    closetMemoryProgress: progress,
    progressLabel,
  };
}
