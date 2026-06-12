import type { StyleChatContext } from './types';
import { buildStyleMemorySummary } from './buildStyleMemorySummary';

// v0.2 placeholder upgraded in v0.3 to populate memory context from Dressing Room data.
// Must never include raw images, biometrics, body-type inference,
// or protected-characteristic data.
export async function buildStyleChatContext(): Promise<StyleChatContext> {
  let memoryContext: StyleChatContext['memoryContext'];

  try {
    const memory = await buildStyleMemorySummary();
    memoryContext = {
      confidenceScore: memory.confidenceScore,
      implementedSignals: memory.implementedSignals,
      missingSignals: memory.missingSignals,
      sourceCounts: memory.sourceCounts,
      favoriteColors: memory.favoriteColors,
      favoriteBrands: memory.favoriteBrands,
      favoriteCategories: memory.favoriteCategories,
      budgetRange: memory.budgetRange,
    };
  } catch {
    // Non-fatal — context works without memory
    memoryContext = undefined;
  }

  return {
    recentScanSummaries: [],
    savedItemIds: [],
    dressingRoomIds: [],
    preferences: {
      preferredStyles: [],
      dislikedStyles: [],
      preferredColors: memoryContext?.favoriteColors?.map((c) => c.value) ?? [],
      budgetRange: memoryContext?.budgetRange
        ? { min: memoryContext.budgetRange.min, max: memoryContext.budgetRange.max }
        : undefined,
    },
    memoryContext,
  };
}
