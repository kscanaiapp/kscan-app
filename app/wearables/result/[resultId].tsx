import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../../constants/theme';
import { getCachedMetaWearableResult } from '../../../services/metaWearableCompanion';

// The wearable backend deliberately exposes no "fetch a result by id" client
// operation — wearable_results has row-level security enabled with zero
// client policies (service-role/Edge-Function access only), and
// wearable-open-on-phone's response is a deep link, not the payload. In this
// self-contained candidate build the phone produces the result itself, so
// this screen reads it from the phone's own process-local cache
// (metaWearableCompanion's cacheMetaWearableResult / getCachedMetaWearableResult)
// rather than a backend call that does not exist. See
// services/metaWearableCompanion.ts for the full explanation; a genuine
// second-device deployment would need its own delivery mechanism here.
export default function MetaWearableResultScreen() {
  const params = useLocalSearchParams<{ resultId?: string }>();
  const resultId = typeof params.resultId === 'string' ? params.resultId : '';
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!resultId) { setFailed(true); return; }
    const cached = getCachedMetaWearableResult(resultId);
    if (cached) {
      setResult(cached);
    } else {
      setFailed(true);
    }
  }, [resultId]);

  const primary = result?.primaryMatch && typeof result.primaryMatch === 'object'
    ? result.primaryMatch as Record<string, unknown>
    : {};
  const alternatives = Array.isArray(result?.alternatives) ? result.alternatives : [];

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>‹ Back</Text></Pressable>
        <Text style={styles.eyebrow}>OPENED FROM META</Text>
        <Text style={styles.title}>{typeof result?.summary === 'string' ? result.summary : 'StyleMatch'}</Text>
        {!result && !failed ? <ActivityIndicator color={COLORS.electricCyan} /> : null}
        {failed ? <Text style={styles.error}>This result is unavailable, expired, or belongs to another account.</Text> : null}
        {result ? (
          <View style={styles.card}>
            <Text style={styles.label}>BEST MATCH</Text>
            <Text style={styles.product}>{typeof primary.title === 'string' ? primary.title : 'Fashion item'}</Text>
            <Text style={styles.detail}>{[primary.brand, primary.retailer, primary.resaleSource].filter((value) => typeof value === 'string').join(' · ')}</Text>
            {alternatives.length ? <Text style={styles.meta}>{alternatives.length} alternative match{alternatives.length === 1 ? '' : 'es'} available</Text> : null}
            <Text style={styles.meta}>Result ID {resultId}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.obsidian },
  content: { padding: SPACING.xl, gap: SPACING.lg },
  back: { color: COLORS.electricCyan, fontSize: 16 },
  eyebrow: { ...TYPOGRAPHY.caption, color: COLORS.electricCyan },
  title: { color: COLORS.white, fontSize: 30, fontWeight: '700' },
  card: { backgroundColor: COLORS.graphite, borderColor: COLORS.graphiteLine, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACING.xl, gap: SPACING.md },
  label: { ...TYPOGRAPHY.caption, color: COLORS.chromeMuted },
  product: { color: COLORS.white, fontSize: 22, fontWeight: '700' },
  detail: { color: COLORS.chrome, fontSize: 15 },
  meta: { color: COLORS.chromeMuted, fontSize: 11, lineHeight: 17 },
  error: { color: '#FF8C96', fontSize: 14, lineHeight: 21 },
});
