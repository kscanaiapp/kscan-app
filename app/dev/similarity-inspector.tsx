/**
 * Checkpoint 5A — the DEVELOPMENT-ONLY similar-item comparison inspector.
 *
 * WHY THIS IS A SEPARATE ROUTE AND NOT A PANEL ON THE RESULT SCREEN
 *
 * Everything it shows — internal classification, per-stage timings, candidate
 * counts, rejection reasons — is engineering diagnostics, not product copy. A
 * user seeing "confidence 0.82, evidence: shared_silhouette" would read a
 * machine's internal state as a claim about their wardrobe. So the diagnostics
 * live behind `QA_TOOLS_ENABLED` (`__DEV__` only, stripped from any release
 * bundle) on a route that production navigation never links to, and
 * `__tests__/scannerSimilarityContainment.test.js` asserts that no production
 * result path can render them.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 *
 * It performs no mutation, no scan, and no network call. It renders whatever
 * the last scan recorded and hands every action press to a local log line
 * rather than to a real handler — resolving a comparison is the user's
 * decision on the real surface, never a side effect of opening an inspector.
 */

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { QA_TOOLS_ENABLED } from '../../constants/build';
import { PotentialSimilarItemNotice } from '../../components/scan-results/PotentialSimilarItemNotice';
import {
  ALL_SIMILAR_ITEM_ACTIONS,
  ACTION_SCOPE,
  evaluateSimilarItemActions,
} from '../../services/similarItemActions';

/**
 * A fixed, obviously-synthetic comparison. Using a fabricated item rather than
 * reading real user data keeps the inspector safe to open on any device and
 * keeps it from becoming a second way to browse someone's Closet.
 */
const SAMPLE_ITEM = {
  existingItemId: 'sample-closet-item',
  source: 'closet' as const,
  label: 'Black Leather Jacket (sample)',
  imageUri: null,
  classification: 'potentialSimilarItem' as const,
  reasons: ['shared_category', 'shared_color'],
  internal: {
    score: 0.82,
    evidence: ['shared_category', 'shared_color', 'shared_material'],
    vetoes: [],
  },
};

const SAMPLE_STATE = {
  existingItemExists: true,
  existingItemSource: 'closet' as const,
  newItemSavedToCloset: false,
  newItemInRecentScans: true,
  hasCommerceCandidates: true,
  existingItemArchived: false,
};

export default function SimilarityInspectorScreen() {
  const [log, setLog] = useState<string[]>([]);

  // Hooks must run unconditionally, so the availability computation stays above
  // the development gate below.
  const availability = useMemo(() => {
    try {
      return evaluateSimilarItemActions(SAMPLE_STATE);
    } catch {
      return [];
    }
  }, []);

  if (!QA_TOOLS_ENABLED) {
    return (
      <SafeAreaView style={styles.blocked}>
        <Text style={styles.blockedText}>
          The similarity inspector is available in development builds only.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Similar-item inspector</Text>
        <Text style={styles.caption}>
          Development only. No mutation, no scan, no network call.
        </Text>

        <Text style={styles.heading}>Notice surface</Text>
        <PotentialSimilarItemNotice
          item={SAMPLE_ITEM as never}
          recordState={SAMPLE_STATE as never}
          onAction={(action: string) => {
            setLog((prev) => [`pressed: ${action} (inspector — no effect)`, ...prev].slice(0, 20));
          }}
          testID="dev-similarity-notice"
        />

        <Text style={styles.heading}>Action availability</Text>
        {ALL_SIMILAR_ITEM_ACTIONS.map((action: string) => {
          const entry = availability.find((a: { action: string }) => a.action === action);
          const scope = (ACTION_SCOPE as Record<string, {
            affectsNewScan: boolean;
            affectsExistingItem: boolean;
            destructive: boolean;
          }>)[action];
          return (
            <View key={action} style={styles.row}>
              <Text style={styles.rowLabel}>{action}</Text>
              <Text style={styles.rowValue}>
                {entry?.available ? 'available' : 'unavailable'}
                {scope?.destructive ? ' · destructive' : ''}
                {scope?.affectsExistingItem ? ' · touches existing' : ''}
              </Text>
            </View>
          );
        })}

        <Text style={styles.heading}>Press log</Text>
        {log.length === 0
          ? <Text style={styles.rowValue}>No presses yet.</Text>
          : log.map((line, index) => (
            <Text key={`${line}-${index}`} style={styles.rowValue}>{line}</Text>
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FBF8F3' },
  content: { padding: 20, gap: 8 },
  title: { fontSize: 22, fontWeight: '600', color: '#1A1A1A' },
  caption: { fontSize: 13, color: '#6B6B6B', marginBottom: 12 },
  heading: { fontSize: 16, fontWeight: '600', color: '#1A1A1A', marginTop: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { fontSize: 14, color: '#1A1A1A' },
  rowValue: { fontSize: 13, color: '#6B6B6B' },
  blocked: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  blockedText: { fontSize: 15, color: '#6B6B6B', textAlign: 'center' },
});
