import React, { useMemo } from 'react';
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
import type { AvatarExpressionMode, AvatarMotionMode } from '../../services/avatarMotionState';
import { resolveBrowState } from '../../services/avatarExpressionRules';
import { resolveMouthStateSource } from '../../services/avatarMotionRenderer';
import { getAvatarMotionCapabilities } from '../../services/avatarMotionCapabilities';
import {
  getFacialOverlayAsset,
  type FacialOverlayAsset,
} from '../../constants/avatarFacialOverlays';
import { AVATAR_MOTION_V1_ENABLED } from '../../constants/featureFlags';
import { useAvatarCompositeMotion } from '../../hooks/useAvatarCompositeMotion';
import { useAvatarBlink } from '../../hooks/useAvatarBlink';
import { StylistAvatar } from './StylistAvatar';

// Thin renderer consumer.
//
// This component maps already-decided motion state to assets and native
// transforms. It owns no state machine, derives no speech timing, makes no
// provider decisions, and never subscribes to playback ticks; those live in
// the motion controller and the discrete motion store. Every transform is
// applied to the single outermost Animated wrapper that contains BOTH the
// base portrait and the mouth overlay, keyed by avatarId, so the composite
// stays rigid and an avatar switch unmounts the whole subtree cleanly.

export type AnimatedStylistAvatarState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  /**
   * KSB29-M02. The brief tap acknowledgement. It shares idle's calm
   * presentation -- no louder motion -- and is visible through the brow layer:
   * `resolveBrowState` already turns ('warm', 'reacting') into a raise. Without
   * this member the header had no way to report the state at all, so the
   * acknowledgement was computed and then thrown away.
   */
  | 'reacting'
  | 'static';

export interface AnimatedStylistAvatarProps {
  avatarId?: string;
  size?: number;
  state?: AnimatedStylistAvatarState;
  mouthState?: AvatarMouthState;
  /** Semantic expression from the deterministic local rules. */
  expression?: AvatarExpressionMode;
  reducedMotion?: boolean;
  accessibilityLabel?: string;
  style?: ViewStyle;
}

const DEFAULT_SIZE = 64;

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

function FacialOverlayLayer({
  asset,
  size,
}: {
  asset: FacialOverlayAsset;
  size: number;
}) {
  // Localized transparent overlay placed by its measured region on the
  // 1024-normalized portrait. It lives INSIDE the rigid composite wrapper,
  // so every whole-composite transform moves it with the base portrait and
  // the mouth layer; registration cannot drift. The blend margin is baked
  // into the asset itself.
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        left: asset.region.x * size,
        top: asset.region.y * size,
        width: asset.region.width * size,
        height: asset.region.height * size,
      }}
    >
      <Image
        source={asset.source}
        style={{ width: '100%', height: '100%' }}
        resizeMode="contain"
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
  expression = 'neutral',
  reducedMotion = false,
  accessibilityLabel,
  style,
}: AnimatedStylistAvatarProps) {
  const preset = useMemo(
    () => (avatarId ? STYLIST_AVATAR_PRESET_BY_ID.get(avatarId) : undefined),
    [avatarId],
  );
  const speechConfig = useMemo(() => getStylistMouthMotionConfig(avatarId), [avatarId]);
  const capabilities = useMemo(() => getAvatarMotionCapabilities(avatarId), [avatarId]);
  const effectiveState = reducedMotion ? 'static' : state;
  // Thinking is the only state with a distinct static treatment (the ring).
  // Listening shares the calm idle presentation: attentiveness is conveyed
  // by textual status, never by louder motion.
  const isThinking = effectiveState === 'thinking';

  // V1 restrained motion: breathing scale plus occasional head roll on the
  // rigid composite. Fails closed — flag off, Reduce Motion, a static state,
  // or an avatar without motion capability all mean no loop ever starts.
  //
  // Owner decision (KAVA-P2-003): with the flag off the portrait is fully
  // static. There is no legacy pulse fallback, so a disabled motion system
  // leaves exactly zero animation loops running. Speech lip-sync is part of
  // the separately controlled voice feature and is unaffected.
  const motionActive =
    AVATAR_MOTION_V1_ENABLED &&
    !reducedMotion &&
    effectiveState !== 'static' &&
    capabilities.headMotion &&
    capabilities.upperBodyMotion;
  const { transforms: motionTransforms } = useAvatarCompositeMotion(motionActive, avatarId);

  // Blink coexists with any mouth state (including speech) but never runs
  // without the complete validated eye package, the motion flag, and normal
  // motion settings. With assets missing the capability is false, no blink
  // is ever scheduled, and no eye layer mounts.
  const eyeState = useAvatarBlink(motionActive && capabilities.blink, avatarId);
  // Defense in depth: the disabled hook already reports open, but the eye
  // layer additionally requires active motion so Reduce Motion and the
  // static state can never mount a blink frame regardless of driver state.
  const eyeAsset =
    motionActive && capabilities.blink && eyeState !== 'open'
      ? getFacialOverlayAsset(
          avatarId,
          'eyes',
          eyeState === 'halfOpen' ? 'halfClosed' : eyeState,
        )
      : null;

  // Brow presentation from the deterministic local rules. Neutral renders no
  // layer at all, brow changes coexist with mouth animation, and without a
  // validated brow package the state is always neutral.
  const browMode: AvatarMotionMode = effectiveState === 'static' ? 'idle' : effectiveState;
  const browState = motionActive
    ? resolveBrowState(expression, browMode, capabilities, reducedMotion)
    : 'neutral';
  const browAsset =
    browState !== 'neutral' ? getFacialOverlayAsset(avatarId, 'brows', browState) : null;

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
  const mouthSources: StylistSpeechConfiguration['mouthStateSources'] | null =
    canRenderMouthStates ? speechConfig!.mouthStateSources! : null;
  const mouthSource = mouthSources ? resolveMouthStateSource(mouthSources, mouthState) : null;
  const showMouthLayer = canRenderMouthStates && mouthSource != null;

  // The composite transform lives on this single outermost Animated wrapper.
  // Base portrait, mouth overlay, and any future facial layer share it, so
  // the visual composite can never separate during motion. With motion
  // inactive there is no transform at all — the composite renders at its
  // neutral identity pose.
  const compositeTransform = motionActive ? motionTransforms : undefined;

  return (
    <Animated.View
      key={avatarId ?? 'default'}
      style={[
        compositeTransform ? { transform: compositeTransform } : null,
        showMouthLayer
          ? [styles.clippedComposite, { width: size, height: size, borderRadius: size / 2 }]
          : null,
        style,
      ]}
    >
      <StylistAvatar
        avatarId={avatarId}
        size={size}
        accessibilityLabel={
          accessibilityLabel ??
          (preset && isReadyPortraitPreset(preset) ? preset.accessibilityLabel : undefined)
        }
      />
      {showMouthLayer ? (
        <MouthStateLayer
          source={mouthSource!}
          size={size}
          mouthRegion={speechConfig!.mouthRegion!}
        />
      ) : null}
      {eyeAsset ? <FacialOverlayLayer asset={eyeAsset} size={size} /> : null}
      {browAsset ? <FacialOverlayLayer asset={browAsset} size={size} /> : null}
      {showMouthLayer && isThinking ? (
        <View style={[styles.thinkingRing, { borderRadius: size / 2 }]} />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clippedComposite: {
    overflow: 'hidden',
  },
  thinkingRing: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: '#C6A15B',
    opacity: 0.5,
  },
});
