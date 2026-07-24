import { useCallback, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { useReducedMotion } from './useReducedMotion';

/**
 * Presentation-only idle motion for an already-rendered static image.
 *
 * This is deliberately NOT avatar-engine behavior: it imports no engine module,
 * reads no persona or speech state, issues no network or audio work, and has no
 * mouth/lip component. It exists so the test build feels alive without implying
 * the avatar engine is complete.
 *
 * The underlying image is always rendered. Motion is a transform layered on top,
 * so if it is disabled, stopped, or never starts, the static image is what
 * remains visible.
 *
 * No entry fade is included. `useReducedMotion` is fail-closed (it reports true
 * until the async native preference resolves), so a mount-time fade would either
 * never fire or blink the image out after it was already painted. The idle
 * breathing loop has no such first-frame hazard.
 */

/** Half-cycle; a full breath is twice this, landing in the 3-5s target. */
const BREATH_HALF_CYCLE_MS = 2000;
const BREATH_SCALE_TO = 1.015;
const BREATH_TRANSLATE_Y_TO = -2;

export interface PresentationMotionStyle {
  transform: [
    { translateY: Animated.AnimatedInterpolation<number> },
    { scale: Animated.AnimatedInterpolation<number> },
  ];
}

export function usePresentationMotion(): PresentationMotionStyle {
  const reducedMotion = useReducedMotion();
  // 0 = the exact static resting frame, 1 = peak of the breath.
  const breath = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      if (reducedMotion) {
        breath.setValue(0);
        return undefined;
      }

      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(breath, {
            toValue: 1,
            duration: BREATH_HALF_CYCLE_MS,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(breath, {
            toValue: 0,
            duration: BREATH_HALF_CYCLE_MS,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();

      // Runs on blur AND on unmount, so exactly one loop can be live per mounted
      // surface and nothing survives navigation. Resetting to 0 guarantees the
      // image is left on its untransformed static frame.
      return () => {
        loop.stop();
        breath.setValue(0);
      };
    }, [reducedMotion, breath]),
  );

  return {
    transform: [
      {
        translateY: breath.interpolate({
          inputRange: [0, 1],
          outputRange: [0, BREATH_TRANSLATE_Y_TO],
        }),
      },
      {
        scale: breath.interpolate({
          inputRange: [0, 1],
          outputRange: [1, BREATH_SCALE_TO],
        }),
      },
    ],
  };
}
