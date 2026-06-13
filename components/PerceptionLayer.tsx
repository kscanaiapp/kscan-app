import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { COLORS } from '../constants/theme';

const SNAP     = 90;
const STAGGER  = 80;
const HOLD     = 300;
const FADE_OUT = 180;

// Chrome label / electric value for the scan recognition overlay.
const LABEL_COLOR = COLORS.chromeMuted;
const VALUE_COLOR = COLORS.activeVision;

interface Metadata {
  category?:  string;
  color?:     string;
  silhouette?: string;
}

interface PerceptionLayerProps {
  metadata?:  Metadata;
  onComplete: () => void;
}

function displayValue(value: string | undefined, fallback: string) {
  return value?.trim() ? value.trim().toUpperCase() : fallback;
}

export function PerceptionLayer({ metadata, onComplete }: PerceptionLayerProps) {
  const overlayOpacity = useRef(new Animated.Value(1)).current;
  const line1Opacity   = useRef(new Animated.Value(0)).current;
  const line2Opacity   = useRef(new Animated.Value(0)).current;
  const line3Opacity   = useRef(new Animated.Value(0)).current;
  const lineAnims      = [line1Opacity, line2Opacity, line3Opacity];

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.stagger(STAGGER, [
        Animated.timing(line1Opacity, { toValue: 1, duration: SNAP, useNativeDriver: true }),
        Animated.timing(line2Opacity, { toValue: 1, duration: SNAP, useNativeDriver: true }),
        Animated.timing(line3Opacity, { toValue: 1, duration: SNAP, useNativeDriver: true }),
      ]),
      Animated.delay(HOLD),
      Animated.timing(overlayOpacity, { toValue: 0, duration: FADE_OUT, useNativeDriver: true }),
    ]);

    animation.start(({ finished }) => {
      if (finished) onComplete();
    });

    return () => animation.stop();
  }, [line1Opacity, line2Opacity, line3Opacity, onComplete, overlayOpacity]);

  const lines = [
    { label: 'SILHOUETTE',   value: displayValue(metadata?.silhouette, 'SCANNING') },
    { label: 'STYLE SIGNAL', value: displayValue(metadata?.category,   'PARSING')  },
    { label: 'PALETTE',      value: displayValue(metadata?.color,      'READING')  },
  ];

  return (
    <Animated.View
      style={[styles.overlay, { opacity: overlayOpacity }]}
      pointerEvents="none"
    >
      <View style={styles.block}>
        {lines.map(({ label, value }, i) => (
          <Animated.View key={label} style={[styles.row, { opacity: lineAnims[i] }]}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.sep}>{'  ·  '}</Text>
            <Text style={styles.value}>{value}</Text>
          </Animated.View>
        ))}
      </View>
    </Animated.View>
  );
}

const MONO = Platform.select({ ios: 'Courier New', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex:          50,
    elevation:       50,
    backgroundColor: COLORS.darkOverlay,
    justifyContent:  'center',
    alignItems:      'center',
  },
  block: {
    gap:              18,
    paddingHorizontal: 36,
    alignItems:       'flex-start',
  },
  row: {
    flexDirection: 'row',
    alignItems:    'baseline',
  },
  label: {
    fontFamily:    MONO,
    fontSize:      10,
    letterSpacing: 2.8,
    color:         LABEL_COLOR,
  },
  sep: {
    fontFamily: MONO,
    fontSize:   10,
    color:      LABEL_COLOR,
    opacity:    0.4,
  },
  value: {
    fontFamily:    MONO,
    fontSize:      13,
    letterSpacing: 2.2,
    color:         VALUE_COLOR,
  },
});
