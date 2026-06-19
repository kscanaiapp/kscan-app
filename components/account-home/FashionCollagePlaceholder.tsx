import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

interface FashionCollagePlaceholderProps {
  style?: ViewStyle;
}

/**
 * Premium abstract fashion collage placeholder.
 * Uses flat layered shapes in champagne, plum, and pearl tones
 * to suggest editorial fashion imagery without external assets.
 */
export function FashionCollagePlaceholder({ style }: FashionCollagePlaceholderProps) {
  return (
    <View style={[styles.root, style]} testID="fashion-collage-placeholder">
      {/* Background canvas */}
      <View style={styles.canvas} />

      {/* Large left shape — suggests a garment drape */}
      <View style={styles.drapeLeft} />

      {/* Center shape — suggests a handbag or accessory */}
      <View style={styles.centerAccessory} />

      {/* Right shape — suggests a shoe or smaller accessory */}
      <View style={styles.rightAccent} />

      {/* Bottom horizontal band — suggests a belt or scarf */}
      <View style={styles.bottomBand} />

      {/* Sparkle accents */}
      <View style={styles.sparkleTop} />
      <View style={styles.sparkleRight} />
      <View style={styles.sparkleBottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    height: 320,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xl,
  },
  canvas: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    backgroundColor: LUXURY.colors.cream,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  drapeLeft: {
    position: 'absolute',
    left: 24,
    top: 40,
    width: 120,
    height: 180,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(198, 161, 91, 0.20)',
    transform: [{ rotate: '-8deg' }],
    ...{
      shadowColor: LUXURY.colors.plum,
      shadowOpacity: 0.06,
      shadowOffset: { width: 0, height: 6 },
      shadowRadius: 16,
      elevation: 2,
    },
  },
  centerAccessory: {
    position: 'absolute',
    width: 140,
    height: 140,
    backgroundColor: LUXURY.colors.ivory,
    borderRadius: RADIUS.xl,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.goldChampagne,
    zIndex: 1,
    ...{
      shadowColor: LUXURY.colors.plum,
      shadowOpacity: 0.08,
      shadowOffset: { width: 0, height: 8 },
      shadowRadius: 20,
      elevation: 3,
    },
  },
  rightAccent: {
    position: 'absolute',
    right: 32,
    top: 60,
    width: 80,
    height: 100,
    backgroundColor: LUXURY.colors.plumMuted,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(198, 161, 91, 0.16)',
    transform: [{ rotate: '6deg' }],
  },
  bottomBand: {
    position: 'absolute',
    bottom: 36,
    width: 200,
    height: 28,
    backgroundColor: LUXURY.colors.goldLight,
    borderRadius: RADIUS.pill,
    opacity: 0.35,
  },
  sparkleTop: {
    position: 'absolute',
    top: 16,
    right: 60,
    width: 8,
    height: 8,
    backgroundColor: LUXURY.colors.gold,
    borderRadius: 4,
    transform: [{ rotate: '45deg' }],
  },
  sparkleRight: {
    position: 'absolute',
    top: 80,
    right: 20,
    width: 6,
    height: 6,
    backgroundColor: LUXURY.colors.plumSoft,
    borderRadius: 3,
    transform: [{ rotate: '45deg' }],
    opacity: 0.6,
  },
  sparkleBottom: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    width: 10,
    height: 10,
    backgroundColor: LUXURY.colors.goldChampagne,
    borderRadius: 5,
    transform: [{ rotate: '45deg' }],
    opacity: 0.5,
  },
});
