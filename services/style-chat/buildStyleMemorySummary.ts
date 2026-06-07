import {
  readDressingRoomItemSignals,
  readReactionSignals,
} from './styleMemoryRepository';
import {
  getCachedStyleMemorySummary,
  setCachedStyleMemorySummary,
} from './styleMemoryCache';
import {
  confidenceFromCount,
  STYLE_MEMORY_MIN_SIGNAL_COUNT,
  STYLE_MEMORY_IMPLEMENTED_SIGNALS,
  STYLE_MEMORY_MISSING_SIGNALS,
} from '../../constants/styleMemory';
import type { StyleMemorySummary, StyleMemorySignalItem } from './styleMemoryTypes';

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function aggregateByKey(
  values: string[],
): Map<string, { raw: string; count: number }> {
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
    .sort((a, b) => b.count - a.count)
    .map(({ raw, count }) => ({
      value: raw,
      count,
      confidence: confidenceFromCount(count),
    }));
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

// Builds a style memory summary from dressing room items and reactions.
//
// v0.3 reads directly from source tables (not from style_memory_events) because
// no events have been written yet. Results are cached per session.
//
// Never crashes the chat flow — returns empty summary on any error.
export async function buildStyleMemorySummary(): Promise<StyleMemorySummary> {
  const cached = getCachedStyleMemorySummary();
  if (cached) return cached;

  try {
    const [items, reactions] = await Promise.all([
      readDressingRoomItemSignals(),
      readReactionSignals(),
    ]);

    // ── Brand aggregation ──────────────────────────────────────────────────────
    const brandMap = aggregateByKey(
      items.map((i) => i.brand).filter((b): b is string => b !== null),
    );
    reactions.forEach((r) => {
      if (r.brand) {
        const key = normalizeKey(r.brand);
        const existing = brandMap.get(key);
        if (existing) existing.count += 1;
        else brandMap.set(key, { raw: r.brand, count: 1 });
      }
    });

    // ── Category aggregation ───────────────────────────────────────────────────
    const categoryMap = aggregateByKey(
      items.map((i) => i.category).filter((c): c is string => c !== null),
    );
    reactions.forEach((r) => {
      if (r.category) {
        const key = normalizeKey(r.category);
        const existing = categoryMap.get(key);
        if (existing) existing.count += 1;
        else categoryMap.set(key, { raw: r.category, count: 1 });
      }
    });

    // ── Color aggregation (scan items only) ────────────────────────────────────
    const colorMap = aggregateByKey(
      items
        .map((i) => i.colorFromScan)
        .filter((c): c is string => c !== null),
    );

    // ── Budget aggregation (product_match items with price) ────────────────────
    const prices = items
      .filter((i) => i.priceAmount !== null && i.sourceType === 'product_match')
      .map((i) => i.priceAmount as number);

    let budgetRange: StyleMemorySummary['budgetRange'] = null;
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const average = Math.round(
        (prices.reduce((a, b) => a + b, 0) / prices.length) * 100,
      ) / 100;
      budgetRange = {
        min,
        max,
        average,
        confidence: confidenceFromCount(prices.length),
      };
    }

    const scanCount = items.filter((i) => i.sourceType === 'scan_image').length;
    const productCount = items.filter((i) => i.sourceType === 'product_match').length;

    const favoriteBrands = toSignalItems(brandMap, STYLE_MEMORY_MIN_SIGNAL_COUNT);
    const favoriteCategories = toSignalItems(categoryMap, STYLE_MEMORY_MIN_SIGNAL_COUNT);
    const favoriteColors = toSignalItems(colorMap, STYLE_MEMORY_MIN_SIGNAL_COUNT);

    // Overall confidence: mean of top-10 signal confidences
    const topSignals = [...favoriteBrands, ...favoriteCategories, ...favoriteColors];
    const confidenceScore =
      topSignals.length > 0
        ? Math.round(
            (topSignals
              .slice(0, 10)
              .reduce((sum, s) => sum + s.confidence, 0) /
              Math.min(topSignals.length, 10)) *
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
        memoryEvents: 0,
        scans: scanCount,
        savedItems: productCount,
        dressingRoomSignals: reactions.length,
        staleSourceRefs: 0,
      },
      implementedSignals: [...STYLE_MEMORY_IMPLEMENTED_SIGNALS],
      missingSignals: [...STYLE_MEMORY_MISSING_SIGNALS],
    };

    setCachedStyleMemorySummary(summary);
    return summary;
  } catch {
    return emptyMemorySummary();
  }
}
