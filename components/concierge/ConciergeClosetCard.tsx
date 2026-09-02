/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C4 shared item card.
 *
 * One card component, both platforms (section 38). The card is the moment the
 * whole feature either earns trust or loses it -- "those are actually my
 * clothes" -- so it is built from validated structured data only and never
 * from prose.
 *
 * THREE IMAGE STATES, NO BROKEN IMAGE (sections 40/45)
 * ----------------------------------------------------
 *   ready       the resolved local file
 *   pending     a neutral placeholder while resolution runs
 *   unavailable the text/category card
 *
 * There is deliberately no error state. A missing image is not the user's
 * problem and not something they can act on, so it renders as a quiet text
 * card rather than a warning. `onError` collapses a late decode failure into
 * the same state, which is what stops a broken-image glyph appearing after the
 * URI resolved but the file turned out unusable.
 */

import { memo, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { ConciergeCard, ConciergePresentation } from '../../services/concierge/conciergeModel';
import {
  conciergeCardAccessibilityLabel,
  conciergeCardLabel,
  conciergeCardTitle,
} from '../../services/concierge/conciergeLabels';
import type { ConciergeImageState } from '../../services/concierge/conciergeImageResolver';

interface Props {
  card: ConciergeCard;
  image: ConciergeImageState;
  presentation: ConciergePresentation;
  /**
   * Section 46. Provided ONLY when an authorized Closet item-detail route
   * exists. Absent -> the card is inert, which is the correct V1 behaviour
   * rather than a new detail experience.
   */
  onPress?: (card: ConciergeCard) => void;
}

/**
 * The line under the title. Category and subtype are the honest identifying
 * facts; brand is included only when the evidence carried one.
 *
 * Never synthesised: if the server sent nothing, this renders nothing, because
 * a plausible-sounding descriptor on a card the user reads as "my clothes"
 * is a fabrication.
 */
function detailLine(card: ConciergeCard): string | null {
  const parts = [card.brand, card.subtype ?? card.category].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length ? parts.join(' · ') : null;
}

function ConciergeClosetCardImpl({ card, image, presentation, onPress }: Props) {
  // A URI that resolves but fails to decode must land in the same place as no
  // URI at all, so the fallback is driven by state rather than by `image` alone.
  const [imageFailed, setImageFailed] = useState(false);

  const label = conciergeCardLabel(card.relationship, presentation);
  const detail = detailLine(card);
  const showImage = image.status === 'ready' && !imageFailed;
  // AUDIT-CON-004. The fallback is relationship-aware: only an owned card may
  // fall back to Closet wording. Shared with the labels authority so iOS and
  // Android cannot word an ownership claim differently.
  const title = conciergeCardTitle(card);
  // Section 50. Always states the relationship in words, even when the visible
  // chip is suppressed under an all-owned heading -- a screen reader reads the
  // card, not the heading above it.
  const spokenLabel = conciergeCardAccessibilityLabel(card, presentation);
  // The chip's treatment is driven by the SERVER's provenance, never by prose:
  // an owned piece is an affirmation, everything else is a qualification, and
  // the two must not look alike at a glance.
  const isOwned = card.relationship === 'owned';

  const body = (
    <View style={[styles.card, card.isFocus && styles.cardFocus]}>
      <View style={styles.thumbWrap}>
        {showImage ? (
          <Image
            source={{ uri: image.uri }}
            style={styles.thumb}
            resizeMode="cover"
            onError={() => setImageFailed(true)}
            accessible={false}
          />
        ) : (
          // Placeholder while pending AND when unavailable. Visually identical
          // on purpose: a card that has no picture should not advertise that a
          // download failed.
          <View style={styles.thumbFallback}>
            <Text style={styles.thumbFallbackText} numberOfLines={1}>
              {(card.category ?? title).slice(0, 12)}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
        {label ? (
          <View style={[styles.labelChip, isOwned && styles.labelChipOwned]}>
            <Text
              style={[styles.labelText, isOwned && styles.labelTextOwned]}
              numberOfLines={1}
            >
              {label}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  // An inert card is still ONE object to assistive technology. Without this it
  // was read as loose fragments -- title, then detail, then possibly nothing at
  // all about who owns it.
  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={spokenLabel}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => onPress(card)}
      accessibilityRole="button"
      accessibilityLabel={spokenLabel}
    >
      {body}
    </Pressable>
  );
}

/**
 * Memoised. These cards sit inside chat bubbles in a scrolling list, and a
 * card's props change only when the server sends a new answer or its image
 * resolves -- so re-rendering them on every list render is work with no
 * possible visible effect, paid for in scroll smoothness.
 */
export const ConciergeClosetCard = memo(ConciergeClosetCardImpl);

const THUMB = 56;

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    flexShrink: 1,
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    marginTop: SPACING.xs,
  },
  // The focus is the item the answer is built around, so it reads slightly
  // stronger than the pieces paired with it.
  cardFocus: {
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.champagne,
  },
  thumbWrap: {
    width: THUMB,
    height: THUMB,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
    backgroundColor: LUXURY.colors.cream,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
  },
  thumbFallback: {
    width: THUMB,
    height: THUMB,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    backgroundColor: LUXURY.colors.cream,
  },
  thumbFallbackText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    textAlign: 'center',
  },
  meta: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
  },
  title: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.ink,
    flexShrink: 1,
  },
  detail: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    color: LUXURY.colors.graphite,
    marginTop: 1,
    flexShrink: 1,
  },
  labelChip: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: RADIUS.sm,
    backgroundColor: LUXURY.colors.cream,
  },
  // Owned reads as confirmation of something the customer already has; every
  // other relationship reads as a qualification of something they do not.
  labelChipOwned: {
    backgroundColor: LUXURY.colors.champagne,
  },
  labelText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.3,
    color: LUXURY.colors.graphite,
  },
  labelTextOwned: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
});
