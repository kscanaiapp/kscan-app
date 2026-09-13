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
import { LUXURY, SPACING } from '../../constants/theme';

export interface CommerceProductsBlockProps {
  status: 'results' | 'no_matches' | 'error';
  products: unknown;
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

export function CommerceProductsBlock({ status, products, testID }: CommerceProductsBlockProps) {
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

  return (
    <View testID={testID}>
      <ProductShelf products={verified} label="OPTIONS" testID={testID ? `${testID}-shelf` : undefined} />
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
