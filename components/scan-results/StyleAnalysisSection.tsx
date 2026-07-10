import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

interface StyleAnalysisSectionProps {
  analysisText?: string;
  testID?: string;
}

/**
 * Style analysis section with local expand/collapse.
 *
 * - Shows the full analysis text if short; otherwise truncates with a
 *   "View Full Analysis" toggle.
 * - If no analysis text exists, shows a prepared fallback message.
 */
export function StyleAnalysisSection({
  analysisText,
  testID,
}: StyleAnalysisSectionProps) {
  const [expanded, setExpanded] = useState(false);

  // Enable LayoutAnimation on Android
  if (Platform.OS === 'android') {
    UIManager.setLayoutAnimationEnabledExperimental?.(true);
  }

  const hasAnalysis = Boolean(analysisText && analysisText.trim());
  const text = hasAnalysis ? analysisText!.trim() : '';

  // Show a short excerpt if text is long and not expanded
  const MAX_SHORT_CHARS = 180;
  const isLong = text.length > MAX_SHORT_CHARS;
  const displayText = expanded || !isLong ? text : text.slice(0, MAX_SHORT_CHARS) + '…';

  const toggleExpanded = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  };

  return (
    <View style={styles.container} testID={testID ?? 'style-analysis-section'}>
      <Text style={styles.sectionLabel}>STYLE ANALYSIS</Text>

      {hasAnalysis ? (
        <>
          <Text style={styles.body}>{displayText}</Text>
          {isLong && (
            <TouchableOpacity
              onPress={toggleExpanded}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Collapse analysis' : 'View full analysis'}
              style={styles.toggleButton}
            >
              <Text style={styles.toggleText}>
                {expanded ? 'Show Less' : 'View Full Analysis'}
              </Text>
            </TouchableOpacity>
          )}
        </>
      ) : (
        <Text style={styles.preparedBody}>
          K Scan identified the core fashion attributes from this scan.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    ...SHADOWS.editorialSmall,
  },
  sectionLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom: SPACING.md,
  },
  body: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  preparedBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.stone,
    fontStyle: 'italic',
  },
  toggleButton: {
    marginTop: SPACING.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  toggleText: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 12,
    letterSpacing: 1.6,
  },
});
