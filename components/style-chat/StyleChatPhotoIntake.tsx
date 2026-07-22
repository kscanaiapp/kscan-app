// StyleChat photo intake (Phase 2) — guarded scanner-pipeline reuse.
//
// Flow (Part 12): picker → privacy/sanitization → scan-identify → review →
// explicit SAVE TO CLOSET & ATTACH → saved_scan row (existing library save +
// cloud-sync path) → private media backing (idempotent saga) → stable
// owned-item contract handed back to the composer. Nothing auto-saves,
// nothing auto-sends, no base64 or local URI ever enters a chat payload.
//
// Guard invariants (Part 11): this modal consumes the same underlying
// services as the scanner (permission guidance, sanitizeImageBeforeUpload,
// identifyScanImage with abort + timeout, library saveScan) and implements
// the scanner's guard contract — single in-flight analysis, monotonic
// operation id, abort on supersede/unmount, late results discarded, picker
// cancellation is a no-op. The scanner's own hook and flow are untouched.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';

import { TextField } from '../StyleObjectCards';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import {
  getPrivacySanitizerStatus,
  sanitizeImageBeforeUpload,
} from '../../services/privacyImageSanitizer';
import { SCANNER_IMAGE_MAX_WIDTH, SCANNER_IMAGE_JPEG_QUALITY } from '../../services/imageUtils';
import { identifyScanImage } from '../../services/scanIdentification';
import { saveScan } from '../../services/library';
import { saveScanToCloud } from '../../services/savedScansCloud';
import { supabase } from '../../services/supabaseClient';
import { ensureSavedScanMediaBacking } from '../../services/savedScanMedia';
import { recordAiStylistEvent } from '../../services/styleMemoryEvents';
import {
  STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
  type StyleChatAttachment,
  type StyleChatAttachmentSummary,
} from '../../types/styleChatAttachments';

type IntakeStep =
  | 'idle'
  | 'sanitizing'
  | 'identifying'
  | 'review'
  | 'manual_details'
  | 'saving'
  | 'sanitizer_rejected'
  | 'identify_failed';

