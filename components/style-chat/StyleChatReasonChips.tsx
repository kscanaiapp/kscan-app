import { View, Text, Pressable, StyleSheet } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  reasonCodesForFeedback,
  type StyleDnaReasonCode,
} from '../../services/style-dna/localStyleDnaReasons';
import type { LocalStyleDnaFeedbackValue } from '../../services/style-dna/localStyleDnaFeedbackStore';

// Phase 3 — optional, compact, local-only reason chips shown after a feedback tap.
// Purely presentational: state, persistence, and polarity rules live in useStyleDnaFeedback.

const REASON_LABELS: Record<StyleDnaReasonCode, string> = {
  practical: 'Practical',
  matches_my_style: 'Matches my style',
  good_for_occasion: 'Good for occasion',
  would_try: 'Would try',
  too_bold: 'Too bold',
  too_plain: 'Too plain',
  too_dressy: 'Too dressy',
  too_casual: 'Too casual',
  not_practical: 'Not practical',
  would_not_wear: 'Would not wear',
};

export function StyleChatReasonChips({
  feedback,
  selectedReason,
  isSaving,
  onPick,
}: {
  feedback: LocalStyleDnaFeedbackValue;
  selectedReason: StyleDnaReasonCode | null;
  isSaving?: boolean;
  onPick: (code: StyleDnaReasonCode) => void;
}) {
  const codes = reasonCodesForFeedback(feedback);
  return (
    <View style={styles.wrap}>
      <Text style={styles.prompt}>Add a reason (optional)</Text>
      <View style={styles.chips}>
        {codes.map(code => {
          const selected = selectedReason === code;
          return (
            <Pressable
              key={code}
              onPress={() => onPick(code)}
              disabled={isSaving}
              style={[styles.chip, selected ? styles.chipSelected : null]}
              accessibilityRole="button"
              accessibilityLabel={`Reason: ${REASON_LABELS[code]}`}
              accessibilityState={{ selected, disabled: Boolean(isSaving) }}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                {REASON_LABELS[code]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: SPACING.sm,
  },
  prompt: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    letterSpacing: 0.6,
    marginBottom: SPACING.xs,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  chip: {
    minHeight: 28,
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
  },
  chipSelected: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'rgba(198, 161, 91, 0.14)',
  },
  chipText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.graphite,
    letterSpacing: 0.3,
  },
  chipTextSelected: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
});
