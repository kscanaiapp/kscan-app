/**
 * TEMPORARY N1-A runtime-evidence probe. Not a product screen.
 *
 * Reachable ONLY via the existing EXPO_PUBLIC_DEV_INITIAL_ROUTE dev harness
 * (constants/featureFlags.ts), which is __DEV__-gated and absent from every
 * EAS profile -- this route is inert in any build that matters. Exists to
 * prove "JS finds module, getCapability() reaches Kotlin" (N1-A gate,
 * docs/vto-live-native-runtime-n1.md) without touching the real auth-gated
 * Scan Results -> ProductShelf -> TryItOnEntry path. Remove once N1-A
 * runtime evidence is captured, or keep behind __DEV__ for reuse at later
 * gates -- tracked in the N1 defect ledger either way, not left silent.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { describeLiveVtoNativeCapability } from '../services/vto/liveVtoNativeModule';

export default function DevN1Diagnostic() {
  const [result, setResult] = useState<string>('running...');

  useEffect(() => {
    try {
      const capability = describeLiveVtoNativeCapability();
      const line = JSON.stringify(capability);
      // eslint-disable-next-line no-console
      console.log('[N1-A-PROBE]', line);
      setResult(line);
    } catch (error) {
      const line = `threw: ${String(error)}`;
      // eslint-disable-next-line no-console
      console.log('[N1-A-PROBE]', line);
      setResult(line);
    }
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>N1-A diagnostic</Text>
      <Text testID="n1-a-probe-result" style={styles.result}>{result}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  label: { fontSize: 14, opacity: 0.6 },
  result: { fontSize: 16, textAlign: 'center' },
});
