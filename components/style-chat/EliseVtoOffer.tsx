/**
 * Elise's contextual Try It On offer.
 *
 * ONE UI OBJECT. The invitation and the button are rendered together from this
 * component or not at all. Neither is ever written by the model: Elise gives
 * fashion advice, and the application appends this block when — and only when —
 * it has itself determined that the uploaded garment can be visualized.
 *
 * WHAT IT IS GIVEN. An opaque local binding id from the persisted message, and
 * nothing else. The garment it refers to lives on this device, under this
 * account, and is resolved here every time.
 *
 * PRESENTATION follows the SAME single decision as the product control
 * (services/vto/vtoDiscovery.ts#resolveVtoProductCta), asked of the same
 * availability hook, so the two entry points cannot disagree:
 *
 *   unresolved (K+ or the remote row still loading)  nothing is drawn
 *   VTO off, or the category no longer supported      nothing is drawn
 *   eligible but for K+                               the offer, behind the ONE
 *                                                     shared K+ gate
 *   eligible                                          the offer, opening the
 *                                                     shared VTO launcher
 *
 * and, specific to a device-local source:
 *
 *   the id resolves to nothing here                   a bounded "unavailable"
 *                                                     line (another device,
 *                                                     another account, an
 *                                                     expired upload)
 *
 * EVERY TAP REVALIDATES. The binding is re-read under the current account and
 * the candidate is checked against the fingerprint the offer was created for.
 * A mismatch ends in the same bounded line. It never picks another garment.
 *
 * NOTHING HERE COSTS ANYTHING. Rendering, tapping, meeting the K+ gate and
 * opening the sheet read no image and send nothing. The person photo, the
 * consent step and the generation all still live inside the governed sheet.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useVtoAvailability } from '../../hooks/useVtoAvailability';
import { useVtoActorKPlusState } from '../../hooks/useVtoAwareness';
import { selectionTick } from '../../services/haptics';
import { ELISE_VTO_OFFER_COPY } from '../../services/style-chat/eliseVtoOffer';
import {
  peekEliseVtoOffer,
  resolveEliseVtoOfferLaunch,
  type EliseVtoOfferLaunch,
} from '../../services/style-chat/eliseVtoUploadSource';
import { resolveVtoProductCta } from '../../services/vto/vtoDiscovery';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import { VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE } from '../../types/vto';
import { KScanIcon } from '../icons/kscan';
import { KPlusGate } from '../kplus/KPlusGate';
import { useVtoLaunchHost, VtoLaunchHost } from '../vto/VtoLaunchHost';

const ORIGIN = 'elise' as const;

type ResolvedLaunch = Extract<EliseVtoOfferLaunch, { ok: true }>;

/** undefined: not read yet. null: this id resolves to nothing on this device. */
type PeekedBinding = { canonicalCategory: string } | null | undefined;

export interface EliseVtoOfferProps {
  /** Opaque id from the persisted `elise_vto_offer` block. */
  localBindingId: string;
  testID?: string;
}

