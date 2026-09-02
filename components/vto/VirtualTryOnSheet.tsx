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
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
} from 'react-native';

import { InlineNotice, PrimaryButton, SecondaryButton, TertiaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';
import { selectionTick, successPulse, warningPulse } from '../../services/haptics';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useVirtualTryOn } from '../../hooks/useVirtualTryOn';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import { emitKPlusEvent } from '../../services/kplus/kplusTelemetry';
import {
  resolveVtoProgress,
  VTO_PROGRESS_STAGES,
} from '../../services/vto/vtoProgressStages';
import { VtoSaveToDressingRoom } from './VtoSaveToDressingRoom';
import { VtoSilhouetteGuide } from './VtoSilhouetteGuide';
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
   * Collapses the sheet while a generation runs. Supplying this is what makes
   * the surface minimizable. The owner MUST keep this component mounted while
   * collapsed -- unmounting calls leaveVtoSurface and tears the running
   * generation down, which is the whole thing minimize exists to avoid.
   */
  onMinimize?: () => void;
  devScenario?: string;
  testID?: string;
}

const PHOTO_GUIDANCE = [
  'Use a clear, front-facing photo of yourself.',
  'Make sure the area the item would cover is visible.',
];

/** How often the elapsed clock is re-read while generating. The stage model
 *  is coarse (seconds, not frames), so 1s is ample and cheap. */
const PROGRESS_TICK_MS = 1_000;

/** Downward drag (px) past which the grabber collapses the sheet. */
const MINIMIZE_SWIPE_THRESHOLD = 60;

export function VirtualTryOnSheet({
  visible,
  onClose,
  garment,
  garmentTitle,
  origin,
  onShop,
  onMinimize,
  devScenario,
  testID,
}: VirtualTryOnSheetProps) {
  const vto = useVirtualTryOn({ garment, origin, devScenario });
  const reducedMotion = useReducedMotion();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const pulse = useRef(new Animated.Value(0.55)).current;

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

  const handleSelectPhoto = useCallback(async () => {
    selectionTick();
    emitVtoEvent('vto_entry_tap', { origin });
    const outcome = await vto.selectPerson();
    // `!== false` rather than truthiness: this project's tsconfig leaves
    // strictNullChecks off, and the explicit comparison is what narrows a
    // discriminated union under it.
    if (outcome.ok !== false) return;
    if (outcome.reason === 'permission_denied') {
      Alert.alert(
        'Photo Access Required',
        'Allow K Scan AI to access your photo library in Settings to try items on.',
        [{ text: 'OK' }],
      );
      return;
    }
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
    vto.dismiss();
    onClose();
  }, [onClose, vto]);

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

  const handleToggleCompare = useCallback(() => {
    selectionTick();
    setShowOriginal((current) => {
      emitVtoEvent('vto_result_compare_toggle', { origin });
      return !current;
    });
  }, [origin]);

  // The stage shown is the LATER of the real status floor and the elapsed
  // clock, and `complete` can only ever come from the store. See
  // services/vto/vtoProgressStages.ts for the honesty rule.
  const progress = resolveVtoProgress({ status: vto.status, elapsedMs });

  const comparisonAvailable = useMemo(
    () => vto.status === 'success' && !!vto.person?.sanitizedUri && !!vto.result,
    [vto.status, vto.person, vto.result],
  );

  const displayUri = showOriginal && vto.person
    ? vto.person.sanitizedUri
    : vto.result?.dataUri ?? null;

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
            {vto.status === 'success' && displayUri ? (
              <View style={styles.resultBlock}>
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
                <Text style={styles.aiLabel}>
                  AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION
                </Text>
                {/* The ONE durable path out of a session-scoped result, and
                    only on an explicit tap. Quarantined in its own component
                    so this sheet keeps zero persistence imports. */}
                <VtoSaveToDressingRoom
                  dataUri={vto.result?.dataUri ?? null}
                  requestId={vto.result?.requestId ?? null}
                  category={garment.category}
                  brand={garment.brand}
                  productRef={garment.productRef}
                  origin={origin}
                />
                {comparisonAvailable ? (
                  <Pressable
                    onPress={handleToggleCompare}
                    accessibilityRole="button"
                    accessibilityLabel={showOriginal ? 'Show the try-on' : 'Show your original photo'}
                    style={styles.compareToggle}
                    testID="vto-compare-toggle"
                  >
                    <Text style={styles.compareText}>
                      {showOriginal ? 'SHOW TRY-ON' : 'SHOW ORIGINAL'}
                    </Text>
                  </Pressable>
                ) : null}
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
              </View>
            ) : null}

            {vto.status === 'failed' && vto.failure ? (
              <InlineNotice
                variant="error"
                title="Try-on didn't finish"
                body={vto.failure.message}
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
          </ScrollView>

          <View style={styles.actions}>
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
            ) : vto.status === 'success' ? (
              <>
                <PrimaryButton
                  title="Shop this piece"
                  onPress={() => {
                    selectionTick();
                    onShop?.();
                  }}
                  disabled={!onShop}
                  testID="vto-shop"
                />
                <SecondaryButton title="Try again" onPress={vto.retry} testID="vto-retry" />
              </>
            ) : vto.person ? (
              <>
                <PrimaryButton
                  title={vto.status === 'failed' && vto.failure?.retryable ? 'Try again' : 'Try it on'}
                  onPress={vto.status === 'failed' ? vto.retry : vto.generate}
                  disabled={!vto.canGenerate}
                  testID="vto-generate"
                />
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
  resultImage: {
    width: '100%',
    aspectRatio: 0.8,
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.champagne,
  },
  aiLabel: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  compareToggle: {
    marginTop: SPACING.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    minHeight: 44,
    justifyContent: 'center',
  },
  compareText: {
    ...LUXURY.typography.caption,
  },
  notice: {
    marginTop: SPACING.md,
  },
  actions: {
    paddingHorizontal: SPACING.lg,
    gap: SPACING.sm,
  },
});
