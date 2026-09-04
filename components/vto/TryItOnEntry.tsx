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
import { useVtoLiveCapability } from '../../hooks/useVtoLiveCapability';
import { useVtoSessionStatus } from '../../hooks/useVtoSessionStatus';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import { VirtualTryOnSheet } from './VirtualTryOnSheet';
import { VtoMinimizedPill } from './VtoMinimizedPill';
import type { VtoGarmentInput, VtoOrigin } from '../../types/vto';

export interface TryItOnEntryProps {
  garment: VtoGarmentInput;
  garmentTitle: string;
  origin?: VtoOrigin;
  onShop?: () => void;
  /** Retailer size-guide page, when Commerce has one. Presentation only. */
  sizeGuideUrl?: string | null;
  devScenario?: string;
  testID?: string;
}

export function TryItOnEntry({
  garment,
  garmentTitle,
  origin = 'commerce_product',
  onShop,
  sizeGuideUrl,
  devScenario,
  testID,
}: TryItOnEntryProps) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Read-only: observing the running generation must not claim authority over
  // it. See hooks/useVtoSessionStatus.ts.
  const session = useVtoSessionStatus();
  const { available, upgradeOpportunity, liveRemoteEnabled, liveSupportedCategories } =
    useVtoAvailability({
      category: garment.category,
      imageUrl: garment.imageUrl,
      productRef: garment.productRef,
    });

  // The capability router is asked HERE, once, and its answer is handed to the
  // sheet -- rather than the sheet asking again and the two possibly
  // disagreeing about the same garment. It changes nothing about this entry
  // point: the button below is still governed by `available` /
  // `upgradeOpportunity` exactly as before, because a Live-capable build must
  // not add a second Try It On, only a second mode behind the existing one.
  const capability = useVtoLiveCapability({
    garment,
    aiPhotoAvailable: available,
    liveRemoteEnabled,
    liveSupportedCategories,
  });

  const openSheet = useCallback(() => {
    selectionTick();
    setMinimized(false);
    setSheetVisible(true);
  }, []);

  const closeSheet = useCallback(() => {
    setMinimized(false);
    setSheetVisible(false);
  }, []);

  const restoreSheet = useCallback(() => {
    selectionTick();
    emitVtoEvent('vto_restored', { origin });
    setMinimized(false);
  }, [origin]);

  if (!available && !upgradeOpportunity) return null;

  if (!available) {
    // Entitlement is the only gap. The shared K+ sheet owns this conversation.
    return (
      <KPlusGate source="vto">
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
      {/*
          Mounted only while open, deliberately. The sheet binds the
          module-scoped VTO store and tears the operation down on unmount, so
          an always-mounted copy per product card would mean any card
          re-rendering could wipe an in-flight try-on started from another.
          One card, one sheet, one operation.
      */}
      {sheetVisible ? (
        <VirtualTryOnSheet
          visible={!minimized}
          onClose={closeSheet}
          onMinimize={() => setMinimized(true)}
          garment={garment}
          garmentTitle={garmentTitle}
          origin={origin}
          onShop={onShop}
          sizeGuideUrl={sizeGuideUrl}
          devScenario={devScenario}
          capability={capability}
        />
      ) : null}
      {/*
          MINIMIZED, NOT UNMOUNTED. The sheet above stays mounted while
          collapsed and is merely made invisible, because useVirtualTryOn calls
          leaveVtoSurface on unmount -- rendering it conditionally on
          `!minimized` would cancel the very generation the pill is reporting
          on. Only the owning card shows a pill: `sheetVisible` is per-card
          state, so other product cards render nothing.
      */}
      {sheetVisible && minimized ? (
        <VtoMinimizedPill
          ready={session.status === 'success'}
          onPress={restoreSheet}
          testID={testID ? `${testID}-pill` : undefined}
        />
      ) : null}
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