export function EliseVtoOffer({ localBindingId, testID = 'elise-vto-offer' }: EliseVtoOfferProps) {
  const { user } = useAuthSession();
  const actorId = user?.id ?? null;
  const [binding, setBinding] = useState<PeekedBinding>(undefined);
  const [stale, setStale] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<ResolvedLaunch | null>(null);
  const mountedRef = useRef(true);
  const tapTokenRef = useRef(0);
  const renderedRef = useRef(false);

  const launch = useVtoLaunchHost({ origin: ORIGIN });
  const kplus = useVtoActorKPlusState();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Which garment category this offer was created for. Read from the
  // device-local binding for the CURRENT account, and re-read whenever the
  // account or the id changes, so a previous account's answer is never reused.
  useEffect(() => {
    let cancelled = false;
    tapTokenRef.current += 1;
    setBinding(undefined);
    setStale(false);
    setResolving(false);
    setResolved(null);
    void peekEliseVtoOffer(localBindingId).then((next) => {
      if (!cancelled && mountedRef.current) setBinding(next);
    });
    return () => {
      cancelled = true;
    };
  }, [actorId, localBindingId]);

  const { available, upgradeOpportunity, loading } = useVtoAvailability({
    category: binding ? binding.canonicalCategory : null,
    imageUrl: null,
    productRef: binding ? VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE : null,
    inlineMediaReady: binding != null,
  });
  // The single presentation decision, shared with the product control.
  const cta = resolveVtoProductCta({ available, upgradeOpportunity, loading });
  const unavailable = binding === null || stale;
  const offered = !unavailable && binding !== undefined && cta !== 'none';

  // Counted once per mounted offer, and only when the offer is really shown.
  useEffect(() => {
    if (!offered || renderedRef.current) return;
    renderedRef.current = true;
    emitVtoEvent('elise_vto_offer_rendered', { origin: ORIGIN, actor_kplus_state: kplus });
  }, [kplus, offered]);

  const markUnavailable = useCallback((reasonCode: string) => {
    emitVtoEvent('elise_vto_offer_unavailable', { origin: ORIGIN, reasonCode });
    setResolved(null);
    setStale(true);
  }, []);

  /**
   * The tap. Revalidates the exact garment first, and only then acts on the
   * answer the caller already holds about K+. Nothing here reads the image or
   * starts a request.
   */
  const handleTap = useCallback(
    async (proceed: (next: ResolvedLaunch) => void) => {
      if (resolving) return;
      selectionTick();
      emitVtoEvent('elise_vto_offer_tapped', { origin: ORIGIN, actor_kplus_state: kplus });
      const token = (tapTokenRef.current += 1);
      setResolving(true);
      const outcome = await resolveEliseVtoOfferLaunch(localBindingId);
      // A newer tap, an unmount or an account change owns the answer now.
      if (!mountedRef.current || token !== tapTokenRef.current) return;
      setResolving(false);
      if (outcome.ok === false) {
        markUnavailable(outcome.reason);
        return;
      }
      proceed(outcome);
    },
    [kplus, localBindingId, markUnavailable, resolving],
  );

  const openLaunch = launch.open;
  const openTryOn = useCallback(() => {
    void handleTap((next) => {
      setResolved(next);
      emitVtoEvent('elise_vto_offer_launched', { origin: ORIGIN, actor_kplus_state: kplus });
      openLaunch();
    });
  }, [handleTap, kplus, openLaunch]);

  if (unavailable) {
    return (
      <View style={styles.block} testID={`${testID}-unavailable`}>
        <Text style={styles.unavailable} accessibilityRole="text">
          {ELISE_VTO_OFFER_COPY.unavailable}
        </Text>
      </View>
    );
  }

  // Not read yet, still resolving, VTO off, or no longer a supported category:
  // neither the sentence nor the button. They appear together or not at all.
  if (!offered) return null;

  if (cta === 'unlock') {
    // Entitlement is the only gap. The shared K+ gate owns that conversation;
    // this offer stays exactly where it is and works on the next tap once the
    // canonical K+ answer changes.
    return (
      <KPlusGate source="vto">
        {({ openUpgrade }) => (
          <OfferBody
            testID={testID}
            busy={resolving}
            unlock
            onPress={() => {
              void handleTap(() => {
                emitVtoEvent('elise_vto_offer_kplus_gate', { origin: ORIGIN, actor_kplus_state: kplus });
                openUpgrade();
              });
            }}
          />
        )}
      </KPlusGate>
    );
  }

  return (
    <>
      <OfferBody testID={testID} busy={resolving} onPress={openTryOn} />
      {/*
          The one shared VTO surface, mounted only once a tap has resolved the
          exact garment. No Shop and no Watch are passed: an uploaded photo has
          no retailer destination, and the sheet hides what it is not given.
      */}
      {resolved ? (
        <VtoLaunchHost
          launch={launch}
          garment={resolved.garment}
          garmentTitle={resolved.garmentTitle}
          origin={ORIGIN}
          loadInlineGarment={resolved.loadInlineGarment}
          testID={testID}
        />
      ) : null}
    </>
  );
}

function OfferBody({
  testID,
  busy,
  unlock = false,
  onPress,
}: {
  testID: string;
  busy: boolean;
  unlock?: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.block} testID={testID}>
      <Text style={styles.invitation} accessibilityRole="text">
        {ELISE_VTO_OFFER_COPY.invitation}
      </Text>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          unlock ? styles.buttonUnlock : styles.buttonTryOn,
          pressed && (unlock ? styles.buttonUnlockPressed : styles.buttonTryOnPressed),
        ]}
        accessibilityRole="button"
        accessibilityLabel={ELISE_VTO_OFFER_COPY.ctaAccessibilityLabel}
        accessibilityHint={ELISE_VTO_OFFER_COPY.ctaAccessibilityHint}
        accessibilityState={{ busy }}
        testID={`${testID}-cta`}
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
            color={unlock ? LUXURY.colors.plumDeep : LUXURY.colors.pearl}
            accentColor={unlock ? LUXURY.colors.gold : LUXURY.colors.goldLight}
          />
          <Text style={[styles.label, unlock ? styles.labelUnlock : styles.labelTryOn]} numberOfLines={1}>
            {ELISE_VTO_OFFER_COPY.cta}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    marginTop: SPACING.sm,
    minWidth: 0,
    flexShrink: 1,
  },
  // Reads as Elise's own next line, in the bubble's body voice.
  invitation: {
    ...LUXURY.typography.body,
    fontSize: 15,
    lineHeight: 22,
    color: LUXURY.colors.ink,
    flexShrink: 1,
    minWidth: 0,
  },
  unavailable: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    flexShrink: 1,
    minWidth: 0,
  },
  // The same filled pill and canonical glyph as the product Try It On control.
  button: {
    marginTop: SPACING.sm,
    minHeight: 44,
    alignSelf: 'flex-start',
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
