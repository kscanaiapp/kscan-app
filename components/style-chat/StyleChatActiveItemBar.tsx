// The fashion item Elise is currently discussing.
//
// A compact, persistent statement of context — thumbnail, approved label, and an
// honest saved/not-saved line — so the user never has to infer which photo the
// next answer is about.
//
// NO NEW DESIGN SYSTEM. Every colour, radius, spacing token and type ramp comes
// from constants/theme.ts, and the chip geometry mirrors
// StyleChatAttachmentBar's chip so the two read as one surface.
//
// WHAT THIS MUST NEVER RENDER: a candidate id, a saved-scan id, a Closet item
// id, an actor id, or an image path. It receives an `EliseActiveItemContext`,
// which by construction carries none of those — the Dressing Room handoff takes
// its id from a separate resolver against the live drafts.
//
// OWNERSHIP IS STATED, NOT IMPLIED. The badge says "Not saved to Closet" until
// the Closet persistence contract has actually reported a committed item. An
// attached photo is a candidate, and this bar says so.

import React from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  ELISE_IMAGE_LOOP_COPY,
  describeClosetState,
  type EliseActiveItemContext,
} from '../../services/style-chat/eliseImageStylingLoop';

export function StyleChatActiveItemBar({
  context,
  onClear,
  onChange,
  disabled,
}: {
  context: EliseActiveItemContext | null;
  onClear: () => void;
  onChange: () => void;
  disabled?: boolean;
}) {
  if (!context) return null;

  const closetLine = describeClosetState(context);
  const saved = context.owned;

  return (
    <View
      style={styles.bar}
      testID="elise-active-item-bar"
      // One announcement for the whole bar: a screen reader should hear "styling
      // X, saved to Closet" as a single fact, not as three unrelated fragments.
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`${ELISE_IMAGE_LOOP_COPY.contextHeading}: ${context.title}. ${closetLine}.`}
    >
      {context.thumbnailUri ? (
        <Image
          source={{ uri: context.thumbnailUri }}
          style={styles.thumb}
          resizeMode="cover"
          // Decorative: the label beside it already names the garment, and a
          // second announcement of the same item is noise.
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : (
        <View style={[styles.thumb, styles.thumbFallback]}>
          <Text style={styles.thumbFallbackText}>{context.title.slice(0, 1)}</Text>
        </View>
      )}
      <View style={styles.meta}>
        <Text style={styles.heading} numberOfLines={1}>
          {ELISE_IMAGE_LOOP_COPY.contextHeading}
        </Text>
        <Text style={styles.title} numberOfLines={2}>
          {context.title}
        </Text>
        <Text
          style={[styles.closet, saved ? styles.closetSaved : null]}
          numberOfLines={1}
          testID="elise-active-item-closet-state"
        >
          {saved ? `${closetLine} ✓` : closetLine}
        </Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          onPress={onChange}
          disabled={disabled}
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel={ELISE_IMAGE_LOOP_COPY.changeAccessibilityLabel}
          accessibilityState={{ disabled: Boolean(disabled) }}
          testID="elise-active-item-change"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.actionText}>{ELISE_IMAGE_LOOP_COPY.changeLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onClear}
          disabled={disabled}
          style={styles.clear}
          accessibilityRole="button"
          accessibilityLabel={ELISE_IMAGE_LOOP_COPY.clearAccessibilityLabel}
          accessibilityState={{ disabled: Boolean(disabled) }}
          testID="elise-active-item-clear"
          // 28px visual control + 10px slop per edge clears the 48dp minimum
          // without changing the accepted visual density of this row.
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.clearText}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: LUXURY.colors.ivory,
    flexShrink: 0,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  thumbFallbackText: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.goldBrushed },
  // flexShrink + minWidth:0 is what lets a long garment name truncate instead of
  // pushing the actions off the row — the same failure Build 25 Phase 2 fixed on
  // the Closet grid.
  meta: { flex: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  heading: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.4,
    color: LUXURY.colors.stone,
  },
  title: { ...LUXURY.typography.caption, color: LUXURY.colors.ink },
  closet: { ...LUXURY.typography.caption, fontSize: 10, color: LUXURY.colors.graphite },
  closetSaved: { color: LUXURY.colors.plum },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flexShrink: 0 },
  action: { minHeight: 28, justifyContent: 'center', paddingHorizontal: 4 },
  actionText: { ...LUXURY.typography.caption, fontSize: 10, color: LUXURY.colors.plum },
  clear: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearText: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.graphite },
});
