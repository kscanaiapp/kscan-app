import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Image,
  ImageSourcePropType,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { LUXURY } from '../../constants/theme';
import { getAvatarEntry } from '../../services/avatars/registry';
import type { AvatarSpeakingMotionMode } from '../../services/avatars/types';

export type AnimatedAvatarState = 'idle' | 'thinking' | 'speaking';

export interface AnimatedAvatarProps {
  avatarId?: string;
  size?: number;
  state?: AnimatedAvatarState;
  reducedMotion?: boolean;
  style?: ViewStyle;
  testID?: string;
}

const DEFAULT_SIZE = 64;

function useLoopAnimation(
  active: boolean,
  config: { min: number; max: number; duration: number },
) {
  const value = useRef(new Animated.Value(config.min)).current;

  useEffect(() => {
    if (!active) {
      value.setValue(config.min);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: config.max,
          duration: config.duration / 2,
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: config.min,
          duration: config.duration / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [active, config.duration, config.max, config.min, value]);

  return value;
}

function FallbackAvatar({
  name,
  size,
  style,
}: {
  name: string;
  size: number;
  style?: ViewStyle;
}) {
  const initial = name.charAt(0).toUpperCase() || '✦';
  return (
    <View
      style={[
        styles.fallback,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
        style,
      ]}
    >
      <Text style={[styles.fallbackText, { fontSize: size * 0.38 }]}>{initial}</Text>
    </View>
  );
}

function MouthOverlay({
  source,
  size,
  mouthRegion,
  speaking,
  reducedMotion,
}: {
  source: ImageSourcePropType;
  size: number;
  mouthRegion: { x: number; y: number; width: number; height: number };
  speaking: boolean;
  reducedMotion: boolean;
}) {
  const scaleY = useLoopAnimation(speaking && !reducedMotion, {
    min: 0.94,
    max: 1.0,
    duration: 240,
  });
  const translateY = useLoopAnimation(speaking && !reducedMotion, {
    min: -0.5,
    max: 0.5,
    duration: 260,
  });
  const opacity = useLoopAnimation(speaking && !reducedMotion, {
    min: 0.92,
    max: 1.0,
    duration: 220,
  });

  const left = mouthRegion.x * size;
  const top = mouthRegion.y * size;
  const clipWidth = mouthRegion.width * size;
  const clipHeight = mouthRegion.height * size;

  return (
    <Animated.View
      style={{
        position: 'absolute',
        left,
        top,
        width: clipWidth,
        height: clipHeight,
        overflow: 'hidden',
        transform: [{ scaleY }, { translateY }],
        opacity,
      }}
      pointerEvents="none"
    >
      <Image
        source={source}
        style={{
          position: 'absolute',
          width: size,
          height: size,
          left: -left,
          top: -top,
        }}
        resizeMode="cover"
      />
    </Animated.View>
  );
}

export function AnimatedAvatar({
  avatarId,
  size = DEFAULT_SIZE,
  state = 'idle',
  reducedMotion = false,
  style,
  testID,
}: AnimatedAvatarProps) {
  const entry = useMemo(
    () => getAvatarEntry(avatarId) ?? getAvatarEntry('elise-placeholder'),
    [avatarId],
  );
  const source = entry?.assetSource;
  const name = entry?.name ?? 'Elise';
  const motionMode: AvatarSpeakingMotionMode = entry?.speech.speakingMotionMode ?? 'none';
  const mouthRegion = entry?.speech.mouthRegion;

  const isSpeaking = state === 'speaking';
  const isThinking = state === 'thinking';
  const isIdle = state === 'idle';

  const pulse = useLoopAnimation(
    (isSpeaking || isThinking || isIdle) && !reducedMotion,
    {
      min: isSpeaking ? 0.985 : 0.98,
      max: isSpeaking ? 1.015 : 1.0,
      duration: isSpeaking ? 320 : isThinking ? 1200 : 2800,
    },
  );

  const containerStyle = useMemo(
    () => ({
      width: size,
      height: size,
      borderRadius: size / 2,
      overflow: 'hidden' as const,
    }),
    [size],
  );

  if (!entry || !entry.enabled || !source) {
    return <FallbackAvatar name={name} size={size} style={style} />;
  }

  const showMouthOverlay =
    isSpeaking && motionMode === 'mouth_overlay' && mouthRegion != null;
  const animateContainer =
    (motionMode === 'whole_face' && isSpeaking) || isThinking || isIdle;

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.container,
        containerStyle,
        { transform: [{ scale: animateContainer && !reducedMotion ? pulse : 1 }] },
        style,
      ]}
    >
      <Image
        source={source}
        style={containerStyle}
        resizeMode="cover"
        accessibilityLabel={`${name} avatar`}
      />
      {showMouthOverlay && (
        <MouthOverlay
          source={source}
          size={size}
          mouthRegion={mouthRegion}
          speaking={isSpeaking}
          reducedMotion={reducedMotion}
        />
      )}
      {isThinking && (
        <View style={[styles.thinkingRing, { borderRadius: size / 2 }]} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: LUXURY.colors.pearl,
  },
  fallback: {
    backgroundColor: LUXURY.colors.plumMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  thinkingRing: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: LUXURY.colors.goldBrushed,
    opacity: 0.5,
  },
});
