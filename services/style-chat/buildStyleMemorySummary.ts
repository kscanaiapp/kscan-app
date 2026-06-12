import {
  readMemoryEvents,
  readDressingRoomItemSignals,
  readReactionSignals,
  requireUserId,
} from './styleMemoryRepository';
import {
  getCachedStyleMemorySummary,
  setCachedStyleMemorySummary,
} from './styleMemoryCache';
import {
  confidenceFromCount,
  STYLE_MEMORY_IMPLEMENTED_SIGNALS,
  STYLE_MEMORY_MAX_SIGNAL_ITEMS,
  STYLE_MEMORY_MIN_SIGNAL_COUNT,
  STYLE_MEMORY_MISSING_SIGNALS,
} from '../../constants/styleMemory';
import type { StyleMemorySignalItem, StyleMemorySummary } from './styleMemoryTypes';

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function aggregateByKey(values: string[]): Map<string, { raw: string; count: number }> {
  const map = new Map<string, { raw: string; count: number }>();

  for (const value of values) {
    const key = normalizeKey(value);
    if (!key) continue;

    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, { raw: value, count: 1 });
    }
  }

  return map;
}

function toSignalItems(
  map: Map<string, { raw: string; count: number }>,
  minCount: number,
): StyleMemorySignalItem[] {
  return Array.from(map.values())
    .filter(({ count }) => count >= minCount)
    .map(({ raw, count }) => ({
      value: raw,
      count,
      confidence: confidenceFromCount(count),
    }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return left.value.localeCompare(right.value);
    })
    .slice(0, STYLE_MEMORY_MAX_SIGNAL_ITEMS);
}

function emptyMemorySummary(): StyleMemorySummary {
  return {
    favoriteColors: [],
    favoriteBrands: [],
    favoriteCategories: [],
    favoriteSilhouettes: [],
    favoriteStyleTags: [],
    avoidedColors: [],
    budgetRange: null,
    preferredFormality: null,
    confidenceScore: 0,
    generatedAt: new Date().toISOString(),
    sourceCounts: { memoryEvents: 0 },
    implementedSignals: [...STYLE_MEMORY_IMPLEMENTED_SIGNALS],
    missingSignals: [...STYLE_MEMORY_MISSING_SIGNALS],
  };
}

// Builds a style memory summary from live Dressing Room source tables.
// style_memory_events are read only for debug/source counts so stale refs and
// old thumbs_down rows do not affect active confidence.
export async function buildStyleMemorySummary(): Promise<StyleMemorySummary> {
  const userId = await requireUserId();
  const cached = getCachedStyleMemorySummary(userId);
  if (cached) return cached;

  try {
    const [memoryEvents, items, reactions] = await Promise.all([
      readMemoryEvents(),
      readDressingRoomItemSignals(),
      readReactionSignals(),
    ]);

    const brandMap = aggregateByKey(
      items.map((item) => item.brand).filter((brand): brand is string => brand !== null),
    );
    reactions.forEach((reaction) => {
      if (!reaction.brand) return;
      const key = normalizeKey(reaction.brand);
      const existing = brandMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        brandMap.set(key, { raw: reaction.brand, count: 1 });
      }
    });

    const categoryMap = aggregateByKey(
      items
        .map((item) => item.category)
        .filter((category): category is string => category !== null),
    );
    reactions.forEach((reaction) => {
      if (!reaction.category) return;
      const key = normalizeKey(reaction.category);
      const existing = categoryMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        categoryMap.set(key, { raw: reaction.category, count: 1 });
      }
    });

    const colorMap = aggregateByKey(
      items
        .map((item) => item.colorFromScan)
        .filter((color): color is string => color !== null),
    );

    const prices = items
      .filter((item) => item.priceAmount !== null && item.sourceType === 'product_match')
      .map((item) => item.priceAmount as number);

    let budgetRange: StyleMemorySummary['budgetRange'] = null;
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const average = Math.round(
        (prices.reduce((sum, price) => sum + price, 0) / prices.length) * 100,
      ) / 100;

      budgetRange = {
        min,
        max,
        average,
        confidence: confidenceFromCount(prices.length),
      };
    }

    const favoriteBrands = toSignalItems(brandMap, STYLE_MEMORY_MIN_SIGNAL_COUNT);
    const favoriteCategories = toSignalItems(categoryMap, STYLE_MEMORY_MIN_SIGNAL_COUNT);
    const favoriteColors = toSignalItems(colorMap, STYLE_MEMORY_MIN_SIGNAL_COUNT);

    const topSignals = [...favoriteBrands, ...favoriteCategories, ...favoriteColors];
    const confidenceScore =
      topSignals.length > 0
        ? Math.round(
            (topSignals.reduce((sum, signal) => sum + signal.confidence, 0) /
              topSignals.length) *
              100,
          ) / 100
        : 0;

    const summary: StyleMemorySummary = {
      favoriteColors,
      favoriteBrands,
      favoriteCategories,
      favoriteSilhouettes: [],
      favoriteStyleTags: [],
      avoidedColors: [],
      budgetRange,
      preferredFormality: null,
      confidenceScore,
      generatedAt: new Date().toISOString(),
      sourceCounts: {
        memoryEvents: memoryEvents.length,
        scans: items.filter((item) => item.sourceType === 'scan_image').length,
        savedItems: items.filter((item) => item.sourceType === 'product_match').length,
        dressingRoomSignals: reactions.length,
        staleSourceRefs: memoryEvents.reduce(
          (sum, event) => sum + Math.max(0, event.staleSourceCount),
          0,
        ),
      },
      implementedSignals: [...STYLE_MEMORY_IMPLEMENTED_SIGNALS],
      missingSignals: [...STYLE_MEMORY_MISSING_SIGNALS],
    };

    setCachedStyleMemorySummary(userId, summary);
    return summary;
  } catch {
    return emptyMemorySummary();
  }
}
