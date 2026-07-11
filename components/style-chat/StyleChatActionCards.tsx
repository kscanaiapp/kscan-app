// StyleChat structured-action cards (Phase 2).
//
// Renders server-validated actions below an assistant message as compact
// chips. Labels are app-controlled (mapped from action type; server-normalized
// copy is used only when present and bounded). Raw JSON is never rendered and
// actions are navigation intents only — no mutation executes without further
// explicit user steps inside the target flow. One in-flight action at a time;
// consumed actions disable, failed navigation re-enables with a concise error.

import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';

import { LUXURY, SPACING } from '../../constants/theme';
import { recordAiStylistEvent } from '../../services/styleMemoryEvents';
import { ELISE_STRUCTURED_ACTION_LABELS } from '../../constants/elise';

const APP_LABELS = ELISE_STRUCTURED_ACTION_LABELS;

export type StyleChatActionBlockAction = {
  type: string;
  label?: string;
  payload?: {
    anchor?: { sourceType: string; sourceId: string };
    keepItems?: Array<{ sourceType: string; sourceId: string }>;
    lookId?: string;
    occasion?: string;
    dressCode?: string;
    contextHint?: string;
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildQuery(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => !!value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Local schema validation + mapping to existing shared routes only. */
function resolveNavigation(action: StyleChatActionBlockAction): string | null {
  const payload = action.payload ?? {};
  const anchor =
    payload.anchor &&
    (payload.anchor.sourceType === 'saved_scan' || payload.anchor.sourceType === 'inspiration_item') &&
    UUID_RE.test(payload.anchor.sourceId ?? '')
      ? payload.anchor
      : null;

  switch (action.type) {
    case 'open_stylist':
    case 'style_anchor_item':
    case 'swap_item':
      if (action.type !== 'open_stylist' && !anchor) return null;
      return `/stylist${buildQuery({
        anchorSourceType: anchor?.sourceType,
        anchorSourceId: anchor?.sourceId,
        note: payload.contextHint,
      })}`;
    case 'style_for_event':
      return `/stylist${buildQuery({
        occasion: payload.occasion,
        dressCode: payload.dressCode,
        anchorSourceType: anchor?.sourceType,
        anchorSourceId: anchor?.sourceId,
        note: payload.contextHint,
      })}`;
    case 'restyle_outfit': {
      // Kept refs pass through the shared Stylist which revalidates ownership
      // server-side; only the first kept ref is used as the pinned anchor.
      const keep = (payload.keepItems ?? []).filter(
        (ref) =>
          (ref.sourceType === 'saved_scan' || ref.sourceType === 'inspiration_item') &&
          UUID_RE.test(ref.sourceId ?? ''),
      );
      const first = keep[0] ?? anchor;
      return `/stylist${buildQuery({
        anchorSourceType: first?.sourceType,
        anchorSourceId: first?.sourceId,
        note: payload.contextHint,
      })}`;
    }
    case 'open_look':
      return payload.lookId && UUID_RE.test(payload.lookId) ? `/looks/${payload.lookId}` : null;
    case 'ask_my_room':
      // Opens Look detail, where the established Ask My Room UI lives;
      // nothing is shared automatically.
      return payload.lookId && UUID_RE.test(payload.lookId) ? `/looks/${payload.lookId}` : null;
    default:
      return null; // unknown types are never rendered as navigable
  }
}

export function StyleChatActionCards({ actions }: { actions: StyleChatActionBlockAction[] }) {
  const [consumed, setConsumed] = useState<Set<number>>(new Set());
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = actions.filter((action) => resolveNavigation(action) !== null);
  if (valid.length === 0) return null;

  const handlePress = (action: StyleChatActionBlockAction, index: number) => {
    if (inFlight || consumed.has(index)) return; // one navigation per tap
    const target = resolveNavigation(action);
    if (!target) return;
    setInFlight(true);
    setError(null);
    try {
      router.push(target as never);
      setConsumed((current) => new Set(current).add(index));
      void recordAiStylistEvent({
        eventType: 'stylechat_stylist_action_opened',
        signalKey: `${action.type}:${Date.now()}`,
        payload: { actionType: action.type },
      });
    } catch {
      setError("Couldn't open that. Try again.");
    } finally {
      setInFlight(false);
    }
  };

  return (
    <View style={styles.wrap}>
      {valid.map((action, index) => {
        const label = APP_LABELS[action.type] ?? 'Open';
        const done = consumed.has(index);
        return (
          <TouchableOpacity
            key={`${action.type}-${index}`}
            style={[styles.card, (done || inFlight) && styles.cardDisabled]}
            onPress={() => handlePress(action, index)}
            disabled={done || inFlight}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: done || inFlight }}
            testID="stylechat-action-card"
          >
            <Text style={[styles.cardText, done && styles.cardTextDisabled]}>
              {label.toUpperCase()}
            </Text>
          </TouchableOpacity>
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.xs, marginTop: SPACING.xs },
  card: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  cardDisabled: { opacity: 0.5 },
  cardText: { ...LUXURY.typography.caption, color: LUXURY.colors.goldText, letterSpacing: 1.4 },
  cardTextDisabled: { color: LUXURY.colors.graphite },
  error: { ...LUXURY.typography.caption, color: LUXURY.colors.error },
});
