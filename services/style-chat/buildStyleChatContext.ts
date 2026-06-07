import type { StyleChatContext } from './types';

// v0.1 placeholder — returns empty context. Future versions will query
// scans, saved items, Dressing Rooms, and style preferences from Supabase.
// Must never include raw images, biometrics, body-type inference,
// or protected-characteristic data.
export function buildStyleChatContext(): StyleChatContext {
  return {
    recentScanSummaries: [],
    savedItemIds: [],
    dressingRoomIds: [],
    preferences: {
      preferredStyles: [],
      dislikedStyles: [],
      preferredColors: [],
      budgetRange: undefined,
    },
  };
}
