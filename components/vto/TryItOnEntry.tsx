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
 * the ONLY missing thing is K+ -- in which case it opens the one shared K+ gate
 * (KPlusGate) rather than inventing a VTO-specific paywall. For this source the
 * gate presents the paid K+ membership paywall, the same one Welcome Step 6
 * renders (services/kplus/kplusAcquisitionSurface.ts).
 *
 * CUSTOMER ACTIVATION. This is also where a product surface makes Try It On
 * discoverable, and it stays presentation: what the control does is decided by
 * services/vto/vtoDiscovery.ts from the availability answer above (nothing
 * while any authority is unresolved, never a disabled control), and the
 * optional first-use cue is an inline block above the same control that calls
 * the same handler. Neither can start a request or open a photo chooser -- the
 * sheet still asks for the photo, and for consent, exactly as before.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, type View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { selectionTick } from '../../services/haptics';
import { KPlusGate } from '../kplus/KPlusGate';
import { useVtoAvailability } from '../../hooks/useVtoAvailability';
import { useVtoActorKPlusState, useVtoAwarenessBlocker } from '../../hooks/useVtoAwareness';
import { useVtoLiveCapability } from '../../hooks/useVtoLiveCapability';
import { useVtoSessionStatus } from '../../hooks/useVtoSessionStatus';
import {
  emitVtoAwarenessImpression,
  emitVtoAwarenessTap,
  markVtoCompleted,
  markVtoInitiated,
} from '../../services/vto/vtoAwareness';
import {
  resolveVtoProductCta,
  VTO_DISCOVERY_COPY,
  type VtoAwarenessSurface,
} from '../../services/vto/vtoDiscovery';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import { VirtualTryOnSheet } from './VirtualTryOnSheet';
import { VtoFirstUseCue } from './VtoFirstUseCue';
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
  /**
   * Which customer surface this control sits on. Telemetry attribution only --
   * it changes nothing about what the control does.
   */
  surface?: VtoAwarenessSurface;
  /**
   * Opts this control in to the one-time first-use cue. Off unless the host
   * surface is a stable place to teach from AND declares its own modals through
   * useVtoAwarenessBlocker, so the cue can never appear behind one.
   */
  firstUseEducation?: boolean;
  testID?: string;
}

export function TryItOnEntry({
  garment,
  garmentTitle,
  origin = 'commerce_product',
  onShop,
  sizeGuideUrl,
  devScenario,
  surface = 'product',
  firstUseEducation = false,
  testID,
}: TryItOnEntryProps) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const controlRef = useRef<View>(null);
  // Read-only: observing the running generation must not claim authority over
  // it. See hooks/useVtoSessionStatus.ts.
  const session = useVtoSessionStatus();
  const { available, upgradeOpportunity, loading, liveRemoteEnabled, liveSupportedCategories } =
    useVtoAvailability({
      category: garment.category,
      imageUrl: garment.imageUrl,
      productRef: garment.productRef,
    });
  // The single presentation decision. 'none' covers ineligible, unavailable,
  // signed out AND still-resolving alike, so a control is never drawn and then
  // withdrawn, and an unresolved K+ answer is never sent to the K+ sheet.
  const cta = resolveVtoProductCta({ available, upgradeOpportunity, loading });
  const kplus = useVtoActorKPlusState();

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
    emitVtoAwarenessTap({ surface, kplus });
    // Opening the try-on surface is what retires the Home introduction.
    markVtoInitiated();
    setMinimized(false);
    setSheetVisible(true);
  }, [kplus, surface]);

  const closeSheet = useCallback(() => {
    setMinimized(false);
    setSheetVisible(false);
  }, []);

  const restoreSheet = useCallback(() => {
    selectionTick();
    emitVtoEvent('vto_restored', { origin });
    setMinimized(false);
  }, [origin]);

  // Counted once per surface per session, however many eligible items render.
  useEffect(() => {
    if (cta !== 'none') emitVtoAwarenessImpression({ surface, kplus });
  }, [cta, kplus, surface]);

  // A result on screen is the "completed" half of the awareness history.
  useEffect(() => {
    if (sheetVisible && session.status === 'success') markVtoCompleted();
  }, [session.status, sheetVisible]);

  // While this card's own sheet is up, no first-use cue appears anywhere.
  useVtoAwarenessBlocker(sheetVisible && !minimized);

  if (!available && !upgradeOpportunity) return null;
  if (cta === 'none') return null;

  if (cta === 'unlock') {
    // Entitlement is the only gap. The shared K+ sheet owns this conversation.
    return (
      <KPlusGate source="vto">
        {({ openUpgrade }) => {
          const unlock = () => {
            selectionTick();
            emitVtoAwarenessTap({ surface, kplus });
            openUpgrade();
          };
          return (
            <>
              {firstUseEducation ? (
                <VtoFirstUseCue cta={cta} targetRef={controlRef} onTry={unlock} />
              ) : null}
              <Pressable
                ref={controlRef}
                onPress={unlock}
                style={styles.button}
                accessibilityRole="button"
                accessibilityLabel="Try It On is available with K+"
                accessibilityHint="Opens K+ membership options"
                testID={testID ? `${testID}-upgrade` : 'try-it-on-upgrade'}
              >
                <Text style={styles.label} numberOfLines={1}>
                  {VTO_DISCOVERY_COPY.productUnlockLabel}
                </Text>
              </Pressable>
            </>
          );
        }}
      </KPlusGate>
    );
  }

  return (
    <>
      {firstUseEducation ? (
        <VtoFirstUseCue cta={cta} targetRef={controlRef} onTry={openSheet} />
      ) : null}
      <Pressable
        ref={controlRef}
        onPress={openSheet}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={`Try on ${garmentTitle}`}
        accessibilityHint="Opens virtual try-on with a photo you choose"
        testID={testID ?? 'try-it-on-button'}
      >
        <Text style={styles.label} numberOfLines={1}>
          {VTO_DISCOVERY_COPY.productLabel}
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
