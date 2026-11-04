import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { ProductCard } from '../luxury/ProductCard';
import { InlineNotice } from '../luxury/InlineNotice';
import { openExternalUrl } from '../../services/openExternalUrl';
import {
  ELISE_COMMERCE_BLACK_OWNED_EMPTY,
  ELISE_COMMERCE_NOTICE,
  type EliseCommerceResults,
} from '../../services/style-chat/eliseCommerceResults';

interface Props {
  results: EliseCommerceResults;
  testID?: string;
}

/**
 * OC-01 product results inside an Elise reply.
 *
 * Every value shown is a server-held product field. Prices are labelled as the
 * merchant's listed price at search time; nothing here states stock,
 * shipping or availability. Ownership labels come only from ProductCard's
 * verified-identity path. Tapping a card opens the merchant page through the
 * shared external-URL guard; nothing is bought, saved or tracked.
 */
export function EliseCommerceResultsBlock({ results, testID = 'elise-commerce-results' }: Props) {
  const [linkFailed, setLinkFailed] = useState(false);

  if (results.status !== 'ready') {
    const body = results.status === 'empty' && results.kind === 'black_owned'
      ? ELISE_COMMERCE_BLACK_OWNED_EMPTY
      : ELISE_COMMERCE_NOTICE[results.status];
    return (
      <InlineNotice
        variant="info"
        body={body}
        testID={`${testID}-${results.status}`}
        accessibilityLabel={body}
      />
    );
  }

  const open = (url: string) => {
    void openExternalUrl(url).then((opened) => setLinkFailed(!opened));
  };

  return (
    <View style={styles.container} testID={testID}>
      {results.kind === 'compare' ? (
        <View style={styles.table} testID={`${testID}-comparison`} accessibilityRole="summary">
          {results.products.map((p) => (
            <View key={p.number} style={styles.row}>
              <Text style={styles.rowNumber}>{p.number}</Text>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={2}>{p.title}</Text>
                <Text style={styles.rowMeta}>
                  {p.merchant} · {p.listedPrice ? `Listed ${p.listedPrice}` : 'Price not listed'}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        testID={`${testID}-shelf`}
      >
        {results.products.map((p) => (
          <ProductCard
            key={`${p.number}-${p.productUrl}`}
            imageUrl={p.imageUrl}
            title={p.title}
            subtitle={p.merchant}
            price={p.listedPrice}
            ownershipIdentity={p.ownershipIdentity}
            onPress={() => open(p.productUrl)}
            accessibilityLabel={`${p.number}. ${p.title} from ${p.merchant}${p.listedPrice ? `, listed at ${p.listedPrice}` : ''}. Opens the merchant's site.`}
            style={styles.card}
          />
        ))}
      </ScrollView>
      <Text style={styles.disclosure} testID={`${testID}-disclosure`}>
        Prices are as listed by the merchant when Elise searched and may change.
      </Text>
      {linkFailed ? (
        <Text style={styles.linkError} accessibilityLiveRegion="polite">
          That link couldn’t be opened.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: SPACING.sm, gap: SPACING.sm },
  scrollContent: { gap: SPACING.md, paddingBottom: SPACING.xs },
  card: { width: 156 },
  table: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.goldLight,
    backgroundColor: LUXURY.colors.warmWhite,
    paddingVertical: SPACING.xs,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs, gap: SPACING.sm },
  rowNumber: { color: LUXURY.colors.plum, fontWeight: '700', width: 16 },
  rowBody: { flex: 1 },
  rowTitle: { color: LUXURY.colors.ink, fontSize: 13, fontWeight: '600' },
  rowMeta: { color: LUXURY.colors.graphite, fontSize: 12, marginTop: 2 },
  disclosure: { color: LUXURY.colors.stone, fontSize: 11 },
  linkError: { color: LUXURY.colors.graphite, fontSize: 12 },
});
