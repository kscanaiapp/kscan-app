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
import { useAiOutputReporting } from '../../contexts/AiOutputReportingContext';

interface StyleAnalysisSectionProps {
  analysisText?: string;
  testID?: string;
  /**
   * Persisted identity of the scan this analysis describes (the Recent Scan id,
   * or the QA fixture name): the report target. Null hides the Report control
   * rather than filing a report the server cannot resolve.
   */
  scanSourceId?: string | null;
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
  scanSourceId,
}: StyleAnalysisSectionProps) {
  const [expanded, setExpanded] = useState(false);
  // Resolves the NEAREST provider: inside ScanResultV2 that is the one its Modal
  // nests (ResultSurfaceModal), so the report sheet presents from the result's
  // own view controller on iOS instead of the app-root one it cannot present over.
  const { openAiOutputReport } = useAiOutputReporting();

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

          {/* In-app reporting of this model-authored prose. Scan Results V2 is the
              surface every governed build renders for a live scan (AnalysisCard is
              only reached from a reopened Recent Scan), so the control has to live
              here or a live result offers no way to report it at all. Hidden until
              the scan has a persisted id: a report with no target cannot be actioned. */}
          {scanSourceId ? (
            <TouchableOpacity
              onPress={() =>
                openAiOutputReport({ feature: 'Scan Results', itemId: scanSourceId })
              }
              style={styles.reportButton}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Report this style analysis as offensive or unsafe"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              testID="scan-result-v2-report-ai"
            >
              <Text style={styles.reportText}>Report Response</Text>
            </TouchableOpacity>
          ) : null}
        </>
      ) : (
        <Text style={styles.preparedBody}>
          K Scan AI identified the core fashion attributes from this scan.
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
  reportButton: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-start',
    // 48pt, the shared touch-target minimum (the legacy AnalysisCard control is 32).
    minHeight: 48,
    justifyContent: 'center',
  },
  reportText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    letterSpacing: 0.6,
    textDecorationLine: 'underline',
  },
});
