/**
 * Commerce results inside a chat turn (Build 36 activation).
 *
 * REUSES `ProductShelf`. That is the point: Shop/Save/Watch gating, retailer
 * identity, price truth and the #409 commercial-usability floor already live
 * there and are already tested. A second chat-only product card would be a
 * second place for those rules to drift out of agreement.
 *
 * Every card rendered here came back from the Commerce path on this turn.
 * Nothing is rendered from Elise's prose, and the three non-result states are
 * distinct on purpose: a provider failure is not "nothing matches".
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ProductShelf, type Product } from '../ProductShelf';
import { hasCommerceProvenance } from '../../services/style-chat/commerceActivation';
// The fact is read, never re-derived: see `matchedRequestedAttribute`.
import { matchedRequestedAttribute } from '../../services/commerce/commerceRationale';
import { LUXURY, SPACING } from '../../constants/theme';

export interface CommerceProductsBlockProps {
  status: 'results' | 'no_matches' | 'error';
  products: unknown;
  /**
   * The colour the customer asked for and how hard they asked, echoed from the
   * shopping intent. Presentation only -- ranking already happened.
   */
  requestedColor?: string | null;
  colorStrength?: 'EXPLICIT_PREFERENCE' | 'STRONG_EXPLICIT_PREFERENCE' | null;
  testID?: string;
}

/**
 * Copy per state.
 *
 * "I couldn't check live options right now" and "I couldn't find a current
 * option" are different sentences because they are different facts, and
 * telling someone nothing matched when the lookup failed is a lie the app
 * would have no way to correct.
 */
const NO_MATCHES_COPY = "I couldn't find a current option that fits those constraints.";
const ERROR_COPY = "I couldn't check live options right now.";

/**
 * Nothing matched the colour they insisted on, but real alternatives came back.
 *
 * THIS IS NOT A NO-RESULTS STATE, and it must not read like one: the customer
 * has options, they simply are not the colour asked for. Saying so plainly is
 * the whole job -- what must never happen is a brown boot sitting silently
 * under a request for black, as though it answered it.
 */
const noPreferredMatchCopy = (color: string) =>
  `I couldn't find a strong ${color} match right now, but these are the closest alternatives.`;

export function CommerceProductsBlock({
  status,
  products,
  requestedColor,
  colorStrength,
  testID,
}: CommerceProductsBlockProps) {
  if (status === 'error') {
    return (
      <View style={styles.state} testID={testID ? `${testID}-error` : undefined}>
        <Text style={styles.stateText}>{ERROR_COPY}</Text>
      </View>
    );
  }

  // Re-checked at RENDER time, not only at write time: a persisted block that
  // was edited, or that arrived from an older build, must not be able to put a
  // card on screen without Commerce provenance.
  const verified = (Array.isArray(products) ? products : []).filter(hasCommerceProvenance) as Product[];

  if (status === 'no_matches' || verified.length === 0) {
    return (
      <View style={styles.state} testID={testID ? `${testID}-empty` : undefined}>
        <Text style={styles.stateText}>{NO_MATCHES_COPY}</Text>
      </View>
    );
  }

  // A strong request is the only one that earns a split shelf. An ordinary
  // preference needs no explanation for a near-miss being on the list, and
  // splitting every shelf would make the distinction meaningless where it
  // matters.
  const shouldGroup =
    colorStrength === 'STRONG_EXPLICIT_PREFERENCE' &&
    typeof requestedColor === 'string' &&
    requestedColor.length > 0;

  if (!shouldGroup) {
    return (
      <View testID={testID}>
        <ProductShelf products={verified} label="OPTIONS" testID={testID ? `${testID}-shelf` : undefined} />
      </View>
    );
  }

  // ORDER IS PRESERVED WITHIN EACH GROUP. This partitions the shelf the ranker
  // produced; it does not re-rank it, and a candidate cannot change position
  // relative to another in the same group.
  const best = verified.filter(matchedRequestedAttribute);
  const other = verified.filter((product) => !matchedRequestedAttribute(product));

  // Nothing in the requested colour, but real alternatives did come back.
  if (best.length === 0) {
    return (
      <View testID={testID}>
        <Text style={styles.stateText} testID={testID ? `${testID}-no-preferred-match` : undefined}>
          {noPreferredMatchCopy(requestedColor)}
        </Text>
        <ProductShelf
          products={other}
          label="OTHER OPTIONS"
          testID={testID ? `${testID}-shelf-other` : undefined}
        />
      </View>
    );
  }

  return (
    <View testID={testID}>
      <ProductShelf
        products={best}
        label="BEST MATCHES"
        testID={testID ? `${testID}-shelf-best` : undefined}
      />
      {other.length > 0 ? (
        <ProductShelf
          products={other}
          label="OTHER OPTIONS"
          testID={testID ? `${testID}-shelf-other` : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  state: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  stateText: {
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 18,
  },
});
