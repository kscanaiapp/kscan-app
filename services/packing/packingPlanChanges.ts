import type { PackingPlan, PackingPlanChange } from '../../types/packing';

export function diffPackingPlanChanges(previous: PackingPlan, next: PackingPlan): PackingPlanChange[] {
  const out: PackingPlanChange[] = [];
  const count = Math.max(previous.outfits.length, next.outfits.length);
  for (let outfitIndex = 0; outfitIndex < count; outfitIndex += 1) {
    const before = new Set(previous.outfits[outfitIndex]?.itemIds ?? []);
    const after = new Set(next.outfits[outfitIndex]?.itemIds ?? []);
    const removedItemIds = [...before].filter((id) => !after.has(id));
    const addedItemIds = [...after].filter((id) => !before.has(id));
    if (removedItemIds.length || addedItemIds.length) out.push({ outfitIndex, removedItemIds, addedItemIds });
  }
  return out;
}
