// Contextual fashion follow-ups for the item Elise is currently discussing.
//
// A short row of deterministic next questions and one progression action, so a
// successful image answer exposes the next useful move instead of ending the
// conversation.
//
// NOTHING HERE DECIDES ANYTHING. The action set is computed by
// services/style-chat/eliseImageStylingLoop.ts from the attachment's own state
// and the repository's category vocabulary; this file renders what it is given.
// No model is asked which buttons to show, and no ordering can vary between two
// renders of the same state.
//
// AN ACTION WITH NO HANDLER IS NOT RENDERED. That is the mechanical form of "do
// not expose a control that cannot complete": a caller that has not wired the
// Dressing Room handoff cannot accidentally ship a Style This Item chip that
// does nothing.
//
// NO NEW DESIGN SYSTEM. The pill geometry is the existing STYLE THIS WITH ELISE
// chip from app/style-chat/[sessionId].tsx, and every token comes from
// constants/theme.ts.

import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  resolveFollowUpActions,
  resolveFollowUpLeadIn,
  type EliseActiveItemContext,
  type EliseFollowUpAction,
} from '../../services/style-chat/eliseImageStylingLoop';

export type StyleChatFollowUpHandlers = {
  onPrompt: (prompt: string) => void;
  onSaveToCloset?: () => void;
  onStyleThisItem?: () => void;
  onOpenDressingRoom?: () => void;
  onChangeSomething?: () => void;
};

function handlerFor(
  action: EliseFollowUpAction,
  handlers: StyleChatFollowUpHandlers,
): (() => void) | null {
  switch (action.type) {
    case 'prompt':
      return action.prompt ? () => handlers.onPrompt(action.prompt as string) : null;
    case 'save_to_closet':
      return handlers.onSaveToCloset ?? null;
    case 'style_this_item':
      return handlers.onStyleThisItem ?? null;
    case 'open_dressing_room':
      return handlers.onOpenDressingRoom ?? null;
    case 'change_something':
      return handlers.onChangeSomething ?? null;
    default:
      return null;
  }
}

/** The progression actions get the emphasized treatment; questions stay quiet. */
function isPrimary(action: EliseFollowUpAction): boolean {
  return action.type !== 'prompt';
}

export function StyleChatFollowUpBar({
  context,
  handlers,
  disabled,
}: {
  context: EliseActiveItemContext | null;
  handlers: StyleChatFollowUpHandlers;
  disabled?: boolean;
}) {
  if (!context) return null;

  const actions = resolveFollowUpActions(context)
    .map((action) => ({ action, onPress: handlerFor(action, handlers) }))
    .filter((entry): entry is { action: EliseFollowUpAction; onPress: () => void } =>
      entry.onPress !== null,
    );
  if (actions.length === 0) return null;

  const leadIn = resolveFollowUpLeadIn(context);

  return (
    <View style={styles.wrap} testID="elise-followup-bar">
      {leadIn ? (
        <Text style={styles.leadIn} accessibilityRole="header">
          {leadIn}
        </Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {actions.map(({ action, onPress }) => {
          const primary = isPrimary(action);
          // A busy control stays mounted and announces itself busy rather than
          // disappearing: the row must not reflow under a finger already moving
          // toward it, and success must be legible without an animation.
          const isDisabled = Boolean(disabled) || action.busy === true;
          return (
            <TouchableOpacity
              key={action.id}
              onPress={onPress}
              disabled={isDisabled}
              style={[styles.chip, primary ? styles.chipPrimary : null, isDisabled ? styles.chipDisabled : null]}
              accessibilityRole="button"
              accessibilityLabel={action.accessibilityLabel}
              accessibilityState={{ disabled: isDisabled, busy: action.busy === true }}
              testID={`elise-followup-${action.id}`}
            >
              {action.busy ? (
                <ActivityIndicator size="small" color={LUXURY.colors.plum} style={styles.chipSpinner} />
              ) : null}
              <Text
                style={[styles.chipText, primary ? styles.chipTextPrimary : null]}
                numberOfLines={1}
              >
                {action.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xs, gap: 2 },
  leadIn: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.4,
    color: LUXURY.colors.stone,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.lg,
    // 10px vertical padding around a ~18px line box clears the 44dp minimum
    // touch target while keeping the row visually light.
    paddingVertical: 10,
    minHeight: 44,
  },
  chipPrimary: { borderColor: LUXURY.colors.gold },
  chipDisabled: { opacity: 0.6 },
  chipSpinner: { marginRight: 2 },
  chipText: { ...LUXURY.typography.caption, color: LUXURY.colors.graphite },
  chipTextPrimary: { color: LUXURY.colors.goldText, letterSpacing: 1.2 },
});
