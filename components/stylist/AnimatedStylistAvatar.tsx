import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Image,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import {
  getStylistSpeechConfig,
  STYLIST_AVATAR_PRESET_BY_ID,
  type StylistAvatarPreset,
  type StylistAvatarPresetPortraitReady,
} from '../../constants/stylistIdentity';
import { StylistAvatar } from './StylistAvatar';

export type AnimatedStylistAvatarState = 'idle' | 'thinking' | 'speaking' | 'static';

export interface AnimatedStylistAvatarProps {
  avatarId?: string;
  size?: number;
  state?: AnimatedStylistAvatarState;
  reducedMotion?: boolean;
  accessibilityLabel?: string;
  style?: ViewStyle;
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

function MouthOverlay({
  source,
  size,
  mouthRegion,
}: {
  source: number;
  size: number;
  mouthRegion: { x: number; y: number; width: number; height: number };
}) {
  const scaleY = useLoopAnimation(true, { min: 0.94, max: 1.0, duration: 240 });
  const translateY = useLoopAnimation(true, { min: -0.5, max: 0.5, duration: 260 });
  const opacity = useLoopAnimation(true, { min: 0.92, max: 1.0, duration: 220 });

  const left = mouthRegion.x * size;
  const top = mouthRegion.y * size;
  const width = mouthRegion.width * size;
  const height = mouthRegion.height * size;

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left,
        top,
        width,
        height,
        overflow: 'hidden',
        transform: [{ scaleY }, { translateY }],
        opacity,
      }}
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

function isReadyPortraitPreset(
  preset: StylistAvatarPreset,
): preset is StylistAvatarPresetPortraitReady {
  return preset.kind === 'portrait' && preset.availability === 'ready' && 'source' in preset;
}

export function AnimatedStylistAvatar({
  avatarId,
  size = DEFAULT_SIZE,
  state = 'idle',
  reducedMotion = false,
  accessibilityLabel,
  style,
}: AnimatedStylistAvatarProps) {
  const preset = useMemo(
    () => (avatarId ? STYLIST_AVATAR_PRESET_BY_ID.get(avatarId) : undefined),
    [avatarId],
  );
  const speechConfig = useMemo(() => getStylistSpeechConfig(avatarId), [avatarId]);

  const effectiveState = reducedMotion ? 'static' : state;
  const isSpeaking = effectiveState === 'speaking';
  const isThinking = effectiveState === 'thinking';
  const isIdle = effectiveState === 'idle';

  const pulse = useLoopAnimation(
    (isSpeaking || isThinking || isIdle),
    {
      min: isSpeaking ? 0.985 : 0.98,
      max: isSpeaking ? 1.015 : 1.0,
      duration: isSpeaking ? 320 : isThinking ? 1200 : 2800,
    },
  );

  const showMouthOverlay =
    isSpeaking &&
    preset &&
    isReadyPortraitPreset(preset) &&
    speechConfig?.speechEnabled === true &&
    speechConfig.speakingMotionMode === 'mouth_overlay' &&
    speechConfig.mouthRegion != null;

  // For abstract avatars, placeholders, or portraits without approved mouth
  // configuration, delegate to the existing avatar renderer and add only a
  // safe whole-face pulse when motion is allowed.
  const shouldDelegate = !showMouthOverlay;

  if (shouldDelegate) {
    return (
      <Animated.View
        style={[
          { transform: [{ scale: pulse }] },
          style,
        ]}
      >
        <StylistAvatar
          avatarId={avatarId}
          size={size}
          accessibilityLabel={accessibilityLabel}
        />
      </Animated.View>
    );
  }

  const portraitPreset = preset as StylistAvatarPresetPortraitReady;
  const label = accessibilityLabel ?? portraitPreset.accessibilityLabel;
  const mouthRegion = speechConfig!.mouthRegion!;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          transform: [{ scale: pulse }],
        },
        style,
      ]}
    >
      <Image
        source={portraitPreset.source}
        style={{ width: size, height: size }}
        resizeMode="cover"
        accessibilityRole="image"
        accessibilityLabel={label}
      />
      <MouthOverlay
        source={portraitPreset.source}
        size={size}
        mouthRegion={mouthRegion}
      />
      {isThinking ? (
        <View
          style={[
            styles.thinkingRing,
            { borderRadius: size / 2 },
          ]}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  thinkingRing: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: '#C6A15B',
    opacity: 0.5,
  },
});
