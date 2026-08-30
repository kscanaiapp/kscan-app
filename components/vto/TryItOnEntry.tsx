/**
 * The one narrow Commerce seam for VTO.
 *
 * Drops into an existing product card's action area next to whatever is
 * already there. It does not restyle the card, does not wrap Commerce in a
 * VTO context, and does not touch ranking, destination selection, or any
 * other shopping authority. Which retailer wins is Commerce's decision, made
 * before this component exists; VTO only visualizes whatever candidate the
 * user is already looking at.
 *
 * It renders nothing at all unless the item is genuinely eligible, or unless
 * the ONLY missing thing is K+ -- in which case it opens the one shared K+
 * surface (KPlusGate / KPlusEarlyAccessSheet) rather than inventing a
 * VTO-specific paywall.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { selectionTick } from '../../services/haptics';
import { KPlusGate } from '../kplus/KPlusGate';
import { useVtoAvailability } from '../../hooks/useVtoAvailability';
import { VirtualTryOnSheet } from './VirtualTryOnSheet';
import type { VtoGarmentInput, VtoOrigin } from '../../types/vto';

export interface TryItOnEntryProps {
  garment: VtoGarmentInput;
  garmentTitle: string;
  origin?: VtoOrigin;
  onShop?: () => void;
  devScenario?: string;
  testID?: string;
}

export function TryItOnEntry({
  garment,
  garmentTitle,
  origin = 'commerce_product',
  onShop,
  devScenario,
  testID,
}: TryItOnEntryProps) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const { available, upgradeOpportunity } = useVtoAvailability({
    category: garment.category,
    imageUrl: garment.imageUrl,
    productRef: garment.productRef,
  });

  const openSheet = useCallback(() => {
    selectionTick();
    setSheetVisible(true);
  }, []);

  if (!available && !upgradeOpportunity) return null;

  if (!available) {
    // Entitlement is the only gap. The shared K+ sheet owns this conversation.
    return (
      <KPlusGate source="vto_try_it_on">
        {({ openUpgrade }) => (
          <Pressable
            onPress={() => {
              selectionTick();
              openUpgrade();
            }}
            style={styles.button}
            accessibilityRole="button"
            accessibilityLabel="Try It On is available with K+"
            accessibilityHint="Opens K+ early access"
            testID={testID ? `${testID}-upgrade` : 'try-it-on-upgrade'}
          >
            <Text style={styles.label} numberOfLines={1}>
              TRY IT ON · K+
            </Text>
          </Pressable>
        )}
      </KPlusGate>
    );
  }

  return (
    <>
      <Pressable
        onPress={openSheet}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={`Try on ${garmentTitle}`}
        accessibilityHint="Opens virtual try-on with a photo you choose"
        testID={testID ?? 'try-it-on-button'}
      >
        <Text style={styles.label} numberOfLines={1}>
          TRY IT ON
        </Text>
      </Pressable>
      <VirtualTryOnSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        garment={garment}
        garmentTitle={garmentTitle}
        origin={origin}
        onShop={onShop}
        devScenario={devScenario}
      />
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    marginTop: SPACING.sm,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.champagne,
  },
  label: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plumDeep,
  },
});
