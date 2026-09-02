/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C4 shared evidence renderer.
 *
 * The customer-visible proof (section 4):
 *
 *     ELISE RESPONSE
 *     From your Closet
 *       [brown loafers]        <- the focus
 *     Look 1
 *       [real garment cards]
 *     Look 2
 *       [real garment cards]
 *
 * ONE COMPONENT, BOTH PLATFORMS (section 38). iOS and Android mount this same
 * tree, so the Concierge cannot become two different products by drift.
 *
 * QUIET BY DEFAULT (section 42). A section heading carries the ownership
 * signal when everything below it is owned; per-card labels appear only for
 * mixed evidence. There is no K+ badge on individual items.
 *
 * NO MANUFACTURED GROUPS (section 44). When the server sent recommendations but
 * no looks, this renders a flat list. It never invents look groupings to make
 * the answer look more structured than the evidence is.
 */

import { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { ConciergeCard, ConciergeResult } from '../../services/concierge/conciergeModel';
import {
  conciergeAmbiguityCopy,
  conciergeGapCopy,
  conciergeSectionTitle,
} from '../../services/concierge/conciergeLabels';
import {
  CONCIERGE_IMAGE_UNAVAILABLE,
  type ConciergeImageState,
} from '../../services/concierge/conciergeImageResolver';
import { ConciergeClosetCard } from './ConciergeClosetCard';

interface Props {
  result: ConciergeResult;
  /** clientId -> image state. A missing entry reads as unavailable. */
  images: Record<string, ConciergeImageState>;
  /** Section 46. Absent -> cards are inert. */
  onCardPress?: (card: ConciergeCard) => void;
}

function ConciergeEvidenceImpl({ result, images, onCardPress }: Props) {
  // 'none' means no authoritative wardrobe evidence took part in this turn.
  // Base Elise prose stands alone, with no Closet chrome around it.
  if (result.presentation === 'none') return null;

  const imageFor = (card: ConciergeCard): ConciergeImageState =>
    (card.clientId ? images[card.clientId] : undefined) ?? CONCIERGE_IMAGE_UNAVAILABLE;

  const sectionTitle = conciergeSectionTitle(result.presentation);
  const gapCopy = conciergeGapCopy({
    gapCodes: result.gapCodes,
    evidenceIsExhaustive: result.gapEvidenceIsExhaustive,
  });

  // Cards already shown inside a look are not repeated in the flat list -- the
  // same garment appearing twice reads as two garments.
  const groupedIds = new Set(
    result.looks.flatMap((look) => look.cards.map((card) => card.candidateId)),
  );
  const ungrouped = result.cards.filter((card) => !groupedIds.has(card.candidateId));

  return (
    <View style={styles.container}>
      {sectionTitle ? (
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {sectionTitle}
        </Text>
      ) : null}

      {/* Section 21: several owned items matched and none was chosen. Said
          plainly, and without naming one of them. */}
      {result.focusAmbiguous ? (
        <Text style={styles.note}>
          {conciergeAmbiguityCopy(result.focusAmbiguousCategory)}
        </Text>
      ) : null}

      {result.focusCard ? (
        <ConciergeClosetCard
          card={result.focusCard}
          image={imageFor(result.focusCard)}
          presentation={result.presentation}
          onPress={onCardPress}
        />
      ) : null}

      {ungrouped.map((card) => (
        <ConciergeClosetCard
          key={card.candidateId}
          card={card}
          image={imageFor(card)}
          presentation={result.presentation}
          onPress={onCardPress}
        />
      ))}

      {result.looks.map((look, index) => (
        <View key={look.lookId} style={styles.lookGroup}>
          <Text style={styles.lookTitle}>{`Look ${index + 1}`}</Text>
          {look.cards.map((card) => (
            <ConciergeClosetCard
              key={`${look.lookId}-${card.candidateId}`}
              card={card}
              image={imageFor(card)}
              presentation={result.presentation}
              onPress={onCardPress}
            />
          ))}
        </View>
      ))}

      {/* Sections 27/28: at most a scoped, single note -- never a deficiency
          audit, and never a certainty the evidence cannot support.
          `conciergeGapCopy` chooses between a statement and a hedge from
          `evidenceIsExhaustive`, so the SCOPE of the claim is carried by the
          words themselves rather than by a separate disclaimer that could drift
          out of agreement with them. */}
      {gapCopy ? (
        <Text style={styles.note} testID="concierge-gap-note">
          {gapCopy}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Memoised for the same reason the card is: this renders inside a chat bubble
 * in a scrolling list, and its props change only when a new answer arrives.
 */
export const ConciergeEvidence = memo(ConciergeEvidenceImpl);

const styles = StyleSheet.create({
  container: {
    minWidth: 0,
    flexShrink: 1,
    marginTop: SPACING.sm,
  },
  sectionTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  lookGroup: {
    marginTop: SPACING.sm,
    paddingTop: SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.border,
    borderRadius: RADIUS.sm,
  },
  lookTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  note: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
    flexShrink: 1,
  },
});
