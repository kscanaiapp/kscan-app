/**
 * "See It On You" -- the VTO Alpha experience.
 *
 * Built on the existing luxury design system rather than a VTO-specific one:
 * LuxuryButton, InlineNotice, the LUXURY tokens, MODAL_MAX_WIDTH, the shared
 * haptics, and useReducedMotion. VTO gets no bespoke motion infrastructure.
 *
 * The flow is guidance -> selection -> review -> generating -> result, and it
 * is deliberately short. The one thing that earns real screen area is the
 * result, because the whole point is to reduce uncertainty about how an item
 * would look -- everything before it is overhead.
 *
 * The output is always labelled as an AI visualization, and it never claims
 * anything about fit or size.
 *
 * BUILD 35 DECISION LOOP. The result is a decision tool, not a picture:
 * TRY -> RESULT -> COMPARE -> DECIDE. What it may offer, and in what order, is
 * decided by services/vto/vtoDecisionLoop.ts and only rendered here:
 *
 *   primary    Shop            -- only when Commerce handed us a destination
 *   secondary  Save, Watch     -- each only when its existing path exists
 *   tertiary   Try again (same piece), Try another piece (back to the options)
 *
 * Compare is a local view switch on the image (your photo <-> the try-on); it
 * never fetches, never generates. A result is shown only for the product it
 * was generated for -- `vtoResultBelongsToProduct` fails closed otherwise --
 * so no Shop/Watch/Save can ever be offered for product B under product A's
 * try-on. TRY != SAVE != WATCH != SHOP != OWN: nothing here records any of
 * them; each action hands off to the authority that already owns it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { InlineNotice, PrimaryButton, SecondaryButton, TertiaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';
import { selectionTick, successPulse, warningPulse } from '../../services/haptics';
import { openExternalUrl } from '../../services/openExternalUrl';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useVirtualTryOn } from '../../hooks/useVirtualTryOn';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import {
  emitVtoCaptureCompleted,
  emitVtoHandoffReady,
  emitVtoResultShop,
  emitVtoResultWatch,
} from '../../services/vto/vtoFunnelTelemetry';
import { emitKPlusEvent } from '../../services/kplus/kplusTelemetry';
import {
  resolveVtoProgress,
  VTO_PROGRESS_STAGES,
} from '../../services/vto/vtoProgressStages';
import {
  formatVtoRetryGuidance,
  planVtoLiveDecision,
  planVtoResultActions,
  VTO_DECISION_COPY,
  vtoFailureOffersRetry,
  vtoResultBelongsToProduct,
  vtoRetryCooldownMs,
} from '../../services/vto/vtoDecisionLoop';
import { VtoSaveToDressingRoom } from './VtoSaveToDressingRoom';
import { VtoSilhouetteGuide } from './VtoSilhouetteGuide';
import { VtoLiveErrorBoundary } from './VtoLiveErrorBoundary';
import { VtoLivePanel } from './VtoLivePanel';
import { VtoModeSelector, type VtoSurfaceMode } from './VtoModeSelector';
import { useVtoLiveSession } from '../../hooks/useVtoLiveSession';
import { evaluateLiveGarmentEligibility } from '../../services/vto/vtoLiveGarment';
import {
  defaultVtoMode,
  shouldOfferModeChoice,
  type VtoCapability,
} from '../../services/vto/vtoLiveCapability';
import type { VtoGarmentInput, VtoOrigin } from '../../types/vto';

export interface VirtualTryOnSheetProps {
  visible: boolean;
  onClose: () => void;
  garment: VtoGarmentInput;
  garmentTitle: string;
  origin: VtoOrigin;
  /** Opens the retailer page. Commerce keeps owning where "Shop" goes. */
  onShop?: () => void;
  /**
   * Opens the EXISTING Watchlist creation flow for this same product.
   *
   * Supplied only by a product surface that already offers Watch for this
   * row, and only where that surface's own server-authored capability says
   * the listing may be watched. VTO neither creates a watch, evaluates
   * whether one is possible, nor knows what a watch is -- absent the prop the
   * action is simply not rendered, which is the same rule `onShop` follows.
   *
   * TryItOnEntry collapses this sheet before calling through, so the surface's
   * own Watch modal is never asked to present on top of this one.
   */
  onWatch?: () => void;
  /**
   * Collapses the sheet while a generation runs. Supplying this is what makes
   * the surface minimizable. The owner MUST keep this component mounted while
   * collapsed -- unmounting calls leaveVtoSurface and tears the running
   * generation down, which is the whole thing minimize exists to avoid.
   */
  onMinimize?: () => void;
  /**
   * Retailer size-guide page for this product, when Commerce has one.
   * PRESENTATION ONLY -- deliberately not a field on VtoGarmentInput, which is
   * the provider-facing contract and is parity-checked against the Edge
   * Function. A try-on must never become a sizing input.
   */
  sizeGuideUrl?: string | null;
  devScenario?: string;
  /**
   * The capability router's answer for this garment.
   *
   * OPTIONAL, AND ITS ABSENCE IS THE EXISTING BEHAVIOUR. When it is missing --
   * or when it says anything other than "both modes are available" -- this
   * sheet renders precisely the AI Photo experience it rendered before Live
   * existed: no mode selector, no Live panel, no camera permission, no extra
   * chrome. Live is not a state this sheet degrades into; it is a state it
   * only enters when the router affirmatively says so.
   *
   * It is a prop rather than a hook call because TryItOnEntry has already
   * resolved availability for this same garment, and asking twice would mean
   * two answers that could disagree.
   */
  capability?: VtoCapability;
  testID?: string;
}

