/**
 * The VTO-owned Try-On action -- the one narrow Commerce seam for VTO.
 *
 * Drops into an existing product card's action area next to whatever is
 * already there. It does not restyle the card, does not wrap Commerce in a
 * VTO context, and does not touch retailer ordering, destination selection,
 * or any other shopping authority. Which retailer wins is Commerce's
 * decision, made before this component exists; VTO only visualizes whatever
 * candidate the customer is already looking at, and reaches Shop/Watch
 * through callbacks the product surface owns.
 *
 * ONE AUTHORITY DECIDES WHAT THIS RENDERS. `useVtoMode` -> `resolveVtoMode`
 * is the single answer to "which try-on mode may this customer use for this
 * item, right now". This component holds no eligibility rule of its own: no
 * flag read, no category list, no native probe, no asset lookup, no
 * permission check, no second entitlement question.
 *
 * WHAT CHANGED IN VTO V2, AND WHY. This entry point used to gate its
 * visibility on the GENERATIVE availability answer alone. A product with a
 * governed Live asset, on a Live-capable device, rendered NO Try On at all
 * whenever the generative half was off -- which is exactly the documented
 * Live-pilot operator posture. The Live router computed `mode: 'live'` and
 * nothing could reach it. The affordance is now as available as the customer
 * genuinely is, and it SAYS WHICH MODE it will open rather than presenting
 * two very different experiences behind identical copy.
 *
 * AN UNAVAILABLE ITEM RENDERS NOTHING. Never a disabled button, never a
 * "coming soon", never a tap that reveals a dead end. The one exception is
 * the single ineligibility worth converting on -- K+ -- which opens the one
 * shared K+ surface (KPlusGate / KPlusEarlyAccessSheet) rather than a
 * VTO-specific paywall.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { selectionTick } from '../../services/haptics';
import { KPlusGate } from '../kplus/KPlusGate';
import { useVtoMode } from '../../hooks/useVtoMode';
import { useVtoSessionStatus } from '../../hooks/useVtoSessionStatus';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import {
  emitVtoEntryShown,
  emitVtoEntryUnavailable,
  emitVtoModeResolved,
} from '../../services/vto/vtoFunnelTelemetry';
import { sessionRefForDecision } from '../../services/vto/vtoEntryContract';
import { VirtualTryOnSheet } from './VirtualTryOnSheet';
import { VtoMinimizedPill } from './VtoMinimizedPill';
import type { VtoGarmentInput, VtoOrigin } from '../../types/vto';

export interface TryItOnEntryProps {
  garment: VtoGarmentInput;
  garmentTitle: string;
  origin?: VtoOrigin;
  onShop?: () => void;
  /** Opens the EXISTING Watchlist creation flow for this same product, when
   *  the product surface has one. VTO neither creates nor evaluates a watch;
   *  it only offers the action the surface already offers. */
  onWatch?: () => void;
  /** Retailer size-guide page, when Commerce has one. Presentation only. */
  sizeGuideUrl?: string | null;
  devScenario?: string;
  testID?: string;
}

/** Customer copy per mode. Live and Photo must not look identical: one is
 *  interactive and local, the other is a still image that takes a moment to
 *  create. Neither string names a technology, a model, or a vendor. */
const MODE_COPY = {
  LIVE_LOCAL: {
    label: 'TRY IT ON',
    hint: 'Opens live try-on using your camera',
  },
  PHOTOREAL_STILL: {
    label: 'TRY IT ON · PHOTO',
    hint: 'Opens photo try-on with a photo you choose. It takes a moment to create.',
  },
} as const;

export function TryItOnEntry({
  garment,
  garmentTitle,
  origin = 'commerce_product',
  onShop,
  onWatch,
  sizeGuideUrl,
  devScenario,
  testID,
}: TryItOnEntryProps) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Read-only: observing the running generation must not claim authority over
  // it. See hooks/useVtoSessionStatus.ts.
  const session = useVtoSessionStatus();

  // THE decision. Everything below reads it; nothing below re-derives it.
  const decision = useVtoMode({ garment });
  const { mode, upgradeOpportunity } = decision;

  // Funnel instrumentation, emitted once per resolved (product, mode) pair
  // rather than per render -- a product shelf re-renders constantly and an
  // impression counted per frame is not an impression.
  const emittedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${decision.productRef ?? ''}:${mode}:${decision.reasonCode ?? ''}`;
    if (emittedKeyRef.current === key) return;
    emittedKeyRef.current = key;
    emitVtoModeResolved(decision, origin);
    if (mode === 'UNAVAILABLE' && !upgradeOpportunity) {
      emitVtoEntryUnavailable(decision, origin);
    } else {
      emitVtoEntryShown(decision, origin);
    }
  }, [decision, mode, origin, upgradeOpportunity]);

  const openSheet = useCallback(() => {
    // The contract refuses a decision that is not about THIS product, so a
    // stale decision carried over from a previous card cannot open a sheet.
    const outcome = sessionRefForDecision(garment, decision, origin);
    if (!outcome.started) return;
    selectionTick();
    emitVtoEvent('vto_entry_tap', { origin, resolvedMode: outcome.session.mode.toLowerCase() });
    setMinimized(false);
    setSheetVisible(true);
  }, [decision, garment, origin]);

  const closeSheet = useCallback(() => {
    setMinimized(false);
    setSheetVisible(false);
  }, []);

  const restoreSheet = useCallback(() => {
    selectionTick();
    emitVtoEvent('vto_restored', { origin });
    setMinimized(false);
  }, [origin]);

  if (mode === 'UNAVAILABLE' && !upgradeOpportunity) return null;

  if (mode === 'UNAVAILABLE') {
    // Entitlement is the only gap. The shared K+ surface owns this
    // conversation, and this component invents no price and no tier.
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

  const copy = MODE_COPY[mode];

  return (
    <>
      <Pressable
        onPress={openSheet}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={`Try on ${garmentTitle}`}
        accessibilityHint={copy.hint}
        testID={testID ?? 'try-it-on-button'}
      >
        <Text style={styles.label} numberOfLines={1}>
          {copy.label}
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
          onWatch={onWatch}
          sizeGuideUrl={sizeGuideUrl}
          devScenario={devScenario}
          capability={decision.capability}
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
