/**
 * Free Tier Utility Expansion — reusable per-item utility panel.
 * Composes duplicate hint, sizing note, care note, rating, cost-per-wear,
 * wishlist intent, complete-the-look, and wear-again sections. Each section
 * hides itself when its flag is off or its data is missing — no broken
 * empty components.
 *
 * Self-contained: if feedback/wear/care are not provided, the panel loads
 * them from local stores so it can be dropped into any screen.
 */

import React from 'react';
import type {
  CareNoteEntry,
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { FREE_TIER_UTILITY_ENABLED } from '../../constants/freeTierUtilityFlags';
import { useWardrobeUtility } from '../../hooks/useWardrobeUtility';
import { BrandSizingNoteCard } from './BrandSizingNoteCard';
import { CareNoteCard } from './CareNoteCard';
import { CompleteTheLookCard } from './CompleteTheLookCard';
import { CostPerWearCard } from './CostPerWearCard';
import { OutfitRatingCard } from './OutfitRatingCard';
import { ShareOutfitButton } from './ShareOutfitButton';
import { WardrobeDuplicateHintCard } from './WardrobeDuplicateHintCard';
import { WearAgainSuggestionCard } from './WearAgainSuggestionCard';
import { WishlistIntentCard } from './WishlistIntentCard';

/**
 * Which journey the panel is rendering inside.
 *
 * `scan_result` was split out of `library` because that value conflated two
 * different journeys: the scan-to-commerce funnel (a live scan result, or the
 * same result reopened from Recent Scans) and the Closet owned-item lifecycle.
 * They are not the same page and must not carry the same surfaces — a reopened
 * Recent Scan is still discovery, not wardrobe maintenance.
 */
export type UtilityPanelContext =
  | 'scan'
  | 'scan_result'
  | 'library'
  | 'product'
  | 'room'
  | 'home';

/** True for any surface inside the scan-to-commerce funnel. */
export function isScanFunnelContext(context: UtilityPanelContext): boolean {
  return context === 'scan' || context === 'scan_result';
}

export function SavedItemUtilityPanel(props: {
  item: NormalizedItem | null | undefined;
  relatedItems?: NormalizedItem[];
  context?: UtilityPanelContext;
  feedback?: Record<string, OutfitFeedbackEntry>;
  wear?: Record<string, WearTrackingEntry>;
  care?: Record<string, CareNoteEntry>;
}) {
  if (!FREE_TIER_UTILITY_ENABLED || !props.item) return null;
  const related = props.relatedItems ?? [];
  const context = props.context ?? 'library';

  // Load local utility stores if the parent did not provide them. This makes
  // the panel safe to drop into AnalysisCard / ScanResultV2 without rewiring
  // every host screen.
  const localUtility = useWardrobeUtility(related);
  const feedback = props.feedback ?? localUtility.feedback;
  const wear = props.wear ?? localUtility.wear;
  const care = props.care ?? localUtility.care;

  return (
    <>
      {context === 'scan' || context === 'product' ? (
        <WardrobeDuplicateHintCard candidate={props.item} savedItems={related} />
      ) : null}
      {props.item.brand ? <BrandSizingNoteCard brand={props.item.brand} /> : null}
      {/* Care Notes — reserved for K+ owned-item management. Withheld from the
          whole scan-to-commerce funnel: a user deciding whether to BUY a piece
          has nothing to care for yet. The component and its data model are
          intentionally left intact for that later surface. */}
      {!isScanFunnelContext(context) && context !== 'product' ? (
        <CareNoteCard itemId={props.item.id} />
      ) : null}

      {/* Rate this piece — post-ownership feedback, so it belongs to the Closet
          lifecycle and never to discovery. Kept available for owned-item
          contexts; note that no Closet surface mounts this panel today, so this
          preserves the capability rather than displaying it. */}
      {!isScanFunnelContext(context) && context !== 'product' ? (
        <OutfitRatingCard targetId={props.item.id} title="Rate this piece" />
      ) : null}

      {/* Wear tracker / cost per wear — K+ owned-item analytics. Same reasoning
          as Care Notes: meaningless before the purchase decision. */}
      {!isScanFunnelContext(context) && context !== 'product' ? (
        <CostPerWearCard item={props.item} />
      ) : null}

      {/* Shopping Intent stays in every context. It is deliberately rendered
          after the host's commerce section, never before it: the user should
          see what they can buy before being asked what they intend to do. */}
      <WishlistIntentCard item={props.item} />
      {related.length > 0 ? (
        <CompleteTheLookCard
          anchor={props.item}
          savedItems={related}
          feedback={feedback}
        />
      ) : null}
      {context === 'library' || context === 'home' ? (
        <WearAgainSuggestionCard
          items={related}
          feedback={feedback}
          wear={wear}
        />
      ) : null}
      <ShareOutfitButton item={props.item} subtle />
    </>
  );
}
