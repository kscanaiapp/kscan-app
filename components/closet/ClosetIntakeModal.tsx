// Native Closet intake — camera / photo library → durable owned-inventory item.
//
// DOMAIN BOUNDARY: this surface creates a Closet item and NOTHING else. It does
// not call scan-identify, does not request purchase options, secondhand, or
// sneaker enrichment, does not create a Recent Scan, and does not render
// ProductShelf. Closet intake is not a Scanner entry point.
//
// Guard contract (mirrors the Scanner and StyleChatPhotoIntake):
//   - single in-flight operation, monotonic operation id
//   - late picker results discarded after supersede/unmount
//   - picker cancellation is a silent no-op, never an error
//   - permission denial is a controlled outcome with guidance, not a crash
//
// Media: expo-image-manipulator re-encodes the picked asset before it is moved
// into Closet-owned storage. That re-encode is what normalizes EXIF orientation
// (the rotation is baked into the pixels) and is why the picker's temporary URI
// is never the persisted path.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { TextField } from '../StyleObjectCards';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { hasUsablePhotoLibraryAccess } from '../../services/photoLibraryAccess';

type IntakeStep = 'choose' | 'details' | 'saving';

type IntakeSaveResult = {
  ok: boolean;
  reason?: string;
  batchOutcome?: {
    selectedCount: number;
    acceptedCount: number;
    rejectedForCapacityCount: number;
    failedSourceIndexes: number[];
  };
};

