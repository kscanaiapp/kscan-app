import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  DEFAULT_STYLIST_IDENTITY,
  STYLIST_AVATAR_PRESETS,
  type StylistAvatarPreset,
} from '../../constants/stylistIdentity';

interface StylistAvatarProps {
  avatarId?: string;
  size?: number;
  accessibilityLabel?: string;
}

function getPreset(id?: string): StylistAvatarPreset {
  return (
    STYLIST_AVATAR_PRESETS.find((p) => p.id === id) ??
    STYLIST_AVATAR_PRESETS.find((p) => p.id === DEFAULT_STYLIST_IDENTITY.avatarId)!
  );
}

export function StylistAvatar({
  avatarId,
  size = 64,
  accessibilityLabel,
}: StylistAvatarProps) {
  const preset = getPreset(avatarId);
  const label = accessibilityLabel ?? preset.accessibilityLabel;
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
