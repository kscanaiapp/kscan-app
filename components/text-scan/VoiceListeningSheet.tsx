import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Modal, StyleSheet, Text, View } from 'react-native';
import { PrimaryButton, SecondaryButton } from '../luxury';
import { VoiceScanIcon } from '../icons/kscan';
import { LUXURY, MOTION, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import type { VoiceRecognitionState, VoiceUnavailableReason } from '../../services/voice/voiceTypes';

// This component is shared verbatim between the iOS and Android Voice V1
// branches (see services/voice/*'s "author once, cherry-pick" convention).
// The two branches' K+-foundation lines have diverged enough that
// services/responsiveLayout (used by KPlusEarlyAccessSheet on the iOS line)
// does not exist on the Android line yet, so this sheet uses its own
// literal rather than depending on infrastructure that is not guaranteed
// present on both. 560 matches KPlusEarlyAccessSheet's MODAL_MAX_WIDTH on
// iOS today, for visual consistency between the two K+ sheets.
const SHEET_MAX_WIDTH = 560;

export interface VoiceListeningSheetProps {
  visible: boolean;
  state: VoiceRecognitionState;
  unavailableReason: VoiceUnavailableReason | null;
  partialTranscript: string;
  onStop: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}

const UNAVAILABLE_COPY: Record<VoiceUnavailableReason, { title: string; body: string }> = {
  permission_denied: {
    title: 'Microphone access unavailable',
    body: 'Voice Scan needs microphone access. You can still search by typing below.',
  },
  permission_denied_permanently: {
    title: 'Microphone access unavailable',
    body:
      'Microphone access is turned off for K Scan AI. Enable it in your device Settings, or search by typing below.',
  },
  on_device_recognition_unavailable: {
    title: 'Voice Scan isn’t available on this device',
    body: 'On-device speech recognition isn’t supported here. You can still search by typing below.',
  },
  recognizer_error: {
    title: 'Voice Scan had trouble listening',
    body: 'Something interrupted the microphone. Please try again or search by typing below.',
  },
  not_kplus: {
    title: 'Voice Scan is a K+ feature',
    body: 'Upgrade to K+ to use Voice Scan.',
  },
  flag_disabled: {
    title: 'Voice Scan is unavailable',
    body: 'Please search by typing below.',
  },
};

function usePulse(active: boolean) {
  const scale = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((value) => {
      if (mounted) setReduceMotion(Boolean(value));
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!active || reduceMotion) {
      scale.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.12, duration: MOTION.pulseDuration, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: MOTION.pulseDuration, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [active, reduceMotion, scale]);

  return scale;
}

/**
 * The Voice Scan session overlay: permission request, active listening
 * (with an unambiguous pulsing indicator and explicit Stop/Cancel), and the
 * error/unavailable resting states. Never rendered for 'idle' or
 * 'reviewing' -- reviewing is consumed immediately by the caller, which
 * copies the transcript into the existing TextScan input field.
 */
export function VoiceListeningSheet({
  visible,
  state,
  unavailableReason,
  partialTranscript,
  onStop,
  onCancel,
  onDismiss,
}: VoiceListeningSheetProps) {
  const pulseScale = usePulse(visible && state === 'listening');

  useEffect(() => {
    if (state === 'listening') {
      AccessibilityInfo.announceForAccessibility?.('Listening. Tap Stop when you are done speaking.');
    }
  }, [state]);

  const renderContent = () => {
    if (state === 'requesting_permission') {
      return (
        <>
          <Text style={styles.eyebrow}>VOICE SCAN</Text>
          <Text style={styles.title}>Requesting microphone access…</Text>
        </>
      );
    }

    if (state === 'listening' || state === 'finalizing') {
      return (
        <>
          <Text style={styles.eyebrow} accessibilityRole="text">
            {state === 'listening' ? 'LISTENING' : 'FINISHING UP'}
          </Text>
          <Animated.View
            style={[styles.micRing, { transform: [{ scale: pulseScale }] }]}
            accessibilityLabel={state === 'listening' ? 'Microphone is listening' : 'Finishing recognition'}
          >
            <VoiceScanIcon size={32} color={LUXURY.colors.plumDeep} />
          </Animated.View>
          <Text style={styles.transcriptPreview} numberOfLines={3}>
            {partialTranscript || 'Say what you are looking for…'}
          </Text>
          <View style={styles.actions}>
            <PrimaryButton
              testID="voice-scan-stop"
              title="Stop"
              onPress={onStop}
              disabled={state !== 'listening'}
              accessibilityLabel="Stop listening"
            />
            <SecondaryButton
              testID="voice-scan-cancel"
              title="Cancel"
              onPress={onCancel}
              accessibilityLabel="Cancel Voice Scan"
            />
          </View>
        </>
      );
    }

    const reason = unavailableReason ?? 'recognizer_error';
    const copy = UNAVAILABLE_COPY[reason];
    return (
      <>
        <Text style={styles.eyebrow}>VOICE SCAN</Text>
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.body}>{copy.body}</Text>
        <View style={styles.actions}>
          <PrimaryButton
            testID="voice-scan-use-text"
            title="Use Text Instead"
            onPress={onDismiss}
            accessibilityLabel="Dismiss Voice Scan and use the text field"
          />
        </View>
      </>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { maxWidth: SHEET_MAX_WIDTH }]}>{renderContent()}</View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 12, 28, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  card: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: LUXURY.colors.warmWhite,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.xl,
    ...SHADOWS.editorialRaised,
  },
  eyebrow: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 2.0,
    color: LUXURY.colors.goldBrushed,
    marginBottom: SPACING.sm,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    fontSize: 18,
    textAlign: 'center',
    color: LUXURY.colors.plumDeep,
    marginBottom: SPACING.sm,
  },
  body: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.lg,
  },
  micRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    marginVertical: SPACING.lg,
  },
  transcriptPreview: {
    ...LUXURY.typography.body,
    minHeight: 44,
    textAlign: 'center',
    color: LUXURY.colors.ink,
    marginBottom: SPACING.lg,
  },
  actions: {
    width: '100%',
    gap: SPACING.md,
  },
});
