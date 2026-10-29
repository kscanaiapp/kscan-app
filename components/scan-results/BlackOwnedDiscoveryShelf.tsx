import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import { ProductCard } from '../luxury/ProductCard';
import { SectionHeader } from '../luxury/SectionHeader';
import { openExternalUrl } from '../../services/openExternalUrl';
import type { SecondaryResponse, SecondaryProduct } from '../../services/blackOwnedDiscovery';
import { trackBlackOwnedDiscovery } from '../../services/blackOwnedDiscoveryTelemetry';

/** Prepared integration surface, deliberately unmounted in production routes. */
export function BlackOwnedDiscoveryShelf({ enabled = false, loading = false, response, onSave }: {
  enabled?: boolean; loading?: boolean; response?: SecondaryResponse;
  onSave?: (product: SecondaryProduct) => void;
}) {
  const [linkError, setLinkError] = useState(false);
  const visible = enabled && !loading && response?.status === 'ready' && response.products.length > 0;
  useEffect(() => {
    if (!visible || !response) return;
    trackBlackOwnedDiscovery('black_owned_shelf_displayed', { count: response.products.length });
    trackBlackOwnedDiscovery('black_owned_product_impression', { count: response.products.length });
  }, [visible, response]);
  if (!enabled) return null;
  if (loading) return <ActivityIndicator accessibilityLabel="Finding similar styles from Black-owned brands" color={LUXURY.colors.graphite} />;
  if (!visible || !response) return null;
  return <View style={styles.root} testID="black-owned-discovery-shelf">
    <SectionHeader title="Discover Black-Owned Brands" />
    <Text style={styles.explanation}>Similar styles from verified brands.</Text>
    {linkError ? <Text accessibilityRole="alert" style={styles.explanation}>This shop link is unavailable. Please try again.</Text> : null}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
      {response.products.map((product, position) => <ProductCard key={product.id}
        imageUrl={product.imageUrl} title={product.title} subtitle={product.brandName} price={product.price}
        ownershipIdentity={product.ownershipIdentity}
        onPress={product.productUrl ? () => {
          trackBlackOwnedDiscovery('black_owned_product_selected', { position });
          void openExternalUrl(product.productUrl).then((opened) => {
            setLinkError(!opened);
            if (opened) trackBlackOwnedDiscovery('black_owned_shop', { position });
          });
        } : undefined}
        onAddToRoom={onSave ? () => { onSave(product); trackBlackOwnedDiscovery('black_owned_save', { position }); } : undefined}
        addToRoomLabel="Save" accessibilityLabel={`${product.title}, ${product.brandName}. Similar style. Shop.`}
        style={styles.card} />)}
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({ root: { marginTop: SPACING.lg }, content: { gap: SPACING.md, paddingBottom: SPACING.xs }, card: { width: 168 }, explanation: { color: LUXURY.colors.graphite, marginBottom: SPACING.sm, fontSize: 13 } });
