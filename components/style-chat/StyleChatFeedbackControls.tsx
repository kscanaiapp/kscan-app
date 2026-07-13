import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { useStyleDnaFeedback } from '../../hooks/useStyleDnaFeedback';
import type { LocalStyleDnaFeedbackValue } from '../../services/style-dna/localStyleDnaFeedbackStore';
import { StyleChatReasonChips } from './StyleChatReasonChips';

const CONFIRMATION_DURATION_MS = 2200;

const EDUCATION_COPY =
  'Signature Style learns only from the feedback you choose to provide. You can turn learning off or reset it in Settings.';

const FALLBACK_EXPLANATION =
  'Elise based this recommendation on the details in your request and any styling context available in this conversation.';

interface StyleChatFeedbackControlsProps {
  userKey: string;
  sessionId: string;
  messageId: string;
  whyThisWorks?: string | null;
  feedbackEnabled: boolean;
  feedbackEducationDismissed: boolean;
  onDismissEducation: () => void;
  onMenuOpened?: () => void;
  onSaved?: () => void;
}

type MenuState = 'closed' | 'open';

export function StyleChatFeedbackControls({
  userKey,
  sessionId,
  messageId,
  whyThisWorks,
  feedbackEnabled,
  feedbackEducationDismissed,
  onDismissEducation,
  onMenuOpened,
  onSaved,
}: StyleChatFeedbackControlsProps) {
  const [menuState, setMenuState] = useState<MenuState>('closed');
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ text: string; visible: boolean }>({
    text: '',
    visible: false,
  });
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const feedbackEnabledRef = useRef(feedbackEnabled);
  const submissionPendingRef = useRef(false);
  feedbackEnabledRef.current = feedbackEnabled;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      feedbackEnabledRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
    };
  }, []);

  const showConfirmation = useCallback((text: string) => {
    if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
    setConfirmation({ text, visible: true });
    AccessibilityInfo.announceForAccessibility(text);
    confirmationTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setConfirmation((prev) => ({ ...prev, visible: false }));
    }, CONFIRMATION_DURATION_MS);
  }, []);

  const handleFeedbackSaved = useCallback(
    (value: LocalStyleDnaFeedbackValue) => {
      submissionPendingRef.current = false;
      if (mountedRef.current && feedbackEnabledRef.current) {
        showConfirmation(
          value === 'helpful' ? 'Added to Signature Style' : 'Noted for Signature Style',
        );
      }
      onSaved?.();
    },
    [onSaved, showConfirmation],
  );

  const {
    selectedFeedback,
    isSavingFeedback,
    feedbackError,
    saveFeedback,
    reasonEnabled,
    selectedReason,
    isSavingReason,
    saveReason,
  } = useStyleDnaFeedback({
    userKey,
    sessionId,
    messageId,
    enabled: feedbackEnabled,
    onSaved: handleFeedbackSaved,
  });

  useEffect(() => {
    if (feedbackError) submissionPendingRef.current = false;
  }, [feedbackError]);

  const handlePositive = useCallback(() => {
    if (
      !feedbackEnabledRef.current ||
      submissionPendingRef.current ||
      selectedFeedback === 'helpful'
    ) {
      setMenuState('closed');
      return;
    }
    submissionPendingRef.current = true;
    void saveFeedback('helpful');
    setMenuState('closed');
  }, [selectedFeedback, saveFeedback]);

  const handleNegative = useCallback(() => {
    if (
      !feedbackEnabledRef.current ||
      submissionPendingRef.current ||
      selectedFeedback === 'not_my_style'
    ) {
      setMenuState('closed');
      return;
    }
    submissionPendingRef.current = true;
    void saveFeedback('not_my_style');
    setMenuState('closed');
  }, [selectedFeedback, saveFeedback]);

  const handleWhy = useCallback(() => {
    setExplanationOpen(true);
    setMenuState('closed');
  }, []);

  const toggleMenu = useCallback(() => {
    setMenuState((current) => (current === 'open' ? 'closed' : 'open'));
  }, []);

  const dismissEducation = useCallback(() => {
    onDismissEducation();
  }, [onDismissEducation]);

  const positiveSelected = selectedFeedback === 'helpful';
  const negativeSelected = selectedFeedback === 'not_my_style';

  const menu = menuState === 'open' ? (
    <View
      style={styles.menu}
      testID="style-chat-feedback-menu"
      onLayout={onMenuOpened}
      accessibilityRole="menu"
      accessibilityLabel="Signature Style feedback options"
    >
      {!feedbackEducationDismissed ? (
        <View style={styles.educationRow}>
          <Text style={styles.educationText}>{EDUCATION_COPY}</Text>
          <Pressable
            onPress={dismissEducation}
            style={styles.educationDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss Signature Style education"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.educationDismissText}>Got it</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        onPress={handlePositive}
        disabled={isSavingFeedback}
        style={({ pressed }) => [styles.menuItem, pressed ? styles.menuItemPressed : null]}
        accessibilityRole="menuitem"
        accessibilityLabel="This fits my style"
        accessibilityState={{ selected: positiveSelected, disabled: isSavingFeedback }}
      >
        <Text style={[styles.menuItemText, positiveSelected ? styles.menuItemTextSelected : null]}>
          {positiveSelected ? '✓ This fits my style' : 'This fits my style'}
        </Text>
      </Pressable>
      <Pressable
        onPress={handleNegative}
        disabled={isSavingFeedback}
        style={({ pressed }) => [styles.menuItem, pressed ? styles.menuItemPressed : null]}
        accessibilityRole="menuitem"
        accessibilityLabel="Not my style"
        accessibilityState={{ selected: negativeSelected, disabled: isSavingFeedback }}
      >
        <Text style={[styles.menuItemText, negativeSelected ? styles.menuItemTextSelected : null]}>
          {negativeSelected ? '✓ Not my style' : 'Not my style'}
        </Text>
      </Pressable>
      <Pressable
        onPress={handleWhy}
        style={({ pressed }) => [styles.menuItem, styles.menuItemLast, pressed ? styles.menuItemPressed : null]}
        accessibilityRole="menuitem"
        accessibilityLabel="Why this recommendation?"
      >
        <Text style={styles.menuItemText}>Why this recommendation?</Text>
      </Pressable>
      {reasonEnabled && selectedFeedback != null ? (
        <View style={styles.menuReasons}>
          <StyleChatReasonChips
            feedback={selectedFeedback}
            selectedReason={selectedReason}
            isSaving={isSavingReason}
            onPick={saveReason}
          />
        </View>
      ) : null}
    </View>
  ) : null;

  const explanationBlock = explanationOpen ? (
    <View style={styles.explanationPanel} testID="style-chat-explanation-panel">
      <Text style={styles.explanationTitle}>Why this recommendation?</Text>
      <Text style={styles.explanationBody}>
        {whyThisWorks?.trim() ? whyThisWorks.trim() : FALLBACK_EXPLANATION}
      </Text>
      <Pressable
        onPress={() => setExplanationOpen(false)}
        style={styles.explanationClose}
        accessibilityRole="button"
        accessibilityLabel="Hide explanation"
      >
        <Text style={styles.explanationCloseText}>Hide</Text>
      </Pressable>
    </View>
  ) : null;

  return (
    <View style={styles.container} testID="style-chat-feedback-controls">
      <View style={styles.inlineWrap}>
        <Pressable
          onPress={toggleMenu}
          style={({ pressed }) => [styles.overflowButton, pressed ? styles.overflowButtonPressed : null]}
          accessibilityRole="button"
          accessibilityLabel="More feedback options"
          accessibilityHint="Opens optional feedback actions for this recommendation"
          accessibilityState={{ expanded: menuState === 'open' }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.overflowIcon}>⋯</Text>
        </Pressable>
      </View>
      {menu}
      {feedbackError ? (
        <Text style={styles.errorText} accessibilityLiveRegion="polite">
          {feedbackError}
        </Text>
      ) : null}
      {confirmation.visible ? (
        <View
          style={styles.confirmationRow}
          accessible={false}
          importantForAccessibility="no"
        >
          <Text style={styles.confirmationText}>{confirmation.text}</Text>
        </View>
      ) : null}
      {explanationBlock}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.hairline,
    minHeight: 36,
    justifyContent: 'center',
  },
  inlineWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  overflowButton: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  overflowButtonPressed: {
    backgroundColor: LUXURY.colors.pearl,
  },
  overflowIcon: {
    fontSize: 16,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
    marginTop: -2,
  },
  menu: {
    marginTop: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    overflow: 'hidden',
  },
  educationRow: {
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.hairline,
    backgroundColor: 'rgba(198, 161, 91, 0.08)',
    gap: SPACING.sm,
  },
  educationText: {
    ...LUXURY.typography.body,
    fontSize: 12,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
  },
  educationDismiss: {
    alignSelf: 'flex-start',
  },
  educationDismissText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  menuItem: {
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.hairline,
  },
  menuItemLast: {
    borderBottomWidth: 0,
  },
  menuItemPressed: {
    backgroundColor: LUXURY.colors.pearl,
  },
  menuItemText: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.ink,
  },
  menuItemTextSelected: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  menuReasons: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
  },
  explanationPanel: {
    marginTop: SPACING.sm,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    gap: SPACING.sm,
  },
  explanationTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  explanationBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  explanationClose: {
    alignSelf: 'flex-start',
  },
  explanationCloseText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  errorText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.error,
    marginTop: SPACING.xs,
    letterSpacing: 0.6,
  },
  confirmationRow: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-start',
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
    backgroundColor: 'rgba(198, 161, 91, 0.14)',
  },
  confirmationText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.goldText,
    letterSpacing: 0.6,
  },
});
