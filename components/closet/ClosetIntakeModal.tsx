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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hasUsablePhotoLibraryAccess } = require('../../services/photoLibraryAccess');

type IntakeStep = 'choose' | 'details' | 'saving';

export function ClosetIntakeModal({
  visible,
  onClose,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (
    sourceUri: string,
    draft: { title: string | null; category: string | null }
  ) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [step, setStep] = useState<IntakeStep>('choose');
  const [imageUri, setImageUri] = useState<string | null>(null);
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
    (operationId: number, result: ImagePicker.ImagePickerResult) => {
      if (!isCurrent(operationId)) return;
      // Cancellation is a no-op: the user stays on the chooser with no error.
      if (result.canceled) return;
      const asset = Array.isArray(result.assets) ? result.assets[0] : null;
      const uri = asset?.uri;
      if (typeof uri !== 'string' || !uri.trim()) {
        setError('That image could not be loaded. Please choose another.');
        return;
      }
      setImageUri(uri);
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
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsEditing: false,
      });
      handlePicked(operationId, result);
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
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: false,
        selectionLimit: 1,
      });
      handlePicked(operationId, result);
    } catch {
      if (isCurrent(operationId)) {
        setError('That image could not be loaded. Please choose another.');
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [startOperation, handlePicked, isCurrent]);

  const handleSave = useCallback(async () => {
    if (!imageUri) return;
    const operationId = startOperation();
    if (operationId === null) return;
    setStep('saving');
    setError(null);
    try {
      const result = await onSave(imageUri, {
        title: title.trim() || null,
        category: category.trim() || null,
      });
      if (!isCurrent(operationId)) return;
      if (result.ok) {
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
  }, [imageUri, title, category, onSave, onClose, startOperation, isCurrent]);

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
            Items you own. No prices, no shopping — just your wardrobe.
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
                title="Choose from Library"
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
                    title="Save to Closet"
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
