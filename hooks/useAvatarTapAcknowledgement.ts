import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';
import { AVATAR_MOTION_V1_ENABLED } from '../constants/featureFlags';
import {
  acknowledgeAvatarTap,
} from '../services/avatarAcknowledgement';
import {
  getSharedAvatarMotionController,
  MOTION_TRANSITION_POLICY,
} from '../services/avatarMotionController';

// UI driver for tap acknowledgement.
//
// The service arbitrates and emits; this hook supplies timestamps, reverts
// the brief warm expression after the reaction window, and provides the
// Reduce Motion fallback (an accessibility announcement instead of motion).
// Tap handling is fire-and-forget: it never blocks text input or navigation,
// and with the motion flag off the handler is a complete no-op.

export interface UseAvatarTapAcknowledgementInput {
  displayName: string;
  reducedMotion: boolean;
}

export function useAvatarTapAcknowledgement({
  displayName,
  reducedMotion,
}: UseAvatarTapAcknowledgementInput): { onAvatarPress: () => void; enabled: boolean } {
  const enabled = AVATAR_MOTION_V1_ENABLED;
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revertTimerRef.current !== null) {
        clearTimeout(revertTimerRef.current);
        revertTimerRef.current = null;
      }
    };
  }, []);

  const onAvatarPress = useCallback(() => {
    if (!enabled) return;
    const outcome = acknowledgeAvatarTap({ nowMs: Date.now(), reducedMotion });
    if (outcome !== 'acknowledged') return;

    if (reducedMotion) {
      // Safe no-motion feedback: a single polite announcement.
      AccessibilityInfo.announceForAccessibility(`${displayName} acknowledged you`);
      return;
    }
    // The reaction self-expires in the controller; the warm expression bias
    // reverts here so a tap never leaves a lingering expression.
    if (revertTimerRef.current !== null) clearTimeout(revertTimerRef.current);
    revertTimerRef.current = setTimeout(() => {
      revertTimerRef.current = null;
      getSharedAvatarMotionController().setExpression('neutral');
    }, MOTION_TRANSITION_POLICY.reactionDurationMs);
  }, [enabled, displayName, reducedMotion]);

  return { onAvatarPress, enabled };
}
