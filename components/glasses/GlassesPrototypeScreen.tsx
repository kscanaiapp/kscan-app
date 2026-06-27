/**
 * components/glasses/GlassesPrototypeScreen.tsx
 *
 * Standalone prototype screen component for the isolated Google Glasses / XR mock.
 *
 * IMPORTANT: This is a component only. It is NOT registered in Expo Router
 * and NOT wired into production navigation. Import it manually for internal demos.
 *
 * Rules:
 * - Uses the mock service only.
 * - No auth / session / Supabase dependency.
 * - No production scan, AI, StyleChat, collaboration, phone bridge, or android-xr imports.
 * - State transitions are user-triggered only (idle → analyzing → result).
 * - No automatic analysis on mount.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Button,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import {
  createMockGlassesSession,
  analyzeMockGlassesCapture,
  getMockGlassesResult,
  getMockLowConfidenceResult,
  getMockErrorOutcome,
} from '../../services/glasses/mockGlassesService';
import { GlassesResultPreview } from './GlassesResultPreview';
import {
  GlassesMockSession,
  GlassesMockResult,
  GlassesMockError,
} from '../../types/glasses';

type PrototypeState =
  | { phase: 'idle' }
  | { phase: 'analyzing' }
  | { phase: 'result'; result: GlassesMockResult }
  | { phase: 'error'; error: GlassesMockError };

export const GlassesPrototypeScreen: React.FC = () => {
  const [session] = useState<GlassesMockSession>(() =>
    createMockGlassesSession('mock-camera')
  );
  const [state, setState] = useState<PrototypeState>({ phase: 'idle' });
  const [captureCount, setCaptureCount] = useState(0);

  const runMockScan = useCallback(async () => {
    setState({ phase: 'analyzing' });
    const triggerId = `mock-${session.sessionId}-${captureCount}`;
    const outcome = await analyzeMockGlassesCapture(session, triggerId);

    if (outcome.success) {
      setState({ phase: 'result', result: outcome.result });
    } else {
      setState({ phase: 'error', error: outcome.error });
    }
    setCaptureCount((c) => c + 1);
  }, [session, captureCount]);

  const showLowConfidence = useCallback(() => {
    setState({ phase: 'result', result: getMockLowConfidenceResult() });
    setCaptureCount((c) => c + 1);
  }, []);

  const showForcedError = useCallback(() => {
    const outcome = getMockErrorOutcome();
    if (!outcome.success) {
      setState({ phase: 'error', error: outcome.error });
    }
    setCaptureCount((c) => c + 1);
  }, []);

  const reset = useCallback(() => {
    setState({ phase: 'idle' });
  }, []);

  const currentResult: GlassesMockResult | null =
    state.phase === 'result' ? state.result : null;

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Glasses XR Mock Prototype</Text>
        <Text style={styles.headerSubtitle}>
          Session: {session.sessionId.split('-').pop()}
        </Text>
        <Text style={styles.headerSubtitle}>Captures: {captureCount}</Text>
      </View>

      <View style={styles.controls}>
        <Button
          title="Run mock scan"
          onPress={runMockScan}
          disabled={state.phase === 'analyzing'}
        />
        <View style={styles.buttonGap} />
        <Button
          title="Show low confidence"
          onPress={showLowConfidence}
          disabled={state.phase === 'analyzing'}
        />
        <View style={styles.buttonGap} />
        <Button
          title="Show forced error"
          onPress={showForcedError}
          disabled={state.phase === 'analyzing'}
        />
        <View style={styles.buttonGap} />
        <Button title="Reset" onPress={reset} color="#888" />
      </View>

      {state.phase === 'analyzing' && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" />
          <Text style={styles.loadingText}>Analyzing mock capture…</Text>
        </View>
      )}

      {state.phase === 'error' && (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Mock Error</Text>
          <Text style={styles.errorCode}>Code: {state.error.code}</Text>
          <Text style={styles.errorMessage}>{state.error.message}</Text>
          <View style={styles.buttonGap} />
          <Button title="Dismiss" onPress={reset} />
        </View>
      )}

      <GlassesResultPreview result={currentResult} />

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          This screen is not registered in navigation. Import it manually for
          internal demos only.
        </Text>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    padding: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  controls: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  buttonGap: {
    height: 8,
  },
  loadingBox: {
    padding: 24,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
  },
  errorBox: {
    margin: 16,
    padding: 16,
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#B71C1C',
    marginBottom: 4,
  },
  errorCode: {
    fontSize: 13,
    color: '#C62828',
    fontWeight: '600',
  },
  errorMessage: {
    fontSize: 14,
    color: '#444',
    marginTop: 4,
  },
  footer: {
    padding: 16,
    paddingTop: 24,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: '#AAA',
    textAlign: 'center',
  },
});
