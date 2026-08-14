import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, type ViewStyle } from 'react-native';
import { MOTION_LIMITS } from '../services/avatarMotionState';
import { useAvatarAppForeground } from './useAvatarAppForeground';

// Native-driver idle/speaking micro-motion for the rigid avatar composite.
//
// Continuous values (breathing, head roll) live entirely in Animated values
// driven natively: no React state update ever happens per animation frame.
// The transforms returned here must be applied to the single outermost
// composite wrapper so the base portrait and mouth overlay move as one unit.

/**
 * Idle-motion tuning policy. Deliberately fixed (no randomness in the
 * renderer): occasional alternating tilts read as calm attentiveness while
 * staying reproducible frame-for-frame in QA recordings.
 */
export const IDLE_MOTION_POLICY = {
  /** Full inhale/exhale cycle. Slow and subtle. */
  breathingCycleMs: 5_200,
  /** Peak breathing scale (≈0.6%), inside the clamped 1% ceiling. */
  breathingPeakScale: 1.006,
  /** Quiet delay before each occasional head tilt. */
  tiltDelayMs: 9_000,
  /** Restrained tilt target, well inside the ±2° clamp. */
  tiltDeg: 0.8,
  tiltAttackMs: 1_400,
  tiltHoldMs: 2_200,
  tiltReleaseMs: 1_600,
} as const;

export interface AvatarCompositeMotionTransforms {
  transforms: NonNullable<ViewStyle['transform']>;
}

/**
 * Start (or stop) the restrained breathing and occasional-tilt loops.
 *
 * - `enabled` false (flag off, Reduce Motion, static state, unsupported
 *   avatar) guarantees no loop is started and values rest at neutral.
 * - Loops stop and values reset to neutral on disable, avatar change, and
 *   unmount — no timer or animation survives teardown.
 */
export function useAvatarCompositeMotion(
  enabled: boolean,
  avatarId: string | undefined,
): AvatarCompositeMotionTransforms {
  const breathing = useRef(new Animated.Value(1)).current;
  const rollDeg = useRef(new Animated.Value(0)).current;
  // Backgrounding is a hard stop for continuous motion: invisible animation
  // would burn battery and leave the avatar mid-pose on return.
  const foreground = useAvatarAppForeground();
  const active = enabled && foreground;

  useEffect(() => {
    if (!active) {
      breathing.setValue(1);
      rollDeg.setValue(0);
      return;
    }

    const breathingLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathing, {
          toValue: IDLE_MOTION_POLICY.breathingPeakScale,
          duration: IDLE_MOTION_POLICY.breathingCycleMs / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breathing, {
          toValue: 1,
          duration: IDLE_MOTION_POLICY.breathingCycleMs / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    // Alternating direction is expressed in the sequence itself, keeping the
    // renderer deterministic with no random source.
    const tiltLoop = Animated.loop(
      Animated.sequence([
        Animated.delay(IDLE_MOTION_POLICY.tiltDelayMs),
        Animated.timing(rollDeg, {
          toValue: IDLE_MOTION_POLICY.tiltDeg,
          duration: IDLE_MOTION_POLICY.tiltAttackMs,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(IDLE_MOTION_POLICY.tiltHoldMs),
        Animated.timing(rollDeg, {
          toValue: 0,
          duration: IDLE_MOTION_POLICY.tiltReleaseMs,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(IDLE_MOTION_POLICY.tiltDelayMs),
        Animated.timing(rollDeg, {
          toValue: -IDLE_MOTION_POLICY.tiltDeg,
          duration: IDLE_MOTION_POLICY.tiltAttackMs,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(IDLE_MOTION_POLICY.tiltHoldMs),
        Animated.timing(rollDeg, {
          toValue: 0,
          duration: IDLE_MOTION_POLICY.tiltReleaseMs,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    breathingLoop.start();
    tiltLoop.start();

    return () => {
      breathingLoop.stop();
      tiltLoop.stop();
      breathing.setValue(1);
      rollDeg.setValue(0);
    };
  }, [active, avatarId, breathing, rollDeg]);

  const transforms = useMemo(
    () =>
      [
        { scale: breathing },
        {
          rotate: rollDeg.interpolate({
            inputRange: [-MOTION_LIMITS.headRollDeg, MOTION_LIMITS.headRollDeg],
            outputRange: [`-${MOTION_LIMITS.headRollDeg}deg`, `${MOTION_LIMITS.headRollDeg}deg`],
            extrapolate: 'clamp',
          }),
        },
      ] as unknown as NonNullable<ViewStyle['transform']>,
    [breathing, rollDeg],
  );

  return { transforms };
}
