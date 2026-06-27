/**
 * components/glasses/GlassesResultPreview.tsx
 *
 * React Native component that displays a mock glasses analysis result.
 *
 * Rules:
 * - Uses only React Native primitives.
 * - No project-specific UI components or shared theme imports.
 * - No backend calls.
 * - No production wiring.
 * - No Expo Router / navigation dependency.
 */

import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { GlassesMockResult } from '../../types/glasses';

interface Props {
  result: GlassesMockResult | null;
}

export const GlassesResultPreview: React.FC<Props> = ({ result }) => {
  if (!result) {
    return (
      <View style={styles.container}>
        <Text style={styles.placeholder}>No result yet. Run a mock scan.</Text>
      </View>
    );
  }

  const isLowConfidence = result.confidenceLevel === 'low' || result.confidenceLevel === 'uncertain';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <View style={styles.mockBanner}>
        <Text style={styles.mockBannerText}>
          This is a local prototype preview. Cloud analysis is not connected in this build.
        </Text>
      </View>

      <Text style={styles.title}>{result.title}</Text>
      <Text style={styles.summary}>{result.summary}</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Category:</Text>
        <Text style={styles.value}>{result.category}</Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Color:</Text>
        <Text style={styles.value}>{result.color}</Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Silhouette:</Text>
        <Text style={styles.value}>{result.silhouette}</Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Confidence:</Text>
        <Text
          style={[
            styles.value,
            isLowConfidence ? styles.lowConfidence : styles.highConfidence,
          ]}
        >
          {Math.round(result.confidence * 100)}% ({result.confidenceLevel})
        </Text>
      </View>

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Recommendation</Text>
      <Text style={styles.recommendation}>{result.recommendation}</Text>

      {isLowConfidence && (
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>
            Low confidence result — this is a demo edge case.
          </Text>
        </View>
      )}

      <View style={styles.divider} />

      <Text style={styles.disabledPlaceholder}>
        Share to room — coming later.
      </Text>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    padding: 16,
    gap: 8,
  },
  placeholder: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginTop: 24,
  },
  mockBanner: {
    backgroundColor: '#FFF3CD',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  mockBannerText: {
    fontSize: 13,
    color: '#856404',
    textAlign: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
    marginBottom: 4,
  },
  summary: {
    fontSize: 15,
    color: '#444',
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  label: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600',
  },
  value: {
    fontSize: 14,
    color: '#222',
    fontWeight: '500',
  },
  highConfidence: {
    color: '#2E7D32',
  },
  lowConfidence: {
    color: '#C62828',
  },
  divider: {
    height: 1,
    backgroundColor: '#E0E0E0',
    marginVertical: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    marginBottom: 4,
  },
  recommendation: {
    fontSize: 14,
    color: '#444',
    lineHeight: 20,
  },
  warningBox: {
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  warningText: {
    fontSize: 13,
    color: '#B71C1C',
    textAlign: 'center',
  },
  disabledPlaceholder: {
    fontSize: 13,
    color: '#AAA',
    textAlign: 'center',
    fontStyle: 'italic',
    paddingVertical: 8,
  },
});
