/**
 * TEMPORARY N1 runtime-evidence probe. Not a product screen.
 *
 * Reachable ONLY via the existing EXPO_PUBLIC_DEV_INITIAL_ROUTE dev harness
 * (constants/featureFlags.ts), which is __DEV__-gated and absent from every
 * EAS profile -- this route is inert in any build that matters. Exists to
 * capture native-runtime evidence (docs/vto-live-native-runtime-n1.md)
 * without touching the real auth-gated Scan Results -> ProductShelf ->
 * TryItOnEntry path. Kept across gates (N1-A, now N1-B) rather than
 * recreated per gate -- tracked in the N1 defect ledger, not left silent.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import { describeLiveVtoNativeCapability } from '../services/vto/liveVtoNativeModule';

const NativeN1BView = requireNativeViewManager<any>('KScanLiveVto');

export default function DevN1Diagnostic() {
  const [capabilityResult, setCapabilityResult] = useState<string>('running...');
  const [n1bResult, setN1bResult] = useState<string>('running...');
  const n1bRef = useRef<any>(null);

  useEffect(() => {
    try {
      const capability = describeLiveVtoNativeCapability();
      const line = JSON.stringify(capability);
      // eslint-disable-next-line no-console
      console.log('[N1-A-PROBE]', line);
      setCapabilityResult(line);
    } catch (error) {
      const line = `threw: ${String(error)}`;
      // eslint-disable-next-line no-console
      console.log('[N1-A-PROBE]', line);
      setCapabilityResult(line);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const result = await n1bRef.current?.getLastN1BResult?.();
        const line = JSON.stringify(result);
        // eslint-disable-next-line no-console
        console.log('[N1-B-PROBE]', line);
        setN1bResult(line);
      } catch (error) {
        const line = `threw: ${String(error)}`;
        // eslint-disable-next-line no-console
        console.log('[N1-B-PROBE]', line);
        setN1bResult(line);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>N1-A diagnostic</Text>
      <Text testID="n1-a-probe-result" style={styles.result}>{capabilityResult}</Text>
      <Text style={styles.label}>N1-B diagnostic</Text>
      <NativeN1BView ref={n1bRef} active style={styles.n1bView} />
      <Text testID="n1-b-probe-result" style={styles.result}>{n1bResult}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  label: { fontSize: 14, opacity: 0.6 },
  result: { fontSize: 12, textAlign: 'center' },
  n1bView: { width: 270, height: 360, backgroundColor: '#202024' },
});
