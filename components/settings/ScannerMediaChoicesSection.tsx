import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import {
  readScannerMediaChoices,
  saveScannerMediaChoice,
  type ScannerMediaChoice,
  type ScannerMediaChoices,
} from '../../services/scannerMediaChoices';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

/**
 * A post-onboarding way to change the exact same device-local Scanner choices.
 * These switches do NOT grant or revoke Android/iOS permissions. The camera
 * still requests OS access only when opened; Photos uses the system picker.
 */
export function ScannerMediaChoicesSection() {
  const [choices, setChoices] = useState<ScannerMediaChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutationInFlight = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setChoices(await readScannerMediaChoices());
    } catch {
      setChoices(null);
      setError('Cannot read Scanner choices from this device.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const change = async (key: ScannerMediaChoice, enabled: boolean) => {
    if (!choices || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveScannerMediaChoice(key, enabled);
      setChoices(saved);
    } catch {
      setError('Could not save your Scanner choice. Please retry.');
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.card} testID="privacy-scanner-media-settings">
      <Text style={styles.title}>Scanner Camera & Photos</Text>
      <Text style={styles.description}>
        Choose whether K Scan Scanner can capture photos or open the photo picker.
        These choices are saved on this device. To revoke permission granted to
        Android or iOS, use your device Settings.
      </Text>
      {(['camera', 'photos'] as const).map((key) => (
        <View key={key} style={styles.row}>
          <Text style={styles.rowTitle}>{key === 'camera' ? 'Scanner Camera' : 'Scanner Photos'}</Text>
          <Switch
            testID={`privacy-scanner-${key}-toggle`}
            value={choices?.[key] ?? false}
            disabled={busy || !choices}
            onValueChange={(value) => void change(key, value)}
            accessibilityLabel={`Allow Scanner ${key}`}
            accessibilityState={{ checked: choices?.[key] ?? false, disabled: busy || !choices }}
            trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
            thumbColor={choices?.[key] ? LUXURY.colors.plum : '#f4f3f4'}
          />
        </View>
      ))}
      {error ? (
        <Pressable accessibilityRole="button" onPress={() => void load()} testID="privacy-scanner-media-retry">
          <Text style={styles.error}>{error} Tap to retry.</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: LUXURY.colors.cream,
    borderColor: LUXURY.colors.border,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  title: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.ink },
  description: { ...LUXURY.typography.body, color: LUXURY.colors.graphite, fontSize: 13 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowTitle: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.ink },
  error: { ...LUXURY.typography.body, color: LUXURY.colors.ink },
});
