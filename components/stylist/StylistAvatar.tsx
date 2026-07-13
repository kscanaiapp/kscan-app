import React, { useState } from 'react';
import { Image, View, Text, StyleSheet } from 'react-native';
import {
  DEFAULT_STYLIST_IDENTITY,
  isRenderablePortraitPreset,
  STYLIST_AVATAR_PRESET_BY_ID,
  type StylistAvatarPreset,
  type StylistAvatarPresetAbstract,
  type StylistAvatarPresetPortraitReady,
} from '../../constants/stylistIdentity';

interface StylistAvatarProps {
  avatarId?: string;
  size?: number;
  accessibilityLabel?: string;
}

const DEFAULT_ABSTRACT_PRESET = STYLIST_AVATAR_PRESET_BY_ID.get(
  DEFAULT_STYLIST_IDENTITY.avatarId,
) as StylistAvatarPresetAbstract;

function isRenderableAbstractPreset(
  value: StylistAvatarPreset,
): value is StylistAvatarPresetAbstract {
  return (
    value.kind === 'abstract' &&
    value.availability === 'ready' &&
    value.selectable === true &&
    value.persistable === true &&
    typeof value.backgroundColor === 'string' &&
    typeof value.accentColor === 'string' &&
    typeof value.symbol === 'string' &&
    typeof value.symbolColor === 'string'
  );
}

function getPreset(id?: string): StylistAvatarPreset {
  if (!id) return DEFAULT_ABSTRACT_PRESET;
  const preset = STYLIST_AVATAR_PRESET_BY_ID.get(id);
  if (!preset) return DEFAULT_ABSTRACT_PRESET;
  if (isRenderableAbstractPreset(preset)) return preset;
  if (
    preset.kind === 'portrait' &&
    preset.availability === 'placeholder' &&
    preset.selectable === false &&
    preset.persistable === false &&
    !('source' in preset)
  ) {
    return preset;
  }
  return isRenderablePortraitPreset(preset) ? preset : DEFAULT_ABSTRACT_PRESET;
}

function getAbstractFallbackPreset(preset: StylistAvatarPreset): StylistAvatarPresetAbstract {
  if (preset.kind === 'abstract') return preset;
  return DEFAULT_ABSTRACT_PRESET;
}

function AbstractAvatar({
  preset,
  size,
  label,
  reducedOpacity,
}: {
  preset: StylistAvatarPresetAbstract;
  size: number;
  label: string;
  reducedOpacity?: boolean;
}) {
  const fontSize = size * 0.45;

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: preset.backgroundColor,
          borderColor: preset.accentColor,
          opacity: reducedOpacity ? 0.35 : 1,
        },
      ]}
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <View
        style={[
          styles.innerRing,
          {
            borderRadius: size / 2,
            borderColor: preset.accentColor,
          },
        ]}
      />
      <Text style={[styles.symbol, { fontSize, color: preset.symbolColor }]}>
        {preset.symbol}
      </Text>
    </View>
  );
}

function PortraitAvatar({
  preset,
  fallback,
  size,
  label,
}: {
  preset: StylistAvatarPresetPortraitReady;
  fallback: StylistAvatarPresetAbstract;
  size: number;
  label: string;
}) {
  const [loadFailed, setLoadFailed] = useState(false);

  if (loadFailed) {
    return <AbstractAvatar preset={fallback} size={size} label={label} />;
  }

  return (
    <Image
      source={preset.source}
      resizeMode="cover"
      resizeMethod="resize"
      fadeDuration={0}
      onError={() => setLoadFailed(true)}
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: fallback.accentColor,
        },
      ]}
      accessibilityRole="image"
      accessibilityLabel={label}
    />
  );
}

export function StylistAvatar({
  avatarId,
  size = 64,
  accessibilityLabel,
}: StylistAvatarProps) {
  const preset = getPreset(avatarId);
  const fallback = getAbstractFallbackPreset(preset);

  if (preset.kind === 'portrait' && preset.availability === 'placeholder') {
    return (
      <AbstractAvatar
        preset={fallback}
        size={size}
        label={accessibilityLabel ?? preset.accessibilityLabel}
        reducedOpacity
      />
    );
  }

  if (isRenderablePortraitPreset(preset)) {
    return (
      <PortraitAvatar
        key={`${preset.id}:${preset.source}`}
        preset={preset}
        fallback={DEFAULT_ABSTRACT_PRESET}
        size={size}
        label={accessibilityLabel ?? preset.accessibilityLabel}
      />
    );
  }

  return (
    <AbstractAvatar
      preset={fallback}
      size={size}
      label={accessibilityLabel ?? preset.accessibilityLabel}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    overflow: 'hidden',
  },
  innerRing: {
    position: 'absolute',
    top: 4,
    left: 4,
    right: 4,
    bottom: 4,
    borderWidth: 1,
    opacity: 0.6,
  },
  symbol: {
    fontWeight: '500',
    lineHeight: undefined,
  },
});
