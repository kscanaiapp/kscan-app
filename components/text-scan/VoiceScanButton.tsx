import React, { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { KPlusGate } from '../kplus/KPlusGate';
import { VoiceListeningSheet } from './VoiceListeningSheet';
import { VoiceScanIcon } from '../icons/kscan';
import { useVoiceScan } from '../../hooks/useVoiceScan';
import { VOICESCAN_ENABLED } from '../../constants/featureFlags';
import { LUXURY, RADIUS } from '../../constants/theme';

export interface VoiceScanButtonProps {
  /**
   * Called with the finalized transcript once the session reaches review.
   * The caller owns what happens next -- populating the existing TextScan
   * query field is the expected (and only intended) use. This is never
   * called with anything but a validated, on-device transcript.
   */
  onTranscript: (transcript: string) => void;
  disabled?: boolean;
}

interface VoiceScanButtonInnerProps {
  isKPlusActive: boolean;
  openUpgrade: () => void;
  onTranscript: (transcript: string) => void;
  disabled?: boolean;
}

function VoiceScanButtonInner({
  isKPlusActive,
  openUpgrade,
  onTranscript,
  disabled,
}: VoiceScanButtonInnerProps) {
  const voice = useVoiceScan({ isKPlusActive, sourceSurface: 'text-scan' });

  // 'reviewing' is transient by design: the transcript is consumed the
  // instant it is reached and handed to the caller's own (existing) query
  // field, where the user can see and edit it before the existing Submit
  // action runs. Nothing here submits anything.
  useEffect(() => {
    if (voice.state === 'reviewing') {
      onTranscript(voice.acceptDraft());
    }
  }, [voice.state, voice.acceptDraft, onTranscript]);

  const handlePress = () => {
    if (disabled) return;
    if (!isKPlusActive) {
      openUpgrade();
      return;
    }
    void voice.startSession();
  };

  const sheetVisible =
    voice.state === 'requesting_permission' ||
    voice.state === 'listening' ||
    voice.state === 'finalizing' ||
    voice.state === 'error' ||
    voice.state === 'unavailable';

  return (
    <>
      <Pressable
        testID="text-scan-voice-button"
        onPress={handlePress}
        disabled={disabled}
        style={[styles.button, !isKPlusActive && styles.buttonLocked]}
        accessibilityRole="button"
        accessibilityLabel={isKPlusActive ? 'Speak your search' : 'Voice Scan, upgrade to K+'}
      >
        <VoiceScanIcon size={20} color={isKPlusActive ? LUXURY.colors.plum : LUXURY.colors.stone} />
      </Pressable>
      <VoiceListeningSheet
        visible={sheetVisible}
        state={voice.state}
        unavailableReason={voice.unavailableReason}
        partialTranscript={voice.partialTranscript}
        onStop={() => void voice.stopSession()}
        onCancel={voice.cancelSession}
        onDismiss={voice.dismiss}
      />
    </>
  );
}

/**
 * The Voice Scan mic affordance for the existing TextScan input.
 *
 * Renders null entirely when VOICESCAN_ENABLED is off -- same build-time
 * gating convention as every other unshipped surface in this app; no
 * microphone permission is ever requested, and no listening session can
 * ever start, while the flag is false.
 *
 * K+ gating reuses the shared KPlusGate / KPlusEarlyAccessSheet exactly as
 * the existing TextScanFeatureRow pill does -- there is no second,
 * Voice-specific paywall.
 */
export function VoiceScanButton({ onTranscript, disabled }: VoiceScanButtonProps) {
  if (!VOICESCAN_ENABLED) return null;

  return (
    <KPlusGate source="voice_scan_mic">
      {({ isActive, openUpgrade }) => (
        <VoiceScanButtonInner
          isKPlusActive={isActive}
          openUpgrade={openUpgrade}
          onTranscript={onTranscript}
          disabled={disabled}
        />
      )}
    </KPlusGate>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  buttonLocked: {
    opacity: 0.6,
  },
});
