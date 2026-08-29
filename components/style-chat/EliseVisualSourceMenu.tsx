import { useCallback, useEffect, useRef } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';

interface EliseVisualSourceMenuProps {
  visible: boolean;
  onClose: () => void;
  onScan: () => void;
  onUpload: () => void;
  cameraDisabled?: boolean;
  uploadDisabled?: boolean;
}

export function EliseVisualSourceMenu({
  visible,
  onClose,
  onScan,
  onUpload,
  cameraDisabled = false,
  uploadDisabled = false,
}: EliseVisualSourceMenuProps) {
  const insets = useSafeAreaInsets();
  const choiceInFlightRef = useRef(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (visible) {
      choiceInFlightRef.current = false;
      pendingActionRef.current = null;
    }
  }, [visible]);

  const runPendingAction = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    action?.();
  }, []);

  const choose = useCallback((action: () => void, disabled: boolean) => {
    if (disabled || choiceInFlightRef.current) return;
    choiceInFlightRef.current = true;
    pendingActionRef.current = action;
    onClose();
    // React Native's Modal onDismiss callback is iOS-only. On Android, the
    // next task runs after the visible=false render has removed the host view.
    if (Platform.OS !== 'ios') setTimeout(runPendingAction, 0);
  }, [onClose, runPendingAction]);

  const cancel = useCallback(() => {
    if (choiceInFlightRef.current) return;
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={cancel}
      onDismiss={runPendingAction}
      accessibilityViewIsModal
      testID="elise-visual-source-menu"
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={cancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel visual source selection"
        />
        <View
          style={[styles.sheet, { paddingBottom: Math.max(SPACING.xl, insets.bottom + SPACING.md) }]}
          accessibilityRole="menu"
        >
          <View style={styles.handle} />
          <Text style={styles.title} accessibilityRole="header">
            Show Elise what you're styling
          </Text>

          <Pressable
            testID="elise-scan-camera-option"
            onPress={() => choose(onScan, cameraDisabled)}
            disabled={cameraDisabled}
            style={({ pressed }) => [
              styles.option,
              pressed && !cameraDisabled ? styles.optionPressed : null,
              cameraDisabled ? styles.optionDisabled : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Scan with camera"
            accessibilityHint="Open the canonical K Scan AI camera"
            accessibilityState={{ disabled: cameraDisabled }}
          >
            <Text style={styles.optionTitle}>Scan with camera</Text>
            <Text style={styles.optionHint}>Use the K Scan AI camera</Text>
          </Pressable>

          <Pressable
            testID="elise-upload-photos-option"
            onPress={() => choose(onUpload, uploadDisabled)}
            disabled={uploadDisabled}
            style={({ pressed }) => [
              styles.option,
              pressed && !uploadDisabled ? styles.optionPressed : null,
              uploadDisabled ? styles.optionDisabled : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Upload from photos"
            accessibilityHint="Open your system photo library"
            accessibilityState={{ disabled: uploadDisabled }}
          >
            <Text style={styles.optionTitle}>Upload from photos</Text>
            <Text style={styles.optionHint}>Choose screenshots or saved images</Text>
          </Pressable>

          <Pressable
            testID="elise-visual-source-cancel"
            onPress={cancel}
            style={({ pressed }) => [styles.cancel, pressed ? styles.cancelPressed : null]}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(9, 7, 13, 0.46)',
  },
  sheet: {
    // Inert on phones; caps the sheet on regular-width iPad windows.
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
    paddingTop: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    gap: SPACING.sm,
    ...SHADOWS.editorialRaised,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.hairline,
    marginBottom: SPACING.xs,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    fontSize: 16,
    marginBottom: SPACING.xs,
  },
  option: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
  },
  optionPressed: {
    opacity: 0.72,
  },
  optionDisabled: {
    opacity: 0.45,
  },
  optionTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
    fontSize: 14,
  },
  optionHint: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 11,
    marginTop: SPACING.xxs,
  },
  cancel: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.xs,
  },
  cancelPressed: {
    opacity: 0.6,
  },
  cancelText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    fontSize: 12,
    letterSpacing: 1.2,
  },
});