const PHOTO_GUIDANCE = [
  'Use a clear, front-facing photo of yourself.',
  'Make sure the area the item would cover is visible.',
];

/** How often the elapsed clock is re-read while generating. The stage model
 *  is coarse (seconds, not frames), so 1s is ample and cheap. */
const PROGRESS_TICK_MS = 1_000;

/** Shown under every result. VTO visualizes; it never predicts fit, so the
 *  disclaimer sends people to the retailer's own sizing information rather
 *  than implying the picture answers that question. */
const DISCLAIMER_LEAD = 'AI-generated visualization for inspiration only. Check the ';
const DISCLAIMER_LINK = 'size guide';
const DISCLAIMER_TAIL = ' for your exact fit.';

const SIZE_GUIDE_UNAVAILABLE =
  'This size guide could not be opened right now.';

/** Downward drag (px) past which the grabber collapses the sheet. */
const MINIMIZE_SWIPE_THRESHOLD = 60;

export function VirtualTryOnSheet({
  visible,
  onClose,
  garment,
  garmentTitle,
  origin,
  onShop,
  onWatch,
  onMinimize,
  sizeGuideUrl,
  devScenario,
  capability,
  testID,
}: VirtualTryOnSheetProps) {
  const vto = useVirtualTryOn({ garment, origin, devScenario });
  const reducedMotion = useReducedMotion();
  const [elapsedMs, setElapsedMs] = useState(0);
  // Compare is a local view switch between two images already on the device:
  // the try-on (in memory) and the photo the customer chose (in the cache).
  const [showOriginal, setShowOriginal] = useState(false);
  // Local only: re-enables Try again once the server's Retry-After guidance
  // has elapsed. It schedules no request and retries nothing by itself.
  const [retryCoolingDown, setRetryCoolingDown] = useState(false);
  const pulse = useRef(new Animated.Value(0.55)).current;

  // ── Live VTO ───────────────────────────────────────────────────────────────
  // Everything below is inert unless the router affirmatively offers Live.
  // `liveOffered` false -- the case on every build today -- means the rest of
  // this component behaves exactly as it did before Live existed.
  const liveOffered = capability ? shouldOfferModeChoice(capability) : false;
  const [mode, setMode] = useState<VtoSurfaceMode>(() =>
    capability ? defaultVtoMode(capability) : 'ai_photo',
  );
  const [liveCrashed, setLiveCrashed] = useState(false);

  // If the capability answer changes under us (a garment swap, a kill switch
  // arriving) and Live stops being on offer, the surface returns to AI Photo
  // rather than sitting on a mode that no longer exists.
  useEffect(() => {
    if (!liveOffered && mode !== 'ai_photo') setMode('ai_photo');
  }, [liveOffered, mode]);

  const liveDescriptor = useMemo(() => {
    if (!liveOffered) return null;
    const eligibility = evaluateLiveGarmentEligibility({ garment });
    return eligibility.eligible ? eligibility.descriptor : null;
  }, [liveOffered, garment]);

  // Called unconditionally to satisfy the rules of hooks. With a null
  // descriptor it starts nothing, subscribes to nothing, and never loads the
  // native module or the camera.
  const live = useVtoLiveSession({
    descriptor: liveDescriptor,
    // The clean person frame joins the ORDINARY generative flow here: same
    // store, same client, same Edge Function, same governance. The visible
    // surface switches to the generative view while the Live session stays
    // alive behind it, so a completed or failed generation can return to Live.
    onPhotorealPerson: (person) => {
      // The still exists and passed the clean-frame + sanitizer gate. Both
      // events are content-free: they record that a capture happened and that
      // it is ready for the governed backend, never anything about the image.
      emitVtoCaptureCompleted(origin);
      emitVtoHandoffReady(origin, true);
      vto.adoptPerson(person);
      vto.generate();
      setMode('ai_photo');
    },
  });

  // A refused handoff is as much a funnel fact as an accepted one: without it
  // the gap between "captured" and "requested" is unexplained. Content-free --
  // it carries no failure text, no code, and nothing about the still.
  const photorealFailure = live.photorealFailure;
  useEffect(() => {
    if (photorealFailure) emitVtoHandoffReady(origin, false);
  }, [photorealFailure, origin]);

  const liveVisible = liveOffered && mode === 'live' && !liveCrashed;
  const aiPhotoVisible = !liveVisible;

  // NOTHING INVISIBLE MAY HOLD THE CAMERA.
  //
  // Three ways the Live surface can stop being on screen while its runtime is
  // still alive, and all three have to tear it down:
  //
  //   1. The sheet was MINIMIZED. It stays mounted on purpose -- unmounting
  //      would kill the generation the pill is reporting on -- so a Live
  //      session started earlier would otherwise keep running behind a
  //      collapsed surface.
  //   2. Live stopped being OFFERED mid-session: the operator kill switch
  //      flipped, the actor's entitlement lapsed, or the garment changed to one
  //      Live cannot render. The panel unmounts as soon as `liveOffered` goes
  //      false, and without this the runtime would outlive the decision that
  //      withdrew it.
  //   3. The Live panel CRASHED and the boundary fell back to AI Photo.
  //
  // Merely switching to AI Photo is deliberately NOT in that list: a Photoreal
  // generation is supposed to leave the session alive so the customer can
  // return to Live afterwards.
  //
  // Tearing down rather than pausing, because this is a privacy question and
  // not a battery one. Re-entering Live costs one tap.
  const liveEntered = live.entered;
  const liveSurfaceWithdrawn = !visible || !liveOffered || liveCrashed;
  useEffect(() => {
    if (liveSurfaceWithdrawn && liveEntered) live.exitLive();
  }, [liveSurfaceWithdrawn, liveEntered, live]);

  const handleSelectMode = useCallback((next: VtoSurfaceMode) => {
    setMode(next);
    emitVtoEvent('vto_mode_selected', { origin, mode: next });
  }, [origin]);

  // A Live render exception costs Live and nothing else -- see
  // components/vto/VtoLiveErrorBoundary.tsx.
  const handleLiveCrash = useCallback(() => {
    setLiveCrashed(true);
    setMode('ai_photo');
  }, []);

  const isGenerating = vto.status === 'preparing' || vto.status === 'generating'
    || vto.status === 'validating_result';

  // Once per opened sheet. `visible` also goes false/true when the surface is
  // minimized and restored, and a restore is not a new impression.
  const impressionRef = useRef(false);
  useEffect(() => {
    if (!visible || impressionRef.current) return;
    impressionRef.current = true;
    emitVtoEvent('vto_entry_impression', { origin });
  }, [visible, origin]);

  // One clock for the whole preparing -> generating -> validating_result span,
  // started when that span begins. The stage model consumes it; it is never
  // used to decide that the generation FINISHED.
  useEffect(() => {
    if (!isGenerating) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, PROGRESS_TICK_MS);
    return () => clearInterval(timer);
  }, [isGenerating]);

  useEffect(() => {
    if (!isGenerating || reducedMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isGenerating, reducedMotion, pulse]);

  useEffect(() => {
    if (vto.status === 'success') successPulse();
    if (vto.status === 'failed') warningPulse();
  }, [vto.status]);

  // Section 22: VTO generation is a real, deterministic K+ feature operation.
  // Instrumentation only, edge-triggered off the existing status machine so a
  // re-render on the same status never re-fires either event -- reachable
  // only through the K+ gate (useVtoAvailability requires the entitlement),
  // so entitlement_state is always 'active' here.
  const vtoStartedRef = useRef(false);
  useEffect(() => {
    if (isGenerating && !vtoStartedRef.current) {
      vtoStartedRef.current = true;
      emitKPlusEvent('kplus_feature_started', {
        source: 'vto',
        feature: 'vto',
        entitlement_state: 'active',
      });
    }
    if (!isGenerating) vtoStartedRef.current = false;
  }, [isGenerating]);

  const vtoCompletedRef = useRef<string | null>(null);
  useEffect(() => {
    if (vto.status === 'success' && vtoCompletedRef.current !== vto.status) {
      vtoCompletedRef.current = vto.status;
      emitKPlusEvent('kplus_feature_completed', {
        source: 'vto',
        feature: 'vto',
        entitlement_state: 'active',
      });
    }
    if (vto.status !== 'success') vtoCompletedRef.current = null;
  }, [vto.status]);

  // A new result replaces whatever the comparison toggle was showing.
  useEffect(() => {
    if (vto.status === 'success') setShowOriginal(false);
  }, [vto.status, vto.result]);

  // BLOCK-VTO-DL-00. The result on screen must be THIS product's result.
  const resultOnScreen = vtoResultBelongsToProduct(vto, garment);

  // One "viewed" fact per result, and one screen-reader announcement, keyed
  // on the request that produced it so a re-render is not a second view.
  const viewedRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!resultOnScreen || !visible || !vto.requestId) return;
    if (viewedRequestRef.current === vto.requestId) return;
    viewedRequestRef.current = vto.requestId;
    emitVtoEvent('vto_result_viewed', { origin, mode: 'ai_photo' });
    AccessibilityInfo.announceForAccessibility?.('Your try-on is ready.');
  }, [resultOnScreen, visible, vto.requestId, origin]);

  // Retry-After: guidance becomes a temporary local disable, nothing more.
  const failure = vto.status === 'failed' ? vto.failure : null;
  useEffect(() => {
    const cooldownMs = vtoRetryCooldownMs(failure);
    if (cooldownMs <= 0) {
      setRetryCoolingDown(false);
      return;
    }
    setRetryCoolingDown(true);
    const cooldownTimer = setTimeout(() => setRetryCoolingDown(false), cooldownMs);
    return () => clearTimeout(cooldownTimer);
  }, [failure]);

  const handleSelectPhoto = useCallback(async () => {
    selectionTick();
    emitVtoEvent('vto_entry_tap', { origin });
    const outcome = await vto.selectPerson();
    // `!== false` rather than truthiness: this project's tsconfig leaves
    // strictNullChecks off, and the explicit comparison is what narrows a
    // discriminated union under it.
    if (outcome.ok !== false) return;
    // No 'permission_denied' branch: the system photo picker needs no
    // media-library permission, so pickVtoPersonInput no longer asks for one
    // and can no longer report one. See services/vto/vtoPersonInput.ts.
    if (outcome.reason === 'invalid_person_input') {
      Alert.alert('Photo Unavailable', 'That photo could not be prepared. Try another one.', [
        { text: 'OK' },
      ]);
    }
    // 'cancelled' is a no-op: closing the picker is not an error.
  }, [origin, vto]);

  const handleClose = useCallback(() => {
    // Soft close: the session's person photo survives for the next product
    // this actor tries on. leaveVtoSurface also runs on unmount, which this
    // triggers via onClose -- calling it here too just makes the teardown
    // happen before the close animation instead of after.
    emitVtoEvent('vto_exited', { origin, mode });
    vto.dismiss();
    onClose();
  }, [onClose, vto, origin, mode]);

  // "Try another piece" is a soft close with a different intent: the sheet is
  // a modal over the product surface the customer came from (a shelf, the
  // purchase options), so closing it IS returning to the alternatives -- the
  // scanner is not restarted, the shelf keeps its own state, and nothing is
  // generated until they choose another piece and tap Try it on. The session
  // photo stays, so that next try-on does not ask for it again.
  const handleTryAnother = useCallback(() => {
    selectionTick();
    emitVtoEvent('vto_result_try_another', { origin, mode });
    vto.dismiss();
    onClose();
  }, [onClose, vto, origin, mode]);

  // Collapsing is NOT cancelling and NOT closing. It calls neither dismiss nor
  // leaveVtoSurface: the request lives in the module-scoped store and keeps
  // running while the owner keeps this component mounted.
  const canMinimize = !!onMinimize && isGenerating;

  const handleMinimize = useCallback(() => {
    if (!onMinimize) return;
    selectionTick();
    emitVtoEvent('vto_minimized', { origin });
    onMinimize();
  }, [onMinimize, origin]);

  // Swipe down on the grabber. While a generation runs this collapses; with
  // nothing in flight there is nothing to keep alive, so it closes instead.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 12 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.5,
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy < MINIMIZE_SWIPE_THRESHOLD) return;
          if (canMinimize) {
            handleMinimize();
            return;
          }
          handleClose();
        },
      }),
    [canMinimize, handleMinimize, handleClose],
  );

  const handleRemovePhoto = useCallback(() => {
    selectionTick();
    vto.clearPerson();
  }, [vto]);

  // The URL is retailer-supplied, so it goes through the shared guard
  // (https only, no credentials, no private hosts) rather than Linking direct.
  const handleOpenSizeGuide = useCallback(async () => {
    selectionTick();
    const opened = await openExternalUrl(sizeGuideUrl);
    if (!opened) Alert.alert('Size guide unavailable', SIZE_GUIDE_UNAVAILABLE, [{ text: 'OK' }]);
  }, [sizeGuideUrl]);

  const handleSelectCompare = useCallback((original: boolean) => {
    if (original === showOriginal) return;
    selectionTick();
    emitVtoEvent('vto_result_compare_toggle', { origin });
    setShowOriginal(original);
  }, [origin, showOriginal]);

  // The stage shown is the LATER of the real status floor and the elapsed
  // clock, and `complete` can only ever come from the store. See
  // services/vto/vtoProgressStages.ts for the honesty rule.
  const progress = resolveVtoProgress({ status: vto.status, elapsedMs });

  const comparisonAvailable = resultOnScreen && !!vto.person?.sanitizedUri;

  const displayUri = !resultOnScreen
    ? null
    : showOriginal && vto.person
      ? vto.person.sanitizedUri
      : vto.result?.dataUri ?? null;

  const resultPlan = planVtoResultActions({
    canShop: !!onShop,
    canWatch: !!onWatch,
    canSave: resultOnScreen,
  });
  const liveDecision = planVtoLiveDecision({ canShop: !!onShop, canWatch: !!onWatch });
  const failureOffersRetry = vtoFailureOffersRetry(failure);
  const retryGuidance = failureOffersRetry
    ? formatVtoRetryGuidance(failure?.retryAfterSeconds)
    : null;

  // ONE Shop and ONE Watch element, reused by the Photo result and the Live
  // decision exit, so both reach Commerce through exactly the same callback.
  // Each renders only when the surface supplied its callback; the `disabled`
  // guard is defence in depth, never the visible state (BLOCK-VTO-DL-04).
  const renderShop = (surfaceMode: VtoSurfaceMode, primary: boolean) => {
    const ShopButton = primary ? PrimaryButton : SecondaryButton;
    return (
      <ShopButton
        title="Shop this piece"
        onPress={() => {
          selectionTick();
          emitVtoResultShop(origin, surfaceMode);
          onShop?.();
        }}
        disabled={!onShop}
        accessibilityHint="Opens this listing"
        testID="vto-shop"
      />
    );
  };
  const renderWatch = (surfaceMode: VtoSurfaceMode, style?: ViewStyle) =>
    onWatch ? (
      <SecondaryButton
        title="Watch this piece"
        onPress={() => {
          selectionTick();
          emitVtoResultWatch(origin, surfaceMode);
          onWatch();
        }}
        accessibilityHint="Opens Watch for this listing"
        style={style}
        testID="vto-watch"
      />
    ) : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={handleClose}
      testID={testID ?? 'vto-sheet'}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {/* Drag affordance. The gesture is a convenience only -- the
              Minimize and Close buttons carry the same actions for anyone
              who cannot perform a swipe. */}
          <View
            {...panResponder.panHandlers}
            style={styles.grabberArea}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            testID="vto-grabber"
          >
            <View style={styles.grabber} />
          </View>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>SEE IT ON YOU</Text>
            <Text style={styles.title} numberOfLines={2}>
              {garmentTitle}
            </Text>
          </View>

          <ScrollView
            contentContainerStyle={styles.body}
            showsVerticalScrollIndicator={false}
          >
            {/* Rendered only when BOTH modes genuinely work. There is no
                disabled Live tab and no "coming soon" state: when Live is
                unavailable this is simply absent. */}
            {liveOffered ? (
              <VtoModeSelector mode={mode} onChange={handleSelectMode} />
            ) : null}

            {liveVisible ? (
              <VtoLiveErrorBoundary
                onFallback={handleLiveCrash}
                fallback={
                  <InlineNotice
                    variant="error"
                    title="Live isn’t available"
                    body="You can still create an AI photo below."
                    testID="vto-live-boundary-fallback"
                    style={styles.notice}
                  />
                }
              >
                <VtoLivePanel
                  session={live.session}
                  entered={live.entered}
                  photorealFailure={live.photorealFailure}
                  previewUri={live.previewUri}
                  photorealPending={live.photorealPending}
                  onEnter={() => {
                    void live.enterLive();
                  }}
                  onRetry={() => {
                    void live.retryLive();
                  }}
                  onClose={() => {
                    live.exitLive();
                    setMode('ai_photo');
                  }}
                  onSwitchToAiPhoto={() => setMode('ai_photo')}
                  onRequestPhotoreal={() => {
                    void live.requestPhotoreal();
                  }}
                  onCapturePreview={() => {
                    void live.capturePreview();
                  }}
                  onDismissPhotorealFailure={live.dismissPhotorealFailure}
                />
              </VtoLiveErrorBoundary>
            ) : null}

            {aiPhotoVisible ? (
              <>
            {resultOnScreen && displayUri ? (
              <View style={styles.resultBlock}>
                {/* Compare: two images already on this device, switched
                    locally. No fetch, no generation, no fit claim -- it only
                    helps answer "do I like this on me?". */}
                {comparisonAvailable ? (
                  <View
                    style={styles.compareSwitch}
                    accessibilityRole="tablist"
                    accessibilityLabel="Compare the try-on with your original photo"
                    testID="vto-compare-toggle"
                  >
                    {[
                      { original: false, label: VTO_DECISION_COPY.compareTryOn, testID: 'vto-compare-try-on' },
                      { original: true, label: VTO_DECISION_COPY.compareOriginal, testID: 'vto-compare-original' },
                    ].map((option) => {
                      const selected = showOriginal === option.original;
                      return (
                        <Pressable
                          key={option.testID}
                          onPress={() => handleSelectCompare(option.original)}
                          accessibilityRole="tab"
                          accessibilityState={{ selected }}
                          accessibilityLabel={option.original ? 'Your original photo' : 'The try-on'}
                          style={[styles.compareOption, selected ? styles.compareOptionSelected : null]}
                          testID={option.testID}
                        >
                          <Text
                            style={[styles.compareText, selected ? styles.compareTextSelected : null]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                <View style={styles.resultFrame}>
                  <Image
                    source={{ uri: displayUri }}
                    style={styles.resultImage}
                    resizeMode="contain"
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={
                      showOriginal
                        ? 'Your original photo'
                        : `AI visualization of ${garmentTitle} on your photo`
                    }
                    testID="vto-result-image"
                  />
                  {/* Which image this is, in words -- never colour alone. */}
                  <Text style={styles.imageBadge} importantForAccessibility="no">
                    {showOriginal ? VTO_DECISION_COPY.originalBadge : VTO_DECISION_COPY.tryOnBadge}
                  </Text>
                </View>
                <Text style={styles.aiLabel}>
                  AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION
                </Text>
                {/* Sizing is the single most common misreading of a try-on:
                    the picture shows how a piece might look, never whether it
                    fits. The link is rendered only when Commerce actually
                    supplied a size guide; otherwise the same sentence reads
                    as plain text rather than a dead link. */}
                <Text style={styles.disclaimer} testID="vto-size-disclaimer">
                  {DISCLAIMER_LEAD}
                  {sizeGuideUrl ? (
                    <Text
                      style={styles.disclaimerLink}
                      onPress={() => {
                        void handleOpenSizeGuide();
                      }}
                      accessibilityRole="link"
                      accessibilityHint="Opens the retailer size guide"
                      testID="vto-size-guide-link"
                    >
                      {DISCLAIMER_LINK}
                    </Text>
                  ) : (
                    DISCLAIMER_LINK
                  )}
                  {DISCLAIMER_TAIL}
                </Text>
                {/* What was tried, from the product reference that entered
                    VTO -- nothing re-fetched, nothing inferred. Brand only
                    when Commerce supplied one; no price is restated here,
                    because a try-on is not a fresh read of commerce truth. */}
                <View style={styles.identityBlock} testID="vto-result-identity">
                  <Text style={styles.identityEyebrow}>{VTO_DECISION_COPY.resultEyebrow}</Text>
                  <Text style={styles.identityTitle} numberOfLines={2}>
                    {garment.brand ? `${garment.brand} · ${garmentTitle}` : garmentTitle}
                  </Text>
                  <Text style={styles.decisionPrompt}>{VTO_DECISION_COPY.decisionPrompt}</Text>
                </View>
              </View>
            ) : null}

            {progress.running ? (
              <View
                style={styles.generatingBlock}
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={`Step ${progress.index + 1} of ${progress.total}: ${progress.stage.label}`}
                accessibilityLiveRegion="polite"
                testID="vto-generating"
              >
                <Animated.View style={[styles.pulse, { opacity: pulse }]} />
                <ActivityIndicator size="large" color={LUXURY.colors.plum} />
                <Text style={styles.generatingText}>{progress.stage.label}</Text>
                {/* Named steps rather than a percentage: the provider reports no
                    progress fraction, so a number would be invented. */}
                <View style={styles.stepRow} accessible={false} importantForAccessibility="no">
                  {VTO_PROGRESS_STAGES.map((stage, index) => (
                    <View
                      key={stage.key}
                      style={[
                        styles.stepDot,
                        index <= progress.index ? styles.stepDotReached : null,
                      ]}
                    />
                  ))}
                </View>
                <Text style={styles.stepCount}>
                  {`STEP ${progress.index + 1} OF ${progress.total}`}
                </Text>
                {progress.stillWorking ? (
                  <Text style={styles.stillWorking} testID="vto-still-working">
                    {canMinimize
                      ? VTO_DECISION_COPY.stillWorking
                      : VTO_DECISION_COPY.stillWorkingNoMinimize}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {vto.status === 'failed' && vto.failure ? (
              <InlineNotice
                variant="error"
                title="Try-on didn't finish"
                body={retryGuidance ? `${vto.failure.message} ${retryGuidance}` : vto.failure.message}
                accessibilityRole="alert"
                testID="vto-failure-notice"
                style={styles.notice}
              />
            ) : null}

            {vto.status === 'cancelled' ? (
              <InlineNotice
                variant="info"
                title="Cancelled"
                body="Nothing was saved. You can start again whenever you like."
                testID="vto-cancelled-notice"
                style={styles.notice}
              />
            ) : null}

            {!vto.person && !isGenerating && vto.status !== 'success' ? (
              <View style={styles.guidanceBlock}>
                {/* Framing guide: a drawing, not a detector. It runs no pose
                    estimation and never grades or refuses a photo -- it only
                    shows the shape a good try-on photo fills, at the one
                    moment that is still cheap to influence. */}
                <VtoSilhouetteGuide />
                {PHOTO_GUIDANCE.map((line) => (
                  <Text key={line} style={styles.guidance}>
                    {line}
                  </Text>
                ))}
                <Text style={styles.privacyNote}>
                  Your photo is stripped of its metadata and sent for this try-on only.
                  It is not saved to your Closet and not kept afterwards.
                </Text>
              </View>
            ) : null}

            {vto.person && !isGenerating && vto.status !== 'success' ? (
              <>
                <View style={styles.reviewRow} testID="vto-review">
                  <Image
                    source={{ uri: vto.person.sanitizedUri }}
                    style={styles.reviewThumb}
                    accessibilityLabel="The photo you chose"
                  />
                  {garment.imageUrl ? (
                    <Image
                      source={{ uri: garment.imageUrl }}
                      style={styles.reviewThumb}
                      accessibilityLabel={`${garmentTitle} product image`}
                    />
                  ) : null}
                </View>
                {/* Reused across products in this session (hooks/useVirtualTryOn.ts) --
                    this is the one explicit way to drop it instead of replacing it. */}
                <Pressable
                  onPress={handleRemovePhoto}
                  accessibilityRole="button"
                  accessibilityLabel="Remove this photo"
                  style={styles.removePhotoLink}
                  testID="vto-remove-photo"
                >
                  <Text style={styles.removePhotoText}>REMOVE PHOTO</Text>
                </Pressable>
              </>
            ) : null}
              </>
            ) : null}
          </ScrollView>

          <View style={styles.actions}>
            {/* The Live panel carries its own controls, so the generative
                action row is rendered only for the AI Photo view. Close stays
                below for both, as the one way out of the sheet. */}
            {aiPhotoVisible ? (
              <>
            {isGenerating ? (
              <>
                {canMinimize ? (
                  <SecondaryButton
                    title="Minimize"
                    onPress={handleMinimize}
                    testID="vto-minimize"
                  />
                ) : null}
                <SecondaryButton title="Cancel" onPress={vto.cancel} testID="vto-cancel" />
              </>
            ) : resultOnScreen ? (
              <>
                {/* PRIMARY -- Shop, only when Commerce supplied a destination.
                    Without one the screen says so in words: no dead button. */}
                {resultPlan.primary === 'shop' ? (
                  renderShop(mode, true)
                ) : (
                  <Text style={styles.shopUnavailable} testID="vto-shop-unavailable">
                    {VTO_DECISION_COPY.shopUnavailable}
                  </Text>
                )}
                {/* SECONDARY -- Save this try-on, Watch this piece. The save
                    bridge is the ONE durable path, and only on a tap. */}
                <View style={styles.secondaryRow}>
                  <VtoSaveToDressingRoom
                    dataUri={vto.result?.dataUri ?? null}
                    requestId={vto.result?.requestId ?? null}
                    category={garment.category}
                    brand={garment.brand}
                    productRef={garment.productRef}
                    origin={origin}
                    onLeaveForDressingRoom={handleClose}
                    style={styles.secondaryCell}
                  />
                  {onWatch ? renderWatch(mode, styles.secondaryCell) : null}
                </View>
                {/* TERTIARY -- the same piece again, or a different piece. */}
                <View style={styles.tertiaryRow}>
                  <TertiaryButton
                    title={VTO_DECISION_COPY.tryAgain}
                    onPress={vto.retry}
                    accessibilityHint={VTO_DECISION_COPY.tryAgainHint}
                    style={styles.tertiaryCell}
                    testID="vto-retry"
                  />
                  <TertiaryButton
                    title={VTO_DECISION_COPY.tryAnother}
                    onPress={handleTryAnother}
                    accessibilityHint={VTO_DECISION_COPY.tryAnotherHint}
                    style={styles.tertiaryCell}
                    testID="vto-try-another"
                  />
                </View>
              </>
            ) : vto.status === 'success' ? null : vto.person ? (
              <>
                {/* A failure that is not retryable offers no regenerate. For
                    request_in_flight that is the point: `retry` opens a NEW
                    intent, i.e. a second paid job beside the one the server
                    just said is still running. */}
                {vto.status !== 'failed' || failureOffersRetry ? (
                  <PrimaryButton
                    title={vto.status === 'failed' ? 'Try again' : 'Try it on'}
                    onPress={vto.status === 'failed' ? vto.retry : vto.generate}
                    disabled={!vto.canGenerate || (vto.status === 'failed' && retryCoolingDown)}
                    testID="vto-generate"
                  />
                ) : null}
                <SecondaryButton
                  title="Choose a different photo"
                  onPress={handleSelectPhoto}
                  testID="vto-change-photo"
                />
              </>
            ) : (
              <PrimaryButton
                title="Choose a photo"
                onPress={handleSelectPhoto}
                testID="vto-choose-photo"
              />
            )}
              </>
            ) : null}
            {/* LIVE DECISION EXIT. Live renders nothing persistent, so there
                is no result to save or compare and none is manufactured: no
                frame is captured to make this look like the Photo result.
                The customer gets the commerce decisions the surface already
                offers, and a way back to the other options. */}
            {liveVisible && live.entered ? (
              <>
                <Text style={styles.decisionPrompt} testID="vto-live-decision">
                  {VTO_DECISION_COPY.liveDecisionPrompt}
                </Text>
                {liveDecision.actions.includes('shop') ? renderShop('live', false) : null}
                {onWatch && liveDecision.actions.includes('watch') ? renderWatch('live') : null}
                <TertiaryButton
                  title={VTO_DECISION_COPY.tryAnother}
                  onPress={handleTryAnother}
                  accessibilityHint={VTO_DECISION_COPY.tryAnotherHint}
                  testID="vto-live-try-another"
                />
              </>
            ) : null}
            <TertiaryButton title="Close" onPress={handleClose} testID="vto-close" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(28, 22, 34, 0.62)',
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
    maxHeight: '92%',
    backgroundColor: LUXURY.colors.warmWhite,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.lg,
  },
  grabberArea: {
    alignItems: 'center',
    paddingBottom: SPACING.sm,
    // A generous target: the drag zone should be easy to find without
    // stealing scroll gestures from the body below it.
    paddingTop: SPACING.xs,
  },
  grabber: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: LUXURY.colors.hairline,
  },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  eyebrow: {
    ...LUXURY.typography.sectionLabel,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    marginTop: SPACING.xs,
  },
  body: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  guidanceBlock: {
    marginTop: SPACING.xs,
  },
  guidance: {
    ...LUXURY.typography.body,
    marginBottom: SPACING.xs,
  },
  privacyNote: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.sm,
    letterSpacing: 0.2,
    textTransform: 'none',
    lineHeight: 18,
  },
  reviewRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  reviewThumb: {
    width: 96,
    height: 128,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
  },
  removePhotoLink: {
    alignSelf: 'flex-start',
    marginTop: SPACING.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  removePhotoText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  generatingBlock: {
    alignItems: 'center',
    paddingVertical: SPACING.xl,
  },
  pulse: {
    position: 'absolute',
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: LUXURY.colors.plumMuted,
  },
  generatingText: {
    ...LUXURY.typography.body,
    marginTop: SPACING.md,
  },
  stepRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
    marginTop: SPACING.md,
  },
  stepDot: {
    width: 28,
    height: 3,
    borderRadius: 2,
    backgroundColor: LUXURY.colors.hairline,
  },
  stepDotReached: {
    backgroundColor: LUXURY.colors.plum,
  },
  stepCount: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.sm,
    color: LUXURY.colors.stone,
  },
  resultBlock: {
    alignItems: 'center',
  },
  resultFrame: {
    width: '100%',
  },
  resultImage: {
    width: '100%',
    aspectRatio: 0.8,
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.champagne,
  },
  imageBadge: {
    ...LUXURY.typography.caption,
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    overflow: 'hidden',
    backgroundColor: LUXURY.colors.warmWhite,
    color: LUXURY.colors.plumDeep,
  },
  identityBlock: {
    alignSelf: 'stretch',
    marginTop: SPACING.md,
    paddingTop: SPACING.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: LUXURY.colors.hairline,
  },
  identityEyebrow: {
    ...LUXURY.typography.sectionLabel,
  },
  identityTitle: {
    ...LUXURY.typography.body,
    marginTop: SPACING.xs,
    color: LUXURY.colors.ink,
  },
  decisionPrompt: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.xs,
    textTransform: 'none',
    letterSpacing: 0.2,
    color: LUXURY.colors.stone,
  },
  shopUnavailable: {
    ...LUXURY.typography.caption,
    textAlign: 'center',
    textTransform: 'none',
    letterSpacing: 0.2,
    color: LUXURY.colors.stone,
  },
  secondaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  secondaryCell: {
    flexGrow: 1,
    flexBasis: 140,
  },
  tertiaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  tertiaryCell: {
    flexGrow: 1,
    flexBasis: 120,
  },
  stillWorking: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.sm,
    textAlign: 'center',
    textTransform: 'none',
    letterSpacing: 0.2,
    color: LUXURY.colors.stone,
  },
  aiLabel: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  disclaimer: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.sm,
    textAlign: 'center',
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 18,
    color: LUXURY.colors.stone,
  },
  disclaimerLink: {
    color: LUXURY.colors.plum,
    textDecorationLine: 'underline',
  },
  compareSwitch: {
    flexDirection: 'row',
    alignSelf: 'center',
    marginBottom: SPACING.sm,
    padding: 2,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  compareOption: {
    minHeight: 44,
    minWidth: 104,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compareOptionSelected: {
    backgroundColor: LUXURY.colors.plumDeep,
  },
  compareText: {
    ...LUXURY.typography.caption,
  },
  compareTextSelected: {
    color: LUXURY.colors.inverse,
  },
  notice: {
    marginTop: SPACING.md,
  },
  actions: {
    paddingHorizontal: SPACING.lg,
    gap: SPACING.sm,
  },
});
