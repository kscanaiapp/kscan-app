// Mirror of the FREE_TIER_STORAGE_KEYS map in
// services/free-tier/wardrobeUtilityTypes.ts, for tests that load
// freeTierStorage.ts in a VM (the real module is TypeScript and carries type-only
// exports the sandbox cannot resolve).
//
// It must not drift: __tests__/freeTierAccountIsolation.test.js asserts this map
// equals the real one, so a key added there and not here fails immediately.
const FREE_TIER_STORAGE_KEYS = {
  brandSizing: 'kscan.freeTier.brandSizing.v1',
  outfitFeedback: 'kscan.freeTier.outfitFeedback.v1',
  careNotes: 'kscan.freeTier.careNotes.v1',
  wishlistIntent: 'kscan.freeTier.wishlistIntent.v1',
  collections: 'kscan.freeTier.collections.v1',
  wearTracking: 'kscan.freeTier.wearTracking.v1',
  activityLog: 'kscan.freeTier.activityLog.v1',
  styleBoards: 'kscan.freeTier.styleBoards.v1',
  utilityMeta: 'kscan.freeTier.utilityMeta.v1',
  syncQueue: 'kscan.freeTier.syncQueue.v1',
};

module.exports = { FREE_TIER_STORAGE_KEYS };
