import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../../constants/theme';
import { META_WEARABLE_CANDIDATE_ENABLED } from '../../../constants/featureFlags';
import { getCachedMetaWearableResult } from '../../../services/metaWearableCompanion';
import { describeCommerceGroup } from '../../../services/metaWearableDevice';

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
/**
 * Route gate. expo-router registers every file under app/ as a route, so this
 * screen was reachable by deep link in ANY build — the feature flag only hid
 * the entry point elsewhere. The gate lives in a wrapper with no hooks of its
 * own so the inner component's hooks stay unconditional.
 */
export default function MetaWearableResultRoute() {
  if (!META_WEARABLE_CANDIDATE_ENABLED) return <Redirect href="/" />;
  return <MetaWearableResultScreen />;
}

function MetaWearableResultScreen() {
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
            {/* `resaleSource` used to be read here. wearable-scan has never
                produced that field — it deliberately emits no resale
                provenance, because scan-identify carries none — so it was
                always undefined and always filtered away. `commerceGroup` is
                the field the backend actually stamps, and it is the one that
                tells the reader whether this is a listing they can buy or a
                visual-similarity suggestion. */}
            <Text style={styles.detail}>{[primary.brand, primary.retailer, describeCommerceGroup(primary.commerceGroup)].filter((value) => typeof value === 'string' && value.trim()).join(' · ')}</Text>
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