export function ClosetIntakeModal({
  visible,
  onClose,
  onSave,
  onSaveBatch,
  stagingActive = false,
  batchIntakeActive = false,
}: {
  visible: boolean;
  onClose: () => void;
  /**
   * When candidate staging is on this photo goes to a REVIEW QUEUE, not into the
   * committed Closet. The copy has to say so — a button reading "Save to Closet"
   * that stages something for review is a promise the build does not keep, and
   * Build 1 has no promotion step to make it true later.
   */
  stagingActive?: boolean;
  batchIntakeActive?: boolean;
  onSave: (
    sourceUri: string,
    draft: { title: string | null; category: string | null },
    // Which picker produced the image. Carried through because the candidate
    // contract distinguishes `closet_camera` from `closet_gallery`, and a gallery
    // photo reported as a camera capture would assert provenance we do not have.
    sourceType: 'camera' | 'gallery'
  ) => Promise<IntakeSaveResult>;
  onSaveBatch?: (
    assets: ImagePicker.ImagePickerAsset[],
    draft: { title: string | null; category: string | null },
    sourceType: 'camera' | 'gallery'
  ) => Promise<IntakeSaveResult>;
}) {
  const [step, setStep] = useState<IntakeStep>('choose');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [pickedAssets, setPickedAssets] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [sourceType, setSourceType] = useState<'camera' | 'gallery'>('gallery');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);

  const operationIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Supersede any in-flight picker result so a late resolution cannot
      // write state into an unmounted tree.
      operationIdRef.current += 1;
    };
  }, []);

  const reset = useCallback(() => {
    setStep('choose');
    setImageUri(null);
    setPickedAssets([]);
    setSourceType('gallery');
    setTitle('');
    setCategory('');
    setError(null);
    inFlightRef.current = false;
  }, []);

  useEffect(() => {
    if (visible) reset();
  }, [visible, reset]);

  const startOperation = useCallback((): number | null => {
    if (inFlightRef.current) return null; // repeated-tap guard
    inFlightRef.current = true;
    operationIdRef.current += 1;
    return operationIdRef.current;
  }, []);

  const isCurrent = useCallback(
    (operationId: number) => mountedRef.current && operationIdRef.current === operationId,
    []
  );

  const handlePicked = useCallback(
    (
      operationId: number,
      result: ImagePicker.ImagePickerResult,
      pickedFrom: 'camera' | 'gallery'
    ) => {
      if (!isCurrent(operationId)) return;
      // Cancellation is a no-op: the user stays on the chooser with no error.
      if (result.canceled) return;
      const assets = Array.isArray(result.assets) ? result.assets : [];
      const asset = assets[0] ?? null;
      const uri = asset?.uri;
      if (typeof uri !== 'string' || !uri.trim()) {
        setError('That image could not be loaded. Please choose another.');
        return;
      }
      setImageUri(uri);
      setPickedAssets(assets);
      setSourceType(pickedFrom);
      setError(null);
      setStep('details');
    },
    [isCurrent]
  );

  const pickFromCamera = useCallback(async () => {
    const operationId = startOperation();
    if (operationId === null) return;
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert(
          'Camera Access Required',
          'Allow K Scan to use your camera in Settings to add items to your Closet.',
          [{ text: 'OK' }]
        );
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
      });
      handlePicked(operationId, result, 'camera');
    } catch {
      if (isCurrent(operationId)) {
        setError('The camera could not be opened. Please try again.');
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [startOperation, handlePicked, isCurrent]);

  const pickFromLibrary = useCallback(async () => {
    const operationId = startOperation();
    if (operationId === null) return;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      // iOS "limited" Photos access is a usable grant, not a denial.
      if (!hasUsablePhotoLibraryAccess(permission)) {
        Alert.alert(
          'Photo Access Required',
          'Allow K Scan to access your photo library in Settings to add items to your Closet.',
          [{ text: 'OK' }]
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: batchIntakeActive,
        selectionLimit: batchIntakeActive ? 8 : 1,
        // iOS only guarantees returned selection order when this is enabled.
        orderedSelection: batchIntakeActive,
      });
      handlePicked(operationId, result, 'gallery');
    } catch {
      if (isCurrent(operationId)) {
        setError('That image could not be loaded. Please choose another.');
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [startOperation, handlePicked, isCurrent, batchIntakeActive]);

  const handleSave = useCallback(async () => {
    if (!imageUri) return;
    const operationId = startOperation();
    if (operationId === null) return;
    setStep('saving');
    setError(null);
    try {
      const draft = {
        title: title.trim() || null,
        category: category.trim() || null,
      };
      const result = batchIntakeActive && onSaveBatch
        ? await onSaveBatch(pickedAssets, draft, sourceType)
        : await onSave(imageUri, draft, sourceType);
      if (!isCurrent(operationId)) return;
      if (result.ok) {
        const outcome = result.batchOutcome;
        if (outcome?.rejectedForCapacityCount) {
          Alert.alert(
            'Review area full',
            `Accepted ${outcome.acceptedCount} items. Your review area is full at 40 items. Review or remove existing items before adding the remaining ${outcome.rejectedForCapacityCount}.`,
          );
        } else if (outcome?.failedSourceIndexes.length) {
          Alert.alert(
            'Some items need another try',
            `${outcome.acceptedCount - outcome.failedSourceIndexes.length} items were added for review. Choose the remaining items again.`,
          );
        }
        onClose();
        return;
      }
      setStep('details');
      setError(
        result.reason === 'android_requires_authenticated_actor'
          ? 'Sign in to save items to your Closet.'
          : result.reason === 'stale_actor_context'
            ? 'Your session changed. Please try again.'
            : 'This item could not be saved. Please try again.'
      );
    } catch {
      if (isCurrent(operationId)) {
        setStep('details');
        setError('This item could not be saved. Please try again.');
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [
    imageUri,
    pickedAssets,
    title,
    category,
    sourceType,
    onSave,
    onSaveBatch,
    batchIntakeActive,
    onClose,
    startOperation,
    isCurrent,
  ]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      // Android hardware Back and the iOS sheet dismiss gesture both route here.
      onRequestClose={onClose}
      testID="closet-intake-modal"
    >
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.heading}>Add to Closet</Text>
          <Text style={styles.sub}>
            {stagingActive
              ? "Items you own. We'll identify the photo and hold it for your review — nothing is added to your Closet yet."
              : 'Items you own. No prices, no shopping — just your wardrobe.'}
          </Text>

          {error ? <InlineNotice variant="error" body={error} testID="closet-intake-error" /> : null}

          {step === 'choose' ? (
            <View style={styles.actions}>
              <PrimaryButton
                title="Take Photo"
                onPress={pickFromCamera}
                accessibilityLabel="Take a photo to add to your Closet"
                testID="closet-intake-camera"
              />
              <SecondaryButton
                title={batchIntakeActive ? 'Choose up to 8 from Library' : 'Choose from Library'}
                onPress={pickFromLibrary}
                accessibilityLabel="Choose a photo from your library to add to your Closet"
                testID="closet-intake-library"
              />
              <SecondaryButton title="Cancel" onPress={onClose} testID="closet-intake-cancel" />
            </View>
          ) : null}

          {step === 'details' || step === 'saving' ? (
            <View style={styles.actions}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" />
              ) : null}
              <TextField
                label="Name (optional)"
                value={title}
                onChangeText={setTitle}
                placeholder="Navy wool coat"
                maxLength={200}
              />
              <TextField
                label="Category (optional)"
                value={category}
                onChangeText={setCategory}
                placeholder="Outerwear"
                maxLength={80}
              />
              {step === 'saving' ? (
                <ActivityIndicator size="large" color={LUXURY.colors.plum} />
              ) : (
                <>
                  <PrimaryButton
                    title={stagingActive ? 'Add for review' : 'Save to Closet'}
                    onPress={handleSave}
                    testID="closet-intake-save"
                  />
                  <SecondaryButton title="Cancel" onPress={onClose} testID="closet-intake-cancel" />
                </>
              )}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: LUXURY.colors.ivory },
  content: { padding: SPACING.xl, gap: SPACING.md },
  heading: {
    fontSize: 24,
    color: LUXURY.colors.ink,
    fontWeight: '600',
  },
  sub: {
    fontSize: 14,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.sm,
  },
  actions: { gap: SPACING.md },
  preview: {
    width: '100%',
    height: 260,
    borderRadius: 12,
    backgroundColor: LUXURY.colors.pearl,
  },
});
