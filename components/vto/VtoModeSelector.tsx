/**
 * The Live / AI Photo choice.
 *
 * RENDERED ONLY WHEN BOTH MODES REALLY WORK. The owner gates this on
 * `shouldOfferModeChoice`, so a customer on a build with no Live runtime --
 * which is every build today -- sees no selector, no greyed-out tab, and no
 * "coming soon" chrome. The absence of Live is not a state this component
 * expresses; it is a state in which this component does not exist.
 *
 * THE COPY DISTINGUISHES PROCESSING, NOT TECHNOLOGY. Each mode carries one
 * short line about where the work happens, because that is the difference a
 * customer can act on. Live is local. AI Photo sends a photo they chose to a
 * governed cloud provider -- and the second line says so rather than letting
 * "private" from the first line spill over onto it.
 *
 * Engineering copy only. Final product wording is a product/legal decision and
 * is deliberately not settled in this lane.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { selectionTick } from '../../services/haptics';
import {
  AI_PHOTO_PROCESSING_NOTE,
  LIVE_VTO_PROCESSING_NOTE,
} from '../../types/vtoLive';

export type VtoSurfaceMode = 'live' | 'ai_photo';

export interface VtoModeSelectorProps {
  mode: VtoSurfaceMode;
  onChange: (mode: VtoSurfaceMode) => void;
  testID?: string;
}

const OPTIONS: ReadonlyArray<{
  key: VtoSurfaceMode;
  label: string;
  blurb: string;
  processing: string;
  testID: string;
}> = [
  {
    key: 'live',
    label: 'LIVE',
    blurb: 'See it move with you',
    processing: LIVE_VTO_PROCESSING_NOTE,
    testID: 'vto-mode-live',
  },
  {
    key: 'ai_photo',
    label: 'AI PHOTO',
    blurb: 'Create a realistic AI visualization',
    processing: AI_PHOTO_PROCESSING_NOTE,
    testID: 'vto-mode-ai-photo',
  },
];

export function VtoModeSelector({ mode, onChange, testID }: VtoModeSelectorProps) {
  return (
    <View style={styles.root} testID={testID ?? 'vto-mode-selector'} accessibilityRole="tablist">
      {OPTIONS.map((option) => {
        const selected = option.key === mode;
        return (
          <Pressable
            key={option.key}
            onPress={() => {
              if (selected) return;
              selectionTick();
              onChange(option.key);
            }}
            style={[styles.option, selected ? styles.optionSelected : null]}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${option.label}. ${option.blurb}. ${option.processing}`}
            testID={option.testID}
          >
            <Text style={[styles.label, selected ? styles.labelSelected : null]}>{option.label}</Text>
            <Text style={styles.blurb} numberOfLines={2}>
              {option.blurb}
            </Text>
            {/* The processing line is per-mode on purpose: K Scan must never
                describe the whole try-on feature as on-device. */}
            <Text style={styles.processing} numberOfLines={2}>
              {option.processing}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  option: {
    flex: 1,
    minHeight: 44,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.warmWhite,
  },
  optionSelected: {
    backgroundColor: LUXURY.colors.champagne,
    borderColor: LUXURY.colors.goldBrushed,
  },
  label: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.graphite,
  },
  labelSelected: {
    color: LUXURY.colors.plumDeep,
  },
  blurb: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    marginTop: SPACING.xxs,
  },
  processing: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    marginTop: SPACING.xxs,
    color: LUXURY.colors.stone,
  },
});
