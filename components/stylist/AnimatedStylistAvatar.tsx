import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Image,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import {
  getStylistMouthMotionConfig,
  STYLIST_AVATAR_PRESET_BY_ID,
  type StylistAvatarPreset,
  type StylistAvatarPresetPortraitReady,
  type StylistSpeechConfiguration,
} from '../../constants/stylistIdentity';
import type { AvatarMouthState } from '../../services/avatarSpeechMotion';
import { StylistAvatar } from './StylistAvatar';

export type AnimatedStylistAvatarState = 'idle' | 'thinking' | 'speaking' | 'static';

export interface AnimatedStylistAvatarProps {
  avatarId?: string;
  size?: number;
  state?: AnimatedStylistAvatarState;
  mouthState?: AvatarMouthState;
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
    return () => animation.stop();
  }, [active, config.duration, config.max, config.min, value]);

  return value;
}

function resolveMouthStateSource(
  sources: NonNullable<StylistSpeechConfiguration['mouthStateSources']>,
  target: AvatarMouthState,
): number | null {
  if (target === 'closed') return sources.closed ?? null;
  if (target === 'halfOpen') return sources.halfOpen ?? sources.closed ?? null;
  if (target === 'open') return sources.open ?? sources.halfOpen ?? sources.closed ?? null;
  if (target === 'round') {
    return sources.round ?? sources.open ?? sources.halfOpen ?? sources.closed ?? null;
  }
  return null;
}

function isReadyPortraitPreset(
  preset: StylistAvatarPreset,
): preset is StylistAvatarPresetPortraitReady {
  return preset.kind === 'portrait' && preset.availability === 'ready' && 'source' in preset;
}

function MouthStateLayer({
  source,
  size,
  mouthRegion,
}: {
  source: number;
  size: number;
  mouthRegion: { x: number; y: number; width: number; height: number };
}) {
  const left = mouthRegion.x * size;
  const top = mouthRegion.y * size;
  const width = mouthRegion.width * size;
  const height = mouthRegion.height * size;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left, top, width, height, overflow: 'hidden' }}
    >
      <Image
        source={source}
        style={{ position: 'absolute', width: size, height: size, left: -left, top: -top }}
        resizeMode="cover"
        resizeMethod="resize"
      />
    </View>
  );
}

export function AnimatedStylistAvatar({
  avatarId,
  size = DEFAULT_SIZE,
  state = 'idle',
  mouthState = 'closed',
  reducedMotion = false,
  accessibilityLabel,
  style,
}: AnimatedStylistAvatarProps) {
  const preset = useMemo(
    () => (avatarId ? STYLIST_AVATAR_PRESET_BY_ID.get(avatarId) : undefined),
    [avatarId],
  );
  const speechConfig = useMemo(() => getStylistMouthMotionConfig(avatarId), [avatarId]);
  const effectiveState = reducedMotion ? 'static' : state;
  const isThinking = effectiveState === 'thinking';
  const isIdle = effectiveState === 'idle';
  const pulse = useLoopAnimation(isThinking || isIdle, {
    min: 0.98,
    max: 1,
    duration: isThinking ? 1200 : 2800,
  });

  const canRenderMouthStates =
    effectiveState === 'speaking' &&
    preset != null &&
    isReadyPortraitPreset(preset) &&
    speechConfig?.speakingMotionMode === 'mouth_states' &&
    speechConfig.mouthRegion != null &&
    speechConfig.mouthStateSources != null &&
    speechConfig.mouthStateSources.closed != null;

  // Presets without an approved, statically bundled mouth-state set remain
  // visually neutral; a whole-face pulse is never presented as lip animation.
  if (!canRenderMouthStates) {
    return (
      <Animated.View style={[{ transform: [{ scale: pulse }] }, style]}>
        <StylistAvatar
          avatarId={avatarId}
          size={size}
          accessibilityLabel={accessibilityLabel}
        />
      </Animated.View>
    );
  }

  const mouthSources = speechConfig!.mouthStateSources!;
  const mouthSource = resolveMouthStateSource(mouthSources, mouthState);
  if (mouthSource == null) {
    // The asset set is incomplete (missing closed). Fall back to the static portrait.
    return (
      <Animated.View style={[{ transform: [{ scale: pulse }] }, style]}>
        <StylistAvatar
          avatarId={avatarId}
          size={size}
          accessibilityLabel={accessibilityLabel}
        />
      </Animated.View>
    );
  }
  return (
    <View
      style={[
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        style,
      ]}
    >
      <StylistAvatar
        avatarId={avatarId}
        size={size}
        accessibilityLabel={accessibilityLabel ?? preset.accessibilityLabel}
        applyFraming={false}
      />
      <MouthStateLayer
        source={mouthSource}
        size={size}
        mouthRegion={speechConfig!.mouthRegion!}
      />
      {isThinking ? <View style={[styles.thinkingRing, { borderRadius: size / 2 }]} /> : null}
    </View>
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
