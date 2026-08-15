/**
 * Builds the request-scoped, metadata-only committed-Closet projection used by
 * S7. Recent Scans are never read here. A failed/partial manifest read is
 * represented explicitly so the backend cannot mistake missing evidence for an
 * empty Closet.
 */

import { createActorRequest, isActorRequestCurrent } from '../actorContext';
import { getClosetItemProjections } from '../closetItemProjection';
import { loadClosetTyped } from '../closetLibrary';

export const CLOSET_INTELLIGENCE_CONTEXT_VERSION = 'closet_intelligence_context_v1';
export const CLOSET_INTELLIGENCE_CONTEXT_MAX_ITEMS = 40;

export type ClosetIntelligenceContext = {
  contractVersion: typeof CLOSET_INTELLIGENCE_CONTEXT_VERSION;
  inventoryState: 'complete' | 'partial' | 'unavailable';
  items: Array<{
    ref: string;
    title: string;
    category: string | null;
    clothingType: string | null;
    subtype: string | null;
    brand: string | null;
    primaryColor: string | null;
    secondaryColors: readonly string[];
    materials: readonly string[];
  }>;
};

function unavailable(): ClosetIntelligenceContext {
  return {
    contractVersion: CLOSET_INTELLIGENCE_CONTEXT_VERSION,
    inventoryState: 'unavailable',
    items: [],
  };
}

export async function buildClosetIntelligenceContext(
  actorId: string | null,
): Promise<ClosetIntelligenceContext> {
  if (!actorId) return unavailable();

  const actorRequest = createActorRequest();
  const result = await loadClosetTyped(actorId, { actorRequest });
  if (!result.ok || !isActorRequestCurrent(actorRequest)) return unavailable();

  const projected = getClosetItemProjections(result.items).slice(
    0,
    CLOSET_INTELLIGENCE_CONTEXT_MAX_ITEMS,
  );
  const truncated = result.items.length > projected.length;

  return {
    contractVersion: CLOSET_INTELLIGENCE_CONTEXT_VERSION,
    inventoryState: result.skipped > 0 || truncated ? 'partial' : 'complete',
    items: projected.map((item, index) => ({
      // Request-local and deliberately unrelated to the device-local record id.
      ref: `closet_${index + 1}`,
      title: item.title,
      category: item.category,
      clothingType: item.clothingType,
      subtype: item.subtype,
      brand: item.brand,
      primaryColor: item.primaryColor,
      secondaryColors: item.secondaryColors,
      materials: item.material,
    })),
  };
}

