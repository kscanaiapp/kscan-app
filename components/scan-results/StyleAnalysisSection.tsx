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
   * Persisted identity of the scan this analysis describes, used as the report
   * target. Null disables the report control rather than filing an
   * unresolvable report.
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

          {/*
            KSB29-021 — AI-output reporting on the surface production actually
            renders.

            SCAN_RESULTS_V2_UI is enabled in the production profile, so this
            component IS the primary Scan Results AI-output surface. The Report
            control existed only on the legacy AnalysisCard path, which that
            flag branches away from — so the shipped app exposed no way to
            report model-authored scan prose at all.

            This reuses the existing reporting flow verbatim (same context, same
            feature name, same service); nothing new is introduced. Hidden when
            there is no persisted scan identity, because a report with no
            resolvable target cannot be actioned.
          */}
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
  reportButton: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-start',
    // 48dp, not the legacy card's 32: this control is being added now, so it
    // is added at the shared touch-target minimum rather than inheriting a
    // violation the accessibility wave would have to come back and repair.
    minHeight: 48,
    justifyContent: 'center',
  },
  toggleText: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 12,
    letterSpacing: 1.6,
  },
  reportText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    letterSpacing: 0.6,
    textDecorationLine: 'underline',
  },
});
