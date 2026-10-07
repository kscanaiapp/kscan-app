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
 *
 * SHARED LAUNCHER. The sheet, its collapsed state and the minimized pill are
 * not this component's any more: they belong to VtoLaunchHost, which Elise's
 * contextual offer mounts too. This file keeps what is specific to a product
 * card -- whether to offer the control, what it says, and the K+ seam -- and
 * hands an already-eligible garment to the one shared surface.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { selectionTick } from '../../services/haptics';
import { KScanIcon } from '../icons/kscan';
import { KPlusGate } from '../kplus/KPlusGate';
import { useVtoAvailability } from '../../hooks/useVtoAvailability';
import { useVtoActorKPlusState } from '../../hooks/useVtoAwareness';
import { useVtoLiveCapability } from '../../hooks/useVtoLiveCapability';
import { emitVtoAwarenessImpression, emitVtoAwarenessTap } from '../../services/vto/vtoAwareness';
import {
  resolveVtoProductCta,
  VTO_DISCOVERY_COPY,
  type VtoAwarenessSurface,
} from '../../services/vto/vtoDiscovery';
import { VtoFirstUseCue } from './VtoFirstUseCue';
import { useVtoLaunchHost, VtoLaunchHost } from './VtoLaunchHost';
import type { VtoGarmentInput, VtoOrigin } from '../../types/vto';

export interface TryItOnEntryProps {
  garment: VtoGarmentInput;
  garmentTitle: string;
  origin?: VtoOrigin;
  onShop?: () => void;
  onWatch?: () => void;
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
  onWatch,
  sizeGuideUrl,
  devScenario,
  surface = 'product',
  firstUseEducation = false,
  testID,
}: TryItOnEntryProps) {
  const controlRef = useRef<View>(null);
  // The shared launch lifecycle: sheet, collapse, pill. Per-card state, so only
  // the card that opened a try-on shows its sheet and its pill.
  const launch = useVtoLaunchHost({ origin, onWatch });
  const { available, upgradeOpportunity, loading, liveRemoteEnabled, liveSupportedCategories } =
    useVtoAvailability({
      category: garment.category,
      imageUrl: garment.imageUrl,
      productRef: garment.productRef,
      ownedMediaReady: garment.source?.type === 'closet_item' && garment.ownedMediaReady === true,
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

  const openLaunch = launch.open;
  const openSheet = useCallback(() => {
    selectionTick();
    emitVtoAwarenessTap({ surface, kplus });
    openLaunch();
  }, [kplus, openLaunch, surface]);

  // Counted once per surface per session, however many eligible items render.
  useEffect(() => {
    if (cta !== 'none') emitVtoAwarenessImpression({ surface, kplus });
  }, [cta, kplus, surface]);

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
                style={({ pressed }) => [styles.button, styles.buttonUnlock, pressed && styles.buttonUnlockPressed]}
                accessibilityRole="button"
                accessibilityLabel="Try It On is available with K+"
                accessibilityHint="Opens K+ membership options"
                testID={testID ? `${testID}-upgrade` : 'try-it-on-upgrade'}
              >
                <View
                  style={styles.buttonContent}
                  accessible={false}
                  importantForAccessibility="no"
                  accessibilityElementsHidden
                >
                  <KScanIcon
                    name="try-on"
                    size={16}
                    variant="compact"
                    color={LUXURY.colors.plumDeep}
                    accentColor={LUXURY.colors.gold}
                  />
                  <Text style={[styles.label, styles.labelUnlock]} numberOfLines={1}>
                    {VTO_DISCOVERY_COPY.productUnlockLabel}
                  </Text>
                </View>
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
        style={({ pressed }) => [styles.button, styles.buttonTryOn, pressed && styles.buttonTryOnPressed]}
        accessibilityRole="button"
        accessibilityLabel={`Try on ${garmentTitle}`}
        accessibilityHint="Opens virtual try-on with a photo you choose"
        testID={testID ?? 'try-it-on-button'}
      >
        <View
          style={styles.buttonContent}
          accessible={false}
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          <KScanIcon
            name="try-on"
            size={16}
            variant="compact"
            color={LUXURY.colors.pearl}
            accentColor={LUXURY.colors.goldLight}
          />
          <Text style={[styles.label, styles.labelTryOn]} numberOfLines={1}>
            {VTO_DISCOVERY_COPY.productLabel}
          </Text>
        </View>
      </Pressable>
      {/*
          The one shared VTO surface. It mounts the sheet only while this card's
          try-on is open and keeps it mounted while collapsed -- see
          VtoLaunchHost for why both of those are load-bearing.
      */}
      <VtoLaunchHost
        launch={launch}
        garment={garment}
        garmentTitle={garmentTitle}
        origin={origin}
        onShop={onShop}
        onWatch={onWatch}
        sizeGuideUrl={sizeGuideUrl}
        devScenario={devScenario}
        capability={capability}
        testID={testID}
      />
    </>
  );
}

const styles = StyleSheet.create({
  // The product-level Try It On is the natural next action on an eligible
  // item, so it reads as the one primary control on the card: a filled pill
  // with the canonical garment glyph, not another bordered utility row.
  button: {
    marginTop: SPACING.sm,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  buttonTryOn: {
    backgroundColor: LUXURY.colors.plumDeep,
  },
  buttonTryOnPressed: {
    backgroundColor: LUXURY.colors.plum,
  },
  // K+ membership context is expressed warmly -- the same action in a softer
  // champagne treatment with the membership named in the label -- never as a
  // locked or disabled control.
  buttonUnlock: {
    backgroundColor: LUXURY.colors.champagne,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
  },
  buttonUnlockPressed: {
    backgroundColor: LUXURY.colors.goldLight,
  },
  label: {
    ...LUXURY.typography.cta,
    fontSize: 12,
  },
  labelTryOn: {
    color: LUXURY.colors.pearl,
  },
  labelUnlock: {
    color: LUXURY.colors.plumDeep,
  },
});
