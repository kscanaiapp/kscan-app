// "Wore This" — the explicit wear action (Build 29 Closet V2 / S6).
//
// PRODUCT INTENT: the repeated action should feel like "I wore this today",
// not "create a wardrobe wear event". Internal naming stays technical; nothing
// the user reads does.
//
// SAFETY PROPERTIES this component is responsible for:
//   * It never reports success before the canonical service acknowledges the
//     write. A wear the database did not accept must not appear on screen as
//     one — the user would stop retrying and quietly lose the record.
//   * It disables itself while in flight, so a double tap cannot even reach
//     the service. Idempotency at the database is the backstop, not the
//     first line of defence.
//   * It distinguishes a NEW wear from a DEDUPLICATED retry, because telling
//     someone "logged" twice for one wear implies two wears were recorded.
//   * A failure leaves the item untouched and offers a retry.

import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { WearHistoryResult } from '../../services/wearHistory';

type Status = 'idle' | 'pending' | 'recorded' | 'already' | 'error';

export interface WoreThisButtonProps {
  /** Runs the canonical wear write. Must resolve, never throw. */
  onLogWear: () => Promise<WearHistoryResult>;
  /** Called only after a confirmed write so dependent views can refresh. */
  onRecorded?: () => void;
  /** Accessible name; defaults to the generic action. */
  accessibilityLabel?: string;
  testID?: string;
  /** Compact variant for dense grids. */
  compact?: boolean;
}

const COPY: Record<Status, string> = {
  idle: 'Wore this',
  pending: 'Saving…',
  recorded: 'Logged',
  already: 'Already logged',
  error: 'Try again',
};

export function WoreThisButton({
  onLogWear,
  onRecorded,
  accessibilityLabel,
  testID = 'wore-this-button',
  compact = false,
}: WoreThisButtonProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string | null>(null);
  // A ref rather than state: state updates are async and two taps in the same
  // frame would both read `idle` and both fire.
  const inFlight = useRef(false);

  const handlePress = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus('pending');
    setMessage(null);

    try {
      const result = await onLogWear();
      if (result.ok !== true) {
        setStatus('error');
        setMessage(result.error);
        return;
      }
      // `deduplicated` means the write resolved onto an existing wear. Saying
      // "Logged" again would imply a second wear was recorded.
      setStatus(result.deduplicated ? 'already' : 'recorded');
      onRecorded?.();
    } catch {
      setStatus('error');
      setMessage('Could not record that. Try again.');
    } finally {
      inFlight.current = false;
    }
  }, [onLogWear, onRecorded]);

  const isPending = status === 'pending';
  const isDone = status === 'recorded' || status === 'already';
  // A recorded wear is terminal for this render: re-pressing would be a second
  // logical action, which belongs to a fresh mount, not a stale button.
  const disabled = isPending || isDone;

  return (
    <View>
      <Pressable
        testID={testID}
        onPress={handlePress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? 'Record that you wore this today'}
        accessibilityState={{ disabled, busy: isPending }}
        // Screen readers announce the outcome rather than relying on the
        // colour change alone.
        accessibilityHint={
          isDone ? 'Already recorded for today' : 'Records a wear for today'
        }
        style={({ pressed }) => [
          styles.button,
          compact && styles.buttonCompact,
          isDone && styles.buttonDone,
          status === 'error' && styles.buttonError,
          pressed && !disabled && styles.buttonPressed,
          disabled && styles.buttonDisabled,
        ]}
      >
        {isPending ? (
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
        ) : (
          <Text style={[styles.label, compact && styles.labelCompact]} numberOfLines={1}>
            {COPY[status]}
          </Text>
        )}
      </Pressable>
      {message ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44, // accessible hit target
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: {
    minHeight: 44,
    paddingHorizontal: SPACING.sm,
  },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.9 },
  buttonDone: {
    borderColor: LUXURY.colors.plum,
  },
  buttonError: {
    borderColor: LUXURY.colors.stone,
  },
  label: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.plum,
  },
  labelCompact: { fontSize: 10 },
  error: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    marginTop: SPACING.xs,
  },
});
