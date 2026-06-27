// Not wired into navigation — isolated prototype only.
// Future route registration must wait until backend consolidation completes.

// TODO(Glasses-Backend-Integration): After backend consolidation completes,
// replace this mock with the canonical gateway-backed implementation.
// DO NOT import aiGateway or scan-identify directly from this prototype layer.
// Expected canonical endpoint: POST /api/glasses/analyze-debug
// Expected result shape: FashionAnalyzeResult (align with native Android repo)

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
} from 'react-native';

import type { GlassesCaptureState, GlassesMockResult } from '../../types/glasses';
import { analyze } from '../../services/glasses/mockGlassesService';
import { GlassesResultPreview } from './GlassesResultPreview';

export function GlassesPrototypeScreen() {
  const [state, setState] = useState<GlassesCaptureState>('idle');
  const [result, setResult] = useState<GlassesMockResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleTrigger = useCallback(async () => {
    setState('analyzing');
    setErrorMessage(null);
    setResult(null);

    try {
      const mockResult = await analyze({ mockTriggerId: 'jacket-black' });
      setResult(mockResult);
      setState('result');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unknown analysis error'
      );
      setState('error');
    }
  }, []);

  const handleReset = useCallback(() => {
    setState('idle');
    setResult(null);
    setErrorMessage(null);
  }, []);

  const handleTriggerError = useCallback(async () => {
    setState('analyzing');
    setErrorMessage(null);
    setResult(null);

    try {
      const { analyzeWithError } = await import(
        '../../services/glasses/mockGlassesService'
      );
      await analyzeWithError();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unknown analysis error'
      );
      setState('error');
    }
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>K Scan Glasses</Text>
        <Text style={styles.headerSubtitle}>
          Prototype — user: glasses-prototype-user
        </Text>
      </View>

      <View style={styles.stage}>
        {state === 'idle' && (
          <View style={styles.idleContainer}>
            <Text style={styles.idleLabel}>Ready</Text>
            <Pressable
              style={styles.actionButton}
              onPress={handleTrigger}
              accessibilityLabel="Trigger mock analysis"
            >
              <Text style={styles.actionButtonText}>
                Trigger Mock Analysis
              </Text>
            </Pressable>

            <Pressable
              style={[styles.actionButton, styles.errorButton]}
              onPress={handleTriggerError}
              accessibilityLabel="Trigger mock error"
            >
              <Text style={styles.actionButtonText}>
                Trigger Mock Error
              </Text>
            </Pressable>
          </View>
        )}

        {state === 'analyzing' && (
          <View style={styles.analyzingContainer}>
            <ActivityIndicator size="large" color="#00f0ff" />
            <Text style={styles.analyzingLabel}>Analyzing…</Text>
          </View>
        )}

        {state === 'result' && result && (
          <View style={styles.resultContainer}>
            <GlassesResultPreview result={result} />
            <Pressable
              style={styles.resetButton}
              onPress={handleReset}
              accessibilityLabel="Reset prototype"
            >
              <Text style={styles.resetButtonText}>Reset</Text>
            </Pressable>
          </View>
        )}

        {state === 'error' && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Analysis Failed</Text>
            <Text style={styles.errorBody}>
              {errorMessage ?? 'Something went wrong.'}
            </Text>
            <Pressable
              style={styles.resetButton}
              onPress={handleReset}
              accessibilityLabel="Reset prototype after error"
            >
              <Text style={styles.resetButtonText}>Reset</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222222',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#00f0ff',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#666666',
    marginTop: 2,
  },
  stage: {
    flex: 1,
  },
  idleContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  idleLabel: {
    fontSize: 16,
    color: '#888888',
    marginBottom: 8,
  },
  actionButton: {
    backgroundColor: '#00f0ff',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    minWidth: 220,
    alignItems: 'center',
  },
  errorButton: {
    backgroundColor: '#ff4444',
  },
  actionButtonText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '700',
  },
  analyzingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  analyzingLabel: {
    fontSize: 16,
    color: '#00f0ff',
    fontWeight: '600',
  },
  resultContainer: {
    flex: 1,
  },
  resetButton: {
    margin: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333333',
  },
  resetButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ff4444',
  },
  errorBody: {
    fontSize: 14,
    color: '#cccccc',
    textAlign: 'center',
    lineHeight: 20,
  },
});
