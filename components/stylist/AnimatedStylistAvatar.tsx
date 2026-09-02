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

/**
 * Idle presence the engine already calculates and the renderer used to discard.
 * Both channels transform the approved base only — no asset is warped and no
 * facial feature is invented, so this is safe for every portrait including the
 * ones with no eye or brow artwork.
 */
export interface AnimatedStylistAvatarMotion {
  /** Degrees, engine-bounded to ±2. */
  headRotateDeg?: number;
  /** Multiplier, engine-bounded to 1 ± 0.01. */
  breathingScale?: number;
}

export interface AnimatedStylistAvatarProps {
  avatarId?: string;
  size?: number;
  state?: AnimatedStylistAvatarState;
  mouthState?: AvatarMouthState;
  motion?: AnimatedStylistAvatarMotion;
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
  motion,
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
  const isStatic = effectiveState === 'static';

  // The ambient loop runs while SPEAKING too. Suspending it during speech was
  // what made Elise a photograph the moment she started talking: the mouth
  // crop changed and nothing else on the face moved at all.
  const pulse = useLoopAnimation(!isStatic, {
    min: 0.98,
    max: 1,
    // Held constant across idle and speaking so entering or leaving an
    // utterance does not restart the loop and jump the scale.
    duration: isThinking ? 1200 : 2800,
  });

  // A portrait's mouth capability does not depend on whether it is speaking
  // right now, so the framing decision — and therefore the portrait's on-screen
  // geometry — stays identical across the whole speech lifecycle.
  const mouthCapable =
    preset != null &&
    isReadyPortraitPreset(preset) &&
    speechConfig?.speakingMotionMode === 'mouth_states' &&
    speechConfig.mouthRegion != null &&
    speechConfig.mouthStateSources != null &&
    speechConfig.mouthStateSources.closed != null;

  const mouthSource =
    mouthCapable && effectiveState === 'speaking'
      ? resolveMouthStateSource(speechConfig!.mouthStateSources!, mouthState)
      : null;

  // Engine idle presence. Static numbers rather than an Animated.Value, so the
  // natively driven ambient loop above is never mixed with a JS-driven node in
  // one transform. Both are clamped here as well as in the engine: a renderer
  // must not be the thing that trusts an out-of-range host value.
  const headRotateDeg = clamp(motion?.headRotateDeg, 0, -3, 3);
  const breathingScale = clamp(motion?.breathingScale, 1, 0.97, 1.03);
  const engineMotionStyle: ViewStyle | null = isStatic
    ? null
    : { transform: [{ scale: breathingScale }, { rotate: `${headRotateDeg}deg` }] };

  // One tree for every state. The previous implementation returned a different
  // root element for speaking than for idle, so React unmounted and remounted
  // the portrait — and its `<Image>` — at the start and end of every utterance.
  return (
    <Animated.View style={[{ transform: [{ scale: pulse }] }, style]}>
      <View
        style={[
          styles.container,
          engineMotionStyle,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        <StylistAvatar
          avatarId={avatarId}
          size={size}
          accessibilityLabel={accessibilityLabel}
          applyFraming={!mouthCapable}
        />
        {mouthSource != null ? (
          <MouthStateLayer
            source={mouthSource}
            size={size}
            mouthRegion={speechConfig!.mouthRegion!}
          />
        ) : null}
        {isThinking ? <View style={[styles.thinkingRing, { borderRadius: size / 2 }]} /> : null}
      </View>
    </Animated.View>
  );
}

/** A non-finite or absent host value resolves to `neutral`, never to a bound. */
function clamp(value: number | undefined, neutral: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return neutral;
  return Math.min(max, Math.max(min, value));
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
