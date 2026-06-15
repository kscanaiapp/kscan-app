import { useEffect, useState, useCallback } from 'react';
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Platform,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import SafeUnavailableScreen from '../../components/SafeUnavailableScreen';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { buildStyleMemorySummary } from '../../services/style-chat/buildStyleMemorySummary';
import { invalidateMemoryCache } from '../../services/style-chat/styleMemoryCache';
import type { StyleMemorySummary } from '../../services/style-chat/styleMemoryTypes';

// Development-only memory debug screen. This route still exists in the Expo
// file router, so keep it out of broad public builds or add a stronger flag.
export default function StyleChatDebugMemoryScreen() {
  // StyleChat (and its debug surfaces) are not part of the iOS release.
  if (Platform.OS === 'ios') {
    return <SafeUnavailableScreen />;
  }
  if (!__DEV__) {
    return <DebugUnavailableScreen />;
  }

  return <DebugMemoryContent />;
}

function DebugMemoryContent() {
  const { user } = useAuthSession();
  const [summary, setSummary] = useState<StyleMemorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) {
      setSummary(null);
      setError('Sign in to use this internal debug route.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      invalidateMemoryCache(user.id);
      const result = await buildStyleMemorySummary();
      setSummary(result);
    } catch (err: unknown) {
      setError((err as Error)?.message || 'Unable to load memory summary.');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>{'< BACK'}</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>STYLE MEMORY DEBUG</Text>
          <Text style={styles.badge}>DEBUG ONLY - INTERNAL USE</Text>
        </View>
        <Pressable onPress={() => void load()} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>REFRESH</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.centred}>
            <ActivityIndicator size="small" color={COLORS.accent} />
            <Text style={styles.loadingText}>Building memory summary...</Text>
          </View>
        ) : error ? (
          <View style={styles.centred}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : summary ? (
          <MemorySummaryView summary={summary} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function DebugUnavailableScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.unavailableWrap}>
        <Text style={styles.unavailableTitle}>Not Available</Text>
        <Text style={styles.unavailableBody}>
          This internal debug route is disabled in non-development builds.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function MemorySummaryView({ summary }: { summary: StyleMemorySummary }) {
  return (
    <>
      <MetaSection summary={summary} />
      {summary.favoriteBrands.length > 0 && (
        <SignalSection title="FAVORITE BRANDS" items={summary.favoriteBrands} />
      )}
      {summary.favoriteCategories.length > 0 && (
        <SignalSection title="FAVORITE CATEGORIES" items={summary.favoriteCategories} />
      )}
      {summary.favoriteColors.length > 0 && (
        <SignalSection title="FAVORITE COLORS" items={summary.favoriteColors} />
      )}
      {summary.budgetRange && <BudgetSection budget={summary.budgetRange} />}
      <SignalsSection
        implemented={summary.implementedSignals}
        missing={summary.missingSignals}
      />
    </>
  );
}

function MetaSection({ summary }: { summary: StyleMemorySummary }) {
  const { sourceCounts, confidenceScore, generatedAt } = summary;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>META</Text>
      <Row label="Confidence score" value={`${(confidenceScore * 100).toFixed(0)}%`} />
      <Row label="Memory events" value={String(sourceCounts.memoryEvents)} />
      {sourceCounts.scans !== undefined && (
        <Row label="Scan items" value={String(sourceCounts.scans)} />
      )}
      {sourceCounts.savedItems !== undefined && (
        <Row label="Product items" value={String(sourceCounts.savedItems)} />
      )}
      {sourceCounts.dressingRoomSignals !== undefined && (
        <Row label="Reaction signals" value={String(sourceCounts.dressingRoomSignals)} />
      )}
      {sourceCounts.staleSourceRefs !== undefined && (
        <Row label="Stale source refs" value={String(sourceCounts.staleSourceRefs)} />
      )}
      <Row label="Generated at" value={new Date(generatedAt).toLocaleString()} />
    </View>
  );
}

function SignalSection({
  title,
  items,
}: {
  title: string;
  items: Array<{ value: string; count: number; confidence: number }>;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {items.map((item) => (
        <Row
          key={item.value}
          label={item.value}
          value={`x${item.count}  conf ${(item.confidence * 100).toFixed(0)}%`}
        />
      ))}
    </View>
  );
}

function BudgetSection({
  budget,
}: {
  budget: NonNullable<StyleMemorySummary['budgetRange']>;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>BUDGET RANGE</Text>
      {budget.min !== undefined && <Row label="Min" value={`$${budget.min}`} />}
      {budget.max !== undefined && <Row label="Max" value={`$${budget.max}`} />}
      {budget.average !== undefined && <Row label="Average" value={`$${budget.average}`} />}
      <Row label="Confidence" value={`${(budget.confidence * 100).toFixed(0)}%`} />
    </View>
  );
}

function SignalsSection({
  implemented,
  missing,
}: {
  implemented: string[];
  missing: string[];
}) {
  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>IMPLEMENTED SIGNALS</Text>
        {implemented.map((signal) => (
          <Text key={signal} style={styles.signalItem}>
            + {signal}
          </Text>
        ))}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>MISSING SIGNALS</Text>
        {missing.map((signal) => (
          <Text key={signal} style={styles.missingItem}>
            - {signal}
          </Text>
        ))}
      </View>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
  },
  backBtn: {
    minWidth: 60,
    minHeight: 44,
    justifyContent: 'center',
  },
  backText: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.accent,
    fontSize: 11,
  },
  title: {
    ...TYPOGRAPHY.sectionLabel,
    color: COLORS.accent,
    fontSize: 11,
  },
  badge: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
    fontSize: 10,
    marginTop: 4,
    letterSpacing: 1,
  },
  refreshBtn: {
    minWidth: 60,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  refreshText: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.textSecondary,
    fontSize: 11,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: SPACING.xxl,
  },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: SPACING.sm,
  },
  loadingText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
  errorText: {
    ...TYPOGRAPHY.body,
    color: COLORS.errorSoft,
    textAlign: 'center',
    paddingHorizontal: SPACING.xxl,
  },
  section: {
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  sectionTitle: {
    ...TYPOGRAPHY.sectionLabel,
    color: COLORS.accent,
    fontSize: 10,
    marginBottom: SPACING.sm,
    letterSpacing: 2,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 5,
    gap: SPACING.lg,
  },
  rowLabel: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    fontSize: 13,
    flex: 1,
  },
  rowValue: {
    ...TYPOGRAPHY.body,
    color: COLORS.textPrimary,
    fontSize: 13,
    textAlign: 'right',
  },
  signalItem: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    fontSize: 12,
    paddingVertical: 3,
  },
  missingItem: {
    ...TYPOGRAPHY.body,
    color: COLORS.textTertiary,
    fontSize: 12,
    paddingVertical: 3,
  },
  unavailableWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xxl,
  },
  unavailableTitle: {
    ...TYPOGRAPHY.sectionLabel,
    color: COLORS.accent,
    marginBottom: SPACING.md,
  },
  unavailableBody: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
});
