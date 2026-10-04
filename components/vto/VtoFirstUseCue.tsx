/**
 * The first-use cue for Try It On.
 *
 * An INLINE block that sits above the product's own Try It On control. It is
 * not a Modal and not an overlay, so it cannot stack on another sheet, cannot
 * trap focus, and animates nothing. It appears at most once per session, only
 * after the control has genuinely been looked at, and "Not now" retires it for
 * good -- services/vto/vtoDiscovery.ts (resolveVtoFirstUseCue) decides all of
 * that, and this component only renders the answer.
 *
 * "Try it on" does exactly what the control beneath it does: it calls the
 * caller's own handler. Nothing here opens a photo chooser or starts a request.
 */

import React, { useCallback, type RefObject } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { useVtoFirstUseCue, type VtoMeasurable } from '../../hooks/useVtoAwareness';
import { selectionTick } from '../../services/haptics';
import { VTO_DISCOVERY_COPY as COPY, type VtoProductCta } from '../../services/vto/vtoDiscovery';
import { KScanIcon } from '../icons/kscan';

export interface VtoFirstUseCueProps {
  /** What the control this cue points at currently does. */
  cta: VtoProductCta;
  /** The Try It On control. Measured only. */
  targetRef: RefObject<VtoMeasurable | null>;
  /** The control's own press handler. */
  onTry: () => void;
  testID?: string;
}

export function VtoFirstUseCue({ cta, targetRef, onTry, testID = 'vto-first-use-cue' }: VtoFirstUseCueProps) {
  const { visible, notePrimaryTap, dismiss } = useVtoFirstUseCue({ cta, targetRef });

  const handleTry = useCallback(() => {
    notePrimaryTap();
    onTry();
  }, [notePrimaryTap, onTry]);

  const handleDismiss = useCallback(() => {
    selectionTick();
    dismiss();
  }, [dismiss]);

  if (!visible) return null;

  return (
    <View style={styles.cue} testID={testID} accessibilityLiveRegion="polite">
      <View style={styles.titleRow}>
        <View
          style={styles.titleIcon}
          accessible={false}
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          <KScanIcon
            name="try-on"
            size={16}
            variant="compact"
            color={LUXURY.colors.plumDeep}
            accentColor={LUXURY.colors.gold}
          />
        </View>
        <Text style={styles.title} accessibilityRole="header">
          {COPY.title}
        </Text>
      </View>
      <Text style={styles.body}>{COPY.cueBody}</Text>
      <View style={styles.actions}>
        <Pressable
          onPress={handleTry}
          style={({ pressed }) => [styles.action, styles.primary, pressed && styles.primaryPressed]}
          accessibilityRole="button"
          accessibilityLabel={COPY.title}
          testID={`${testID}-try`}
        >
          <Text style={styles.primaryText}>{COPY.cuePrimary}</Text>
        </Pressable>
        <Pressable
          onPress={handleDismiss}
          style={({ pressed }) => [styles.action, pressed && styles.dismissPressed]}
          accessibilityRole="button"
          accessibilityLabel={COPY.cueDismissA11y}
          testID={`${testID}-dismiss`}
        >
          <Text style={styles.dismissText}>{COPY.cueDismiss}</Text>
        </Pressable>
      </View>
      {/*
          The cue teaches the control directly beneath it, so it carries a
          small diamond pointer on its bottom edge -- a nudge from a fashion
          assistant, visually connected to the button it describes. Pure
          layout: in flow, decorative, and it never intercepts a touch.
      */}
      <View style={styles.pointer} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  cue: {
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
    gap: SPACING.xs,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.pearl,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  titleIcon: {
    width: 24,
    height: 24,
    borderRadius: RADIUS.sm,
    backgroundColor: LUXURY.colors.champagne,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    color: LUXURY.colors.ink,
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 19,
    color: LUXURY.colors.graphite,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  action: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
  },
  primary: {
    backgroundColor: LUXURY.colors.plumDeep,
  },
  primaryPressed: {
    backgroundColor: LUXURY.colors.plum,
  },
  primaryText: {
    ...LUXURY.typography.cta,
    fontSize: 12,
    color: LUXURY.colors.pearl,
  },
  dismissPressed: {
    opacity: 0.6,
  },
  dismissText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  // A rotated square sitting on the cue's bottom hairline: the half below the
  // edge reads as the pointer aimed at the Try It On control.
  pointer: {
    alignSelf: 'center',
    width: 12,
    height: 12,
    marginTop: SPACING.xxs,
    marginBottom: -6,
    backgroundColor: LUXURY.colors.pearl,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: LUXURY.colors.hairline,
    transform: [{ rotate: '45deg' }],
  },
});
