import React from 'react';
import { Image, Linking, StyleSheet, Text, View } from 'react-native';
import { SecondaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { openPersistedCommerceUrl } from '../../services/dressingRoomCommerce';
import { buildVtoGarmentFromCommerceRecord } from '../../services/vto/vtoCommerceGarment';
import { LIVE_VTO_PILOT_PRODUCT } from '../../services/vto/vtoLivePilotCatalog';
import { TryItOnEntry } from './TryItOnEntry';

export function LiveVtoPilotProduct() {
  const product = LIVE_VTO_PILOT_PRODUCT;
  const garment = buildVtoGarmentFromCommerceRecord(product);
  if (!product || !garment) return null;
  const shop = () => { void openPersistedCommerceUrl(product.productUrl, (url) => Linking.openURL(url)); };
  return (
    <View style={styles.card} testID="vto-live-pilot-product">
      <Text style={styles.label}>Supported Live piece</Text>
      <Image source={{ uri: product.imageUrl }} style={styles.image} resizeMode="contain" accessibilityLabel={product.title} />
      <Text style={styles.title}>{product.title}</Text>
      <Text style={styles.label}>{product.brand}</Text>
      <TryItOnEntry garment={garment} garmentTitle={product.title} onShop={shop} testID="vto-live-pilot-try-on" />
      <SecondaryButton title="View retailer product" onPress={shop} testID="vto-live-pilot-shop" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: SPACING.md, gap: SPACING.sm, borderWidth: 1, borderColor: LUXURY.colors.hairline, borderRadius: RADIUS.md },
  image: { width: '100%', height: 180, borderRadius: RADIUS.sm },
  title: { ...LUXURY.typography.body, color: LUXURY.colors.ink },
  label: { ...LUXURY.typography.caption, color: LUXURY.colors.graphite },
});
