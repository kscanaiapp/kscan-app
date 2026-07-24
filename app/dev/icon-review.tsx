import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  KSCAN_ICON_NAMES,
  KScanIcon,
  type KScanIconName,
  type KScanIconVariant,
} from '../../components/icons/kscan';
import { LUXURY, SPACING } from '../../constants/theme';
import { QA_TOOLS_ENABLED } from '../../constants/build';

const SIZES = [20, 24, 28, 32, 48] as const;
const VARIANTS: KScanIconVariant[] = ['compact', 'standard'];

const SURFACES: Array<{
  key: string;
  label: string;
  backgroundColor: string;
  color?: string;
  accentColor?: string;
}> = [
  {
    key: 'cream',
    label: 'Cream',
    backgroundColor: LUXURY.colors.cream,
  },
  {
    key: 'white',
    label: 'White',
    backgroundColor: LUXURY.colors.warmWhite,
  },
  {
    key: 'plum-inverted',
    label: 'Plum inverted',
    backgroundColor: LUXURY.colors.plum,
    color: LUXURY.colors.inverse,
    accentColor: LUXURY.colors.goldChampagne,
  },
];

/**
 * Development-only product icon review surface.
 * Not a user-facing production feature; blocked unless QA tools are enabled.
 */
export default function IconReviewScreen() {
  if (!QA_TOOLS_ENABLED) {
    return (
      <SafeAreaView style={styles.blocked}>
        <Text style={styles.blockedText}>Icon review is available in development builds only.</Text>
      </SafeAreaView>
    );
  }

  return <IconReviewContent />;
}

function IconReviewContent() {
  const [pressedKey, setPressedKey] = useState<string | null>(null);

  return (
    <SafeAreaView style={styles.root} testID="kscan-icon-review-screen">
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          K Scan Product Icons
        </Text>
        <Text style={styles.subtitle}>
          Compact + standard · 20–48 px · cream / white / plum · {Platform.OS}
        </Text>

        {KSCAN_ICON_NAMES.map((name) => (
          <View key={name} style={styles.iconBlock} testID={`icon-review-${name}`}>
            <Text style={styles.iconName}>{name}</Text>
            {VARIANTS.map((variant) => (
              <View key={`${name}-${variant}`} style={styles.variantBlock}>
                <Text style={styles.variantLabel}>{variant}</Text>
                {SURFACES.map((surface) => (
                  <View key={`${name}-${variant}-${surface.key}`} style={styles.surfaceBlock}>
                    <Text style={styles.surfaceLabel}>{surface.label}</Text>
                    <View style={[styles.sizeRow, { backgroundColor: surface.backgroundColor }]}>
                      {SIZES.map((size) => {
                        const key = `${name}-${variant}-${surface.key}-${size}`;
                        const disabled = size === 20 && variant === 'standard';
                        const isPressed = pressedKey === key;
                        return (
                          <Pressable
                            key={key}
                            testID={`icon-review-cell-${key}`}
                            onPressIn={() => setPressedKey(key)}
                            onPressOut={() => setPressedKey(null)}
                            disabled={disabled}
                            style={[
                              styles.sizeCell,
                              isPressed && styles.sizeCellPressed,
                              disabled && styles.sizeCellDisabled,
                            ]}
                            accessibilityLabel={`${name} ${variant} ${size}px ${surface.label}`}
                          >
                            <KScanIcon
                              name={name as KScanIconName}
                              size={size}
                              variant={variant}
                              color={surface.color}
                              accentColor={surface.accentColor}
                            />
                            <Text
                              style={[
                                styles.sizeLabel,
                                surface.key === 'plum-inverted' && styles.sizeLabelInverse,
                              ]}
                            >
                              {size}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
  },
  blocked: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: LUXURY.colors.ivory,
  },
  blockedText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
  content: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  title: {
    ...LUXURY.typography.displayHeadline,
    fontSize: 22,
    color: LUXURY.colors.ink,
  },
  subtitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.md,
  },
  iconBlock: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: 16,
    padding: SPACING.md,
    backgroundColor: LUXURY.colors.pearl,
    gap: SPACING.md,
  },
  iconName: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.plum,
  },
  variantBlock: {
    gap: SPACING.sm,
  },
  variantLabel: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  surfaceBlock: {
    gap: 4,
  },
  surfaceLabel: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
  },
  sizeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    padding: SPACING.sm,
    borderRadius: 12,
  },
  sizeCell: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 56,
    minHeight: 64,
    padding: 6,
    borderRadius: 10,
  },
  sizeCellPressed: {
    opacity: 0.72,
    backgroundColor: 'rgba(63, 11, 47, 0.08)',
  },
  sizeCellDisabled: {
    opacity: 0.35,
  },
  sizeLabel: {
    marginTop: 4,
    fontSize: 10,
    color: LUXURY.colors.graphite,
  },
  sizeLabelInverse: {
    color: LUXURY.colors.goldLight,
  },
});