export function StyleChatPhotoIntake({
  visible,
  onClose,
  onAttached,
}: {
  visible: boolean;
  onClose: () => void;
  onAttached: (resolved: StyleChatAttachment, summary: StyleChatAttachmentSummary) => void;
}) {
  const [step, setStep] = useState<IntakeStep>('idle');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [resultText, setResultText] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Guard contract: monotonic op id + abort; late results are discarded.
  const operationIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const savingRef = useRef(false);

  const resetState = useCallback(() => {
    setStep('idle');
    setImageUri(null);
    setTitle('');
    setCategory('');
    setColor('');
    setResultText('');
    setSaveError(null);
  }, []);

  useEffect(() => {
    return () => {
      operationIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  const startPicker = useCallback(async () => {
    if (inFlightRef.current) return; // single in-flight analysis
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Photo Access Required',
        'Allow K Scan to access your photo library in Settings to upload a photo.',
        [{ text: 'OK' }],
      );
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      allowsEditing: false,
      allowsMultipleSelection: false,
    });
    // Picker cancellation: no row, no upload, no state change.
    if (picked.canceled || !picked.assets?.[0]?.uri) return;

    const operationId = ++operationIdRef.current;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    inFlightRef.current = true;
    const localUri = picked.assets[0].uri;
    setImageUri(localUri);
    setSaveError(null);

    try {
      // Privacy boundary FIRST — a rejected image is never saved or uploaded.
      setStep('sanitizing');
      let sanitizedUri: string;
      try {
        sanitizedUri = await sanitizeImageBeforeUpload(localUri);
      } catch {
        if (operationId !== operationIdRef.current) return; // late result discard
        setStep('sanitizer_rejected');
        return;
      }
      if (operationId !== operationIdRef.current) return;
      setImageUri(sanitizedUri);

      // Identify through the existing guarded service (its own timeout+abort).
      // Reuse Scanner-compatible compress settings (896 / 0.65).
      setStep('identifying');
      const prepared = await ImageManipulator.manipulateAsync(
        sanitizedUri,
        [{ resize: { width: SCANNER_IMAGE_MAX_WIDTH } }],
        {
          compress: SCANNER_IMAGE_JPEG_QUALITY,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );
      if (operationId !== operationIdRef.current) return;
      const sanitizerStatus = getPrivacySanitizerStatus();
      const identification = prepared.base64
        ? await identifyScanImage(prepared.base64, {
            source: 'upload',
            privacyProof: {
              sanitizerVersion: sanitizerStatus.sanitizerVersion,
              faceDetectionPerformed: sanitizerStatus.faceDetectionAvailable,
              faceMaskApplied: sanitizerStatus.faceBlurApplied,
              plateDetectionPerformed: sanitizerStatus.plateDetectionAvailable,
              plateMaskApplied: sanitizerStatus.plateMaskApplied,
              metadataStripped: sanitizerStatus.metadataStripped,
            },
            signal: abortRef.current?.signal,
          })
        : null;
      if (operationId !== operationIdRef.current) return; // late result discard

      const meta = (identification as any)?.metadata ?? {};
      const identifiedCategory =
        typeof meta.category === 'string' && meta.category.trim() ? meta.category.trim() : '';
      // Only a completed identification with a category proceeds to review;
      // failed / non_fashion / missing-category all offer the manual path.
      if (!identification || (identification as any).status !== 'completed' || !identifiedCategory) {
        setStep('identify_failed');
        return;
      }

      setTitle(identifiedCategory);
      setCategory(identifiedCategory);
      setColor(typeof meta.color === 'string' ? meta.color : '');
      setResultText(typeof (identification as any).result === 'string' ? (identification as any).result : '');
      setStep('review');
    } finally {
      if (operationId === operationIdRef.current) inFlightRef.current = false;
      else inFlightRef.current = false;
    }
  }, []);

  // Open picker automatically when the modal becomes visible from idle.
  useEffect(() => {
    if (visible && step === 'idle' && !inFlightRef.current) {
      void startPicker();
    }
  }, [visible, step, startPicker]);

  const handleSaveAndAttach = useCallback(async () => {
    if (savingRef.current) return; // duplicate-tap guard
    const finalTitle = title.trim();
    const finalCategory = category.trim();
    // Explicit save only; never an empty or category-less saved_scan.
    if (!finalTitle || !finalCategory || !imageUri) {
      setSaveError('Add a title and category first.');
      return;
    }
    savingRef.current = true;
    setStep('saving');
    setSaveError(null);

    try {
      // 1. Local Closet save through the existing library path.
      const scan = await saveScan({
        photoUri: imageUri,
        analysis: {
          result: resultText || `${finalTitle} — added from StyleChat`,
          metadata: { category: finalCategory, color: color.trim() || undefined },
        },
        source: 'upload',
      });
      if (!scan) throw new Error('save');

      // 2. Stable remote row via the existing cloud-sync path (idempotent by
      //    user_id + local_id). Never invents a UUID.
      const cloudResult = await saveScanToCloud(scan);
      if (!cloudResult.ok) throw new Error('sync');
      const { data: row } = await supabase
        .from('saved_scans')
        .select('id')
        .eq('local_id', scan.id)
        .is('deleted_at', null)
        .maybeSingle();
      const savedScanId = row?.id as string | undefined;
      if (!savedScanId) throw new Error('sync');

      // 3. Private media backing (idempotent saga; retry-safe).
      const media = await ensureSavedScanMediaBacking({
        savedScanId,
        localImageUri: scan.imageUri ?? imageUri,
      });
      if (!media.ok) throw new Error('media');

      // 4. Hand the stable contract back to the composer draft.
      onAttached(
        {
          attachmentType: 'owned_item',
          sourceType: 'saved_scan',
          sourceId: savedScanId,
          contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
        },
        {
          title: finalTitle,
          subtitle: finalCategory,
          imageUri: scan.thumbnailUri ?? scan.imageUri ?? imageUri,
          itemCount: 1,
        },
      );
      void recordAiStylistEvent({
        eventType: 'stylechat_image_saved_and_attached',
        signalKey: savedScanId,
        payload: { category: finalCategory },
      });
      resetState();
      onClose();
    } catch {
      // Row/media failures stay retryable; the local record and image are
      // preserved and the chip flow never claims readiness.
      setStep((current) => (current === 'saving' ? 'review' : current));
      setSaveError("Couldn't finish saving. Tap Save to retry, or cancel.");
    } finally {
      savingRef.current = false;
    }
  }, [title, category, color, resultText, imageUri, onAttached, onClose, resetState]);

  const handleCancel = () => {
    operationIdRef.current += 1;
    abortRef.current?.abort();
    resetState();
    onClose();
  };

  const busy = step === 'sanitizing' || step === 'identifying' || step === 'saving';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? () => {} : handleCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Upload a Photo</Text>

          {busy ? (
            <View style={styles.busyWrap}>
              <ActivityIndicator size="large" color={LUXURY.colors.plum} />
              <Text style={styles.busyText}>
                {step === 'sanitizing'
                  ? 'Checking image…'
                  : step === 'identifying'
                    ? 'Identifying this item…'
                    : 'Saving to your Closet…'}
              </Text>
            </View>
          ) : null}

          {step === 'sanitizer_rejected' ? (
            <>
              <InlineNotice
                variant="error"
                title="Image"
                body="This image couldn’t be processed. Please try a clearer photo of the item."
              />
              <PrimaryButton title="Try Again" onPress={() => { resetState(); void startPicker(); }} accessibilityLabel="Try again" />
              <SecondaryButton title="Cancel" onPress={handleCancel} />
            </>
          ) : null}

          {step === 'identify_failed' ? (
            <>
              <InlineNotice
                variant="info"
                title="Identification"
                body="I couldn’t identify this item. You can add basic details or try another photo."
              />
              <PrimaryButton
                title="Add Details Manually"
                onPress={() => setStep('manual_details')}
                accessibilityLabel="Add details manually"
              />
              <SecondaryButton title="Try Another Photo" onPress={() => { resetState(); void startPicker(); }} />
              <SecondaryButton title="Cancel" onPress={handleCancel} />
            </>
          ) : null}

          {step === 'review' || step === 'manual_details' ? (
            <ScrollView style={styles.reviewScroll} showsVerticalScrollIndicator={false}>
              {imageUri ? <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" /> : null}
              <TextField label="Title" value={title} onChangeText={setTitle} />
              <TextField label="Category" value={category} onChangeText={setCategory} />
              {step === 'review' ? <TextField label="Color" value={color} onChangeText={setColor} /> : null}
              {saveError ? <InlineNotice variant="error" title="Save" body={saveError} /> : null}
              <PrimaryButton
                title="Save to Closet & Attach"
                onPress={handleSaveAndAttach}
                disabled={!title.trim() || !category.trim()}
                accessibilityLabel="Save to closet and attach"
                testID="save-and-attach-button"
              />
              <SecondaryButton title="Try Another Photo" onPress={() => { resetState(); void startPicker(); }} />
              <SecondaryButton title="Cancel" onPress={handleCancel} />
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: LUXURY.colors.plumDeep + 'C2',
    padding: SPACING.xl,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    maxHeight: '88%',
  },
  title: { ...LUXURY.typography.displayTitle, color: LUXURY.colors.ink },
  busyWrap: { alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.lg },
  busyText: { ...LUXURY.typography.body, color: LUXURY.colors.graphite },
  reviewScroll: { flexGrow: 0 },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: 14,
    backgroundColor: LUXURY.colors.ivory,
    marginBottom: SPACING.md,
  },
});
