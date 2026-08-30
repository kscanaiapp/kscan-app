// Mirror Selfie intake and PRE-STAGING extraction review (Build 2.5 Step 3).
//
// ── WHAT THIS SURFACE REVIEWS ───────────────────────────────────────────────
//
// Whether each crop is a usable picture of a piece of clothing, and whether the
// user wants to keep it. That is all.
//
// It is NOT the Closet candidate review. It deliberately does not mount, wrap,
// or imitate ClosetBatchReviewPanel, and it shows no classification, no
// taxonomy, no duplicate state, no candidate state, no promotion control, no
// product, no price and no Recent Scan. Nothing here has been identified yet —
// identification is Step 4's `identify_for_closet` — so any garment label this
// screen displayed would be invented.
//
// ── WHAT THE CROPS ARE CALLED ───────────────────────────────────────────────
//
// "Detected garment 2 of 4", not "Jacket". Geometric extraction knows which
// part of the body a crop covers; it does not know what garment is on it, and a
// shoulders-to-hip band may well contain a coat over a jumper. The review badge
// exists to say exactly that, in the user's language.
//
// Guard contract mirrors ClosetIntakeModal and StyleChatPhotoIntake:
//   - single in-flight picker operation, monotonic operation id
//   - late picker results discarded after supersede or unmount
//   - picker cancellation is a silent no-op, never an error
//   - permission denial is a controlled outcome with guidance, not a crash

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { hasUsablePhotoLibraryAccess } from '../../services/photoLibraryAccess';
import { useMirrorExtraction } from '../../hooks/useMirrorExtraction';
import type {
  MirrorExtractionErrorCode,
  MirrorExtractionSelection,
} from '../../types/mirrorExtraction';

/**
 * User-facing copy for every bounded outcome.
 *
 * Exhaustive by construction, so a new error code cannot reach the user as a
 * blank space — and free of filesystem paths and native exception text by
 * construction, because there is nowhere here for either to be interpolated.
 */
const OUTCOME_COPY: Record<MirrorExtractionErrorCode, { title: string; body: string }> = {
  mirror_source_unreadable: {
    title: "That photo couldn't be opened",
    body: 'Try choosing it again, or pick a different photo.',
  },
  mirror_source_unsupported: {
    title: "That photo couldn't be read",
    body: 'Try a JPEG or PNG photo taken with your phone.',
  },
  mirror_source_dimensions_invalid: {
    title: "That photo couldn't be read",
    body: 'Try a different photo.',
  },
  mirror_source_too_small: {
    title: 'That photo is a little too small',
    body: 'Try a larger photo so we can pick out what you are wearing.',
  },
  mirror_source_too_large: {
    title: 'That photo is very large',
    body: 'Try a photo taken directly with your camera.',
  },
  mirror_no_person_detected: {
    title: "We couldn't find a person in this image",
    body: 'Try another photo — a full-length mirror selfie works best.',
  },
  mirror_multiple_people_ambiguous: {
    title: 'We found several people',
    body: 'Choose the person whose clothes you want to add.',
  },
  mirror_no_garments_detected: {
    title: "We couldn't isolate any clothing from this image",
    body: 'Try a clearer, full-body photo with your whole outfit in frame.',
  },
  mirror_extraction_unsupported: {
    title: 'This is not available on your device yet',
    body: 'You can still add items to your Closet one photo at a time.',
  },
  mirror_extraction_cancelled: { title: 'Cancelled', body: '' },
  mirror_extraction_failed: {
    title: "We couldn't finish reading that photo",
    body: 'Try again, or choose a different photo.',
  },
  mirror_session_storage_failed: {
    title: 'There was not enough room to work',
    body: 'Free up some space on your device and try again.',
  },
  mirror_actor_changed: {
    title: 'Your account changed',
    body: 'Start again to add items to the Closet you are signed in to.',
  },
};

const CONFIDENCE_COPY: Record<string, string | null> = {
  // Deliberately no badge on a clean region: an "OK" badge on most crops turns
  // the review flag into noise exactly where it matters least.
  high: null,
  review: 'May contain more than one item',
  low: 'Low detail — check this one',
};

