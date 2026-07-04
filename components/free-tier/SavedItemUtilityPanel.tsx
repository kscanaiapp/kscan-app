/**
 * Free Tier Utility Expansion — reusable per-item utility panel.
 * Composes duplicate hint, sizing note, care note, rating, cost-per-wear,
 * wishlist intent, complete-the-look, and wear-again sections. Each section
 * hides itself when its flag is off or its data is missing — no broken
 * empty components.
 */

import React from 'react';
import type {
  CareNoteEntry,
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { FREE_TIER_UTILITY_ENABLED } from '../../constants/freeTierUtilityFlags';
import { BrandSizingNoteCard } from './BrandSizingNoteCard';
import { CareNoteCard } from './CareNoteCard';
import { CompleteTheLookCard } from './CompleteTheLookCard';
import { CostPerWearCard } from './CostPerWearCard';
import { OutfitRatingCard } from './OutfitRatingCard';
import { ShareOutfitButton } from './ShareOutfitButton';
import { WardrobeDuplicateHintCard } from './WardrobeDuplicateHintCard';
import { WearAgainSuggestionCard } from './WearAgainSuggestionCard';
import { WishlistIntentCard } from './WishlistIntentCard';

export type UtilityPanelContext = 'scan' | 'library' | 'product' | 'room' | 'home';

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

  return (
    <>
      {context === 'scan' || context === 'product' ? (
        <WardrobeDuplicateHintCard candidate={props.item} savedItems={related} />
      ) : null}
      {props.item.brand ? <BrandSizingNoteCard brand={props.item.brand} /> : null}
      {context !== 'product' ? <CareNoteCard itemId={props.item.id} /> : null}
      {context !== 'product' ? (
        <OutfitRatingCard targetId={props.item.id} title="Rate this piece" />
      ) : null}
      {context !== 'product' ? <CostPerWearCard item={props.item} /> : null}
      <WishlistIntentCard item={props.item} />
      {related.length > 0 ? (
        <CompleteTheLookCard
          anchor={props.item}
          savedItems={related}
          feedback={props.feedback}
        />
      ) : null}
      {context === 'library' || context === 'home' ? (
        <WearAgainSuggestionCard
          items={related}
          feedback={props.feedback}
          wear={props.wear}
        />
      ) : null}
      <ShareOutfitButton item={props.item} subtle />
    </>
  );
}
