import React, { useRef, useEffect } from 'react';
import { View, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { CAPTURE_BUTTON, COLORS, MOTION, SHADOWS } from '../constants/theme';

interface ScanButtonProps {
  onPress:   () => void;
  disabled?: boolean;
  pulse?:    boolean;
  testID?:   string;
}

export function ScanButton({ onPress, disabled, pulse = true, testID = 'scan-button' }: ScanButtonProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse || disabled) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue:  1.06,
          duration: MOTION.pulseDuration,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue:  1,
          duration: MOTION.pulseDuration,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulse, disabled, pulseAnim]);

  return (
    <TouchableOpacity
      testID={testID}
      accessibilityLabel="Capture photo"
      style={styles.wrap}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.9}
    >
      <Animated.View style={[styles.outer, { transform: [{ scale: pulseAnim }] }]}>
        <View style={styles.inner} />
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width:         CAPTURE_BUTTON.touchSize,
    height:        CAPTURE_BUTTON.touchSize,
    borderRadius:  CAPTURE_BUTTON.touchSize / 2,
    alignItems:    'center',
    justifyContent: 'center',
  },
  outer: {
    width:          CAPTURE_BUTTON.outerSize,
    height:         CAPTURE_BUTTON.outerSize,
    borderRadius:   CAPTURE_BUTTON.outerSize / 2,
    borderWidth:    CAPTURE_BUTTON.borderWidth,
    borderColor:    COLORS.gold,
    alignItems:     'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(9, 9, 11, 0.42)',
    ...SHADOWS.darkFloat,
  },
  inner: {
    width:         CAPTURE_BUTTON.innerSize,
    height:        CAPTURE_BUTTON.innerSize,
    borderRadius:  CAPTURE_BUTTON.innerSize / 2,
    backgroundColor: COLORS.gold,
  },
});