export function MirrorSelfieExtractionModal({
  visible,
  onClose,
  onExtracted,
}: {
  visible: boolean;
  onClose: () => void;
  /**
   * Receives the typed Step 3 → Step 4 handoff. Passed as a VALUE — there is no
   * filesystem discovery, no module singleton and no navigation query string
   * carrying these URIs, because a query string would put the path of a photo
   * of the user's clothes into a navigation log.
   *
   * No Step 3 caller supplies one: the current host just closes the sheet.
   * Wiring it to stageMirrorSelfieGarmentCrops is Step 4's job.
   */
  onExtracted?: (selection: MirrorExtractionSelection) => void;
}) {
  const mirror = useMirrorExtraction();
  const [pickerError, setPickerError] = useState<string | null>(null);
  const operationIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setPickerError(null);
      inFlightRef.current = false;
    }
  }, [visible]);

  const startOperation = useCallback((): number | null => {
    if (inFlightRef.current) return null; // repeated-tap guard
    inFlightRef.current = true;
    operationIdRef.current += 1;
    return operationIdRef.current;
  }, []);

  const isCurrent = useCallback(
    (operationId: number) => mountedRef.current && operationIdRef.current === operationId,
    [],
  );

  const handlePicked = useCallback(
    async (
      operationId: number,
      result: ImagePicker.ImagePickerResult,
      pickedFrom: 'camera' | 'gallery',
    ) => {
      if (!isCurrent(operationId)) return;
      if (result.canceled) return; // silent no-op; the user stays on the chooser
      const asset = (Array.isArray(result.assets) ? result.assets : [])[0];
      const uri = asset?.uri;
      if (typeof uri !== 'string' || !uri.trim()) {
        setPickerError('That image could not be loaded. Please choose another.');
        return;
      }
      setPickerError(null);
      // The picker's dimensions are forwarded because the pipeline cannot reject
      // an unusably small photo without them — see prepareMirrorSource.
      await mirror.begin({
        sourceUri: uri,
        sourceType: pickedFrom,
        sourceWidth: asset?.width ?? null,
        sourceHeight: asset?.height ?? null,
      });
    },
    [isCurrent, mirror],
  );

  const pickFromCamera = useCallback(async () => {
    const operationId = startOperation();
    if (operationId === null) return;
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert(
          'Camera Access Required',
          'Allow K Scan AI to use your camera in Settings to add items to your Closet.',
          [{ text: 'OK' }],
        );
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
      });
      await handlePicked(operationId, result, 'camera');
    } catch {
      if (isCurrent(operationId)) setPickerError('The camera could not be opened. Please try again.');
    } finally {
      inFlightRef.current = false;
    }
  }, [startOperation, handlePicked, isCurrent]);

  const pickFromLibrary = useCallback(async () => {
    const operationId = startOperation();
    if (operationId === null) return;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!hasUsablePhotoLibraryAccess(permission)) {
        Alert.alert(
          'Photo Access Required',
          'Allow K Scan AI to access your photo library in Settings to add items to your Closet.',
          [{ text: 'OK' }],
        );
        return;
      }
      // ONE image per session in Step 3. The session API is shaped for several
      // (every crop carries a sourceImageIndex), but multi-image orchestration
      // is not allowed to hold up the single-selfie vertical slice.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: false,
        selectionLimit: 1,
      });
      await handlePicked(operationId, result, 'gallery');
    } catch {
      if (isCurrent(operationId)) setPickerError('That image could not be loaded. Please choose another.');
    } finally {
      inFlightRef.current = false;
    }
  }, [startOperation, handlePicked, isCurrent]);

  const handleClose = useCallback(async () => {
    await mirror.cancel();
    onClose();
  }, [mirror, onClose]);

  const handleAccept = useCallback(async () => {
    const selection = await mirror.accept();
    if (selection) onExtracted?.(selection);
    onClose();
  }, [mirror, onExtracted, onClose]);

  // The master gate. While MIRROR_SELFIE_V1_ACTIVE is false this component
  // renders nothing at all — no picker, no permission prompt, no session.
  if (!mirror.active) return null;

  const snapshot = mirror.snapshot;
  const status = snapshot?.status ?? 'selecting_source';
  const busy =
    status === 'validating' ||
    status === 'extracting_garments' ||
    status === 'generating_crops' ||
    (status === 'resolving_person' && !snapshot?.personChoices);

  const outcome = snapshot?.errorCode ? OUTCOME_COPY[snapshot.errorCode] : null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <Text style={styles.title} accessibilityRole="header">
            Mirror Selfie
          </Text>

          {/* ── source selection ─────────────────────────────────────────── */}
          {!snapshot || status === 'selecting_source' ? (
            <View>
              <Text style={styles.body}>
                Take or choose one full-length photo of your outfit. We find the clothes in it right
                here on your device — the photo itself is never uploaded.
              </Text>
              {pickerError ? <InlineNotice variant="error" body={pickerError} /> : null}
              <PrimaryButton
                title="Take a photo"
                onPress={pickFromCamera}
                accessibilityLabel="Take a mirror selfie with the camera"
              />
              <View style={styles.gap} />
              <SecondaryButton
                title="Choose a photo"
                onPress={pickFromLibrary}
                accessibilityLabel="Choose a mirror selfie from your photo library"
              />
            </View>
          ) : null}

          {/* ── progress ─────────────────────────────────────────────────── */}
          {busy ? (
            <View style={styles.busy} accessibilityRole="progressbar">
              <ActivityIndicator size="large" color={LUXURY.colors.plum} />
              <Text style={styles.body}>
                {status === 'validating'
                  ? 'Preparing your photo…'
                  : status === 'resolving_person'
                    ? 'Looking for you in the photo…'
                    : status === 'extracting_garments'
                      ? 'Finding what you are wearing…'
                      : 'Cutting out each item…'}
              </Text>
            </View>
          ) : null}

          {/* ── person choice ────────────────────────────────────────────── */}
          {snapshot?.personChoices ? (
            <View>
              <Text style={styles.subtitle}>We found several people</Text>
              <Text style={styles.body}>Choose the person whose clothes you want to add.</Text>
              <View style={styles.choiceRow}>
                {snapshot.personChoices.map((_, index) => (
                  <SecondaryButton
                    key={`person-${index}`}
                    title={`Person ${index + 1}`}
                    onPress={() => void mirror.choosePerson(index)}
                    accessibilityLabel={`Use person ${index + 1} of ${snapshot.personChoices.length}`}
                  />
                ))}
              </View>
              <View style={styles.gap} />
              <SecondaryButton
                title="Use a different photo"
                onPress={() => void mirror.cancel()}
                accessibilityLabel="Cancel and choose a different photo"
              />
            </View>
          ) : null}

          {/* ── bounded outcome ──────────────────────────────────────────── */}
          {status === 'failed' && outcome ? (
            <View>
              <Text style={styles.subtitle}>{outcome.title}</Text>
              {outcome.body ? <Text style={styles.body}>{outcome.body}</Text> : null}
              <View style={styles.gap} />
              <PrimaryButton
                title="Try another photo"
                onPress={() => void mirror.cancel()}
                accessibilityLabel="Try another photo"
              />
            </View>
          ) : null}

          {/* ── PRE-STAGING extraction review ────────────────────────────── */}
          {status === 'reviewing_crops' && snapshot ? (
            <View style={styles.reviewContainer}>
              <Text style={styles.subtitle}>
                {/* The TRUE count, never truncated to the eight-item staging
                    limit — Step 4 owns that limit and the batching for it. */}
                {snapshot.cropCount === 1 ? 'We found 1 item' : `We found ${snapshot.cropCount} items`}
              </Text>
              <Text style={styles.body}>
                Uncheck anything that is not a piece of clothing you want to add.
              </Text>

              <ScrollView style={styles.cropScroll}>
                {snapshot.crops.map((crop, index) => {
                  const badge = CONFIDENCE_COPY[crop.localConfidenceBucket] ?? null;
                  const label = `Detected garment ${index + 1} of ${snapshot.cropCount}`;
                  return (
                    <View key={crop.cropKey} style={styles.cropRow}>
                      <Pressable
                        onPress={() => mirror.setCropSelected(crop.cropKey, !crop.selected)}
                        style={styles.cropTouch}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: crop.selected }}
                        accessibilityLabel={label}
                        accessibilityHint={
                          crop.selected
                            ? 'Double tap to exclude this item'
                            : 'Double tap to include this item'
                        }
                      >
                        <Image
                          source={{ uri: crop.cropUri }}
                          style={[styles.cropImage, !crop.selected && styles.cropImageMuted]}
                          accessible
                          accessibilityLabel={label}
                        />
                        <View style={styles.cropMeta}>
                          <Text style={styles.cropLabel}>{label}</Text>
                          {badge ? <Text style={styles.cropBadge}>{badge}</Text> : null}
                        </View>
                      </Pressable>
                      <SecondaryButton
                        title="Discard"
                        onPress={() => void mirror.discardCrop(crop.cropKey)}
                        accessibilityLabel={`Discard ${label}`}
                      />
                    </View>
                  );
                })}
              </ScrollView>

              <PrimaryButton
                title={snapshot.selectedCount === 0 ? 'Done' : `Continue with ${snapshot.selectedCount}`}
                onPress={handleAccept}
                accessibilityLabel={
                  snapshot.selectedCount === 0
                    ? 'Finish without adding anything'
                    : `Continue with ${snapshot.selectedCount} selected items`
                }
              />
              <View style={styles.gap} />
              <SecondaryButton
                title="Try again"
                onPress={() => void mirror.retry()}
                accessibilityLabel="Run the extraction again on the same photo"
              />
            </View>
          ) : null}

          <View style={styles.gap} />
          <SecondaryButton
            title="Cancel"
            onPress={handleClose}
            accessibilityLabel="Cancel and close Mirror Selfie"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: LUXURY.colors.ivory,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: SPACING.xl,
    maxHeight: '90%',
  },
  title: { color: LUXURY.colors.ink, fontSize: 20, fontWeight: '600', marginBottom: SPACING.sm },
  subtitle: { color: LUXURY.colors.ink, fontSize: 16, fontWeight: '600', marginBottom: SPACING.xs },
  body: { color: LUXURY.colors.graphite, fontSize: 14, marginBottom: SPACING.md },
  gap: { height: SPACING.sm },
  busy: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.sm },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  reviewContainer: { flexShrink: 1 },
  cropScroll: { maxHeight: 340, marginBottom: SPACING.md },
  cropRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  // 44pt is the platform minimum touch target; the row is deliberately taller.
  cropTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexShrink: 1,
    minHeight: 44,
  },
  cropImage: { width: 64, height: 84, borderRadius: 8, backgroundColor: LUXURY.colors.pearl },
  cropImageMuted: { opacity: 0.35 },
  cropMeta: { flexShrink: 1 },
  cropLabel: { color: LUXURY.colors.ink, fontSize: 14 },
  cropBadge: { color: LUXURY.colors.graphite, fontSize: 12, marginTop: 2 },
});
