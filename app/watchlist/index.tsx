// K+ Smart Watchlist V1 — home (list).
//
// Minimal by design: no search, no filters, no swipe actions, no sort
// controls (master build brief §47). Watching ≠ owning, so this is
// deliberately not a third `library.tsx` section — it is its own route.
import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { goBackOrHome } from '../../services/navigationExit';
import { LuxuryScreen, KScanHeader, StatusPill, EmptyStateCard, InlineNotice } from '../../components/luxury';
import { KScanIcon } from '../../components/icons/kscan';
import { LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { useWatchlist } from '../../hooks/useWatchlist';
import { formatCommercePrice } from '../../services/dressingRoomCommerce';
import type { CommerceWatch } from '../../types/watchlist';

function relativeTime(iso: string | null): string {
  if (!iso) return 'Not checked yet';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'Just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusPillFor(watch: CommerceWatch): { label: string; variant: 'success' | 'warning' | 'neutral' } {
  if (watch.status === 'paused') return { label: 'Paused', variant: 'neutral' };
  if (watch.lastStatus === 'unavailable') return { label: 'No longer listed', variant: 'warning' };
  if (watch.targetReachedAt) return { label: 'Target reached', variant: 'success' };
  return { label: 'Watching', variant: 'neutral' };
}

function WatchRow({ watch }: { watch: CommerceWatch }) {
  const price = formatCommercePrice(watch.currentPriceAmount, watch.currency);
  const pill = statusPillFor(watch);
  return (
    <Pressable
      testID={`watchlist-row-${watch.id}`}
      style={styles.row}
      onPress={() => router.push({ pathname: '/watchlist/[watchId]', params: { watchId: watch.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${watch.displayTitle}, ${price ?? 'price unavailable'}`}
    >
      {watch.displayImageUrl ? (
        <Image source={{ uri: watch.displayImageUrl }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <KScanIcon name="watchlist" size={20} variant="compact" />
        </View>
      )}
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {watch.displayTitle}
        </Text>
        <Text style={styles.rowRetailer}>{watch.source.toUpperCase()}</Text>
        <View style={styles.rowMetaLine}>
          <Text style={styles.rowPrice}>{price ?? 'Price unavailable'}</Text>
          {watch.watchIntent === 'buy_under' && watch.targetPriceAmount != null ? (
            <Text style={styles.rowTarget}>
              {' '}
              · Buy under {formatCommercePrice(watch.targetPriceAmount, watch.currency)}
            </Text>
          ) : null}
        </View>
        <Text style={styles.rowChecked}>{relativeTime(watch.lastCheckedAt)}</Text>
      </View>
      <StatusPill label={pill.label} variant={pill.variant} style={styles.rowPill} />
    </Pressable>
  );
}

export default function WatchlistHomeScreen() {
  const { watches, loading, error, refreshing } = useWatchlist();

  return (
    <LuxuryScreen testID="watchlist-home-screen">
      <StatusBar style="dark" />
      <KScanHeader
        title="Watchlist"
        subtitle="LISTINGS YOU'RE TRACKING"
        onBack={() => goBackOrHome(router)}
        backLabel="Back"
      />

      {refreshing ? (
        <View style={styles.refreshingRow} accessibilityLabel="Refreshing prices">
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.refreshingText}>Checking for price changes…</Text>
        </View>
      ) : null}

      {error ? (
        <InlineNotice variant="error" body={error} style={styles.notice} />
      ) : null}

      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" color={LUXURY.colors.plum} />
        </View>
      ) : watches.length === 0 ? (
        <View style={styles.centerFill}>
          <EmptyStateCard
            title="Nothing on your Watchlist yet"
            subtitle="When you find something you're not ready to buy, tap Watch on it and we'll keep an eye on the price."
            icon={<KScanIcon name="watchlist" size={28} variant="standard" />}
            testID="watchlist-empty-state"
          />
        </View>
      ) : (
        <View style={styles.list} testID="watchlist-list">
          {watches.map((watch) => (
            <WatchRow key={watch.id} watch={watch} />
          ))}
        </View>
      )}
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  notice: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.md,
  },
  refreshingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  refreshingText: {
    ...TYPOGRAPHY.caption,
    color: LUXURY.colors.plumMuted,
  },
  list: {
    flex: 1,
    paddingHorizontal: SPACING.lg,
    gap: SPACING.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.sm,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.ivory,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color: LUXURY.colors.plum,
  },
  rowRetailer: {
    ...TYPOGRAPHY.caption,
    color: LUXURY.colors.plumMuted,
    letterSpacing: 0.5,
  },
  rowMetaLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  rowPrice: {
    ...TYPOGRAPHY.bodyStrong,
    color: LUXURY.colors.plum,
  },
  rowTarget: {
    ...TYPOGRAPHY.caption,
    color: LUXURY.colors.plumMuted,
  },
  rowChecked: {
    ...TYPOGRAPHY.caption,
    color: LUXURY.colors.plumMuted,
  },
  rowPill: {
    alignSelf: 'flex-start',
  },
});
