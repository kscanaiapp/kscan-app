// K+ Smart Watchlist V1 — Watch detail.
//
// Deliberately absent (§52): selected variant, selected size, stock status,
// "cheaper elsewhere", any score. "Last checked" is load-bearing and must
// never be hidden — refresh is daily-at-best and best-effort, so hiding
// staleness is the fastest way to lose the user's trust.
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { goBackOrHome } from '../../services/navigationExit';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  StatusPill,
  InlineNotice,
  SectionHeader,
} from '../../components/luxury';
import { KPlusGate } from '../../components/kplus/KPlusGate';
import { LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { formatCommercePrice, openPersistedCommerceUrl } from '../../services/dressingRoomCommerce';
import {
  fetchWatch,
  fetchWatchEvents,
  pauseWatch,
  resumeWatch,
  deleteWatch,
  refreshWatches,
} from '../../services/watchlist/watchlistClient';
import type { CommerceWatch, CommerceWatchEvent } from '../../types/watchlist';

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

const EVENT_LABEL: Record<CommerceWatchEvent['eventType'], string> = {
  price_decreased: 'Price dropped',
  price_increased: 'Price went up',
  target_price_reached: 'Reached your target price',
  listing_unavailable: 'No longer listed',
  listing_available_again: 'Listed again',
};

export default function WatchDetailScreen() {
  const { watchId } = useLocalSearchParams<{ watchId: string }>();
  const [watch, setWatch] = useState<CommerceWatch | null>(null);
  const [events, setEvents] = useState<CommerceWatchEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!watchId) return;
    setLoading(true);
    const [watchResult, eventsResult] = await Promise.all([
      fetchWatch(watchId),
      fetchWatchEvents(watchId),
    ]);
    if (watchResult.ok) setWatch(watchResult.data);
    else setError('Unable to load this Watch.');
    if (eventsResult.ok) setEvents(eventsResult.data);
    setLoading(false);
  }, [watchId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const handleRefresh = useCallback(async () => {
    if (!watchId) return;
    setBusy(true);
    await refreshWatches(watchId).catch(() => null);
    await load();
    setBusy(false);
  }, [watchId, load]);

  const handlePause = useCallback(async () => {
    if (!watchId) return;
    setBusy(true);
    const result = await pauseWatch(watchId);
    if (result.ok) setWatch(result.data);
    setBusy(false);
  }, [watchId]);

  const handleResume = useCallback(
    async (openUpgrade: () => void) => {
      if (!watchId) return;
      setBusy(true);
      const result = await resumeWatch(watchId);
      if (result.ok) {
        setWatch(result.data);
      } else if ('reason' in result && result.reason === 'kplus_required') {
        openUpgrade();
      }
      setBusy(false);
    },
    [watchId],
  );

  const handleDelete = useCallback(() => {
    if (!watchId) return;
    Alert.alert('Delete this Watch?', 'This only removes the Watch. Nothing in your Recent Scans is affected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          const result = await deleteWatch(watchId);
          setBusy(false);
          if (result.ok) router.back();
        },
      },
    ]);
  }, [watchId]);

  const handleOpenRetailer = useCallback(() => {
    if (!watch) return;
    void openPersistedCommerceUrl(watch.canonicalUrl, (safeUrl) => Linking.openURL(safeUrl));
  }, [watch]);

  if (loading || !watch) {
    return (
      <LuxuryScreen testID="watch-detail-screen">
        <StatusBar style="dark" />
        <KScanHeader title="Watch" onBack={() => goBackOrHome(router)} backLabel="Back" />
        <View style={styles.centerFill}>
          {error ? <InlineNotice variant="error" body={error} /> : <ActivityIndicator size="large" color={LUXURY.colors.plum} />}
        </View>
      </LuxuryScreen>
    );
  }

  const currentPrice = formatCommercePrice(watch.currentPriceAmount, watch.currency);
  const startedPrice = formatCommercePrice(watch.initialPriceAmount, watch.currency);
  // DEF-WL-05: keyed on lastStatus, never on lastCheckedAt. last_checked_at is
  // stamped by the background claim and by every refresh cycle INCLUDING the
  // ones that failed to resolve, so treating its presence as evidence the
  // listing is live asserted "Still listed" after a timeout, a 429 or a
  // provider outage. Only an observation that actually resolved may claim the
  // listing is still there; a failed one says so plainly instead.
  const statusLine =
    watch.lastStatus === 'unavailable'
      ? 'No longer listed'
      : watch.lastStatus === 'available'
        ? 'Still listed'
        : watch.lastStatus === 'error'
          ? "Couldn't check this listing"
          : 'Not checked yet';

  return (
    <LuxuryScreen testID="watch-detail-screen">
      <StatusBar style="dark" />
      <KScanHeader title="Watch" onBack={() => goBackOrHome(router)} backLabel="Back" />

      <View style={styles.hero}>
        {watch.displayImageUrl ? (
          <Image source={{ uri: watch.displayImageUrl }} style={styles.heroImage} resizeMode="cover" />
        ) : null}
        <Text style={styles.title} numberOfLines={3}>
          {watch.displayTitle}
        </Text>
        <Text style={styles.retailer}>{watch.source.toUpperCase()}</Text>

        <Text style={styles.currentPrice}>{currentPrice ?? 'Price unavailable'}</Text>
        {startedPrice ? <Text style={styles.startedPrice}>Started watching at {startedPrice}</Text> : null}

        <StatusPill
          label={watch.watchIntent === 'buy_under' ? `Buy under ${formatCommercePrice(watch.targetPriceAmount, watch.currency)}` : 'Just watching'}
          variant="neutral"
          style={styles.intentPill}
        />

        <Text style={styles.statusLine}>{statusLine}</Text>
        <Text style={styles.checked}>Last checked {relativeTime(watch.lastCheckedAt)}</Text>
      </View>

      <View style={styles.actionsRow}>
        <SecondaryButton title="REFRESH" onPress={handleRefresh} loading={busy} disabled={busy} testID="watch-detail-refresh" />
        {watch.status === 'paused' ? (
          <KPlusGate source="watchlist_resume">
            {({ openUpgrade }) => (
              <SecondaryButton
                title="RESUME"
                onPress={() => handleResume(openUpgrade)}
                loading={busy}
                disabled={busy}
                testID="watch-detail-resume"
              />
            )}
          </KPlusGate>
        ) : (
          <SecondaryButton title="PAUSE" onPress={handlePause} loading={busy} disabled={busy} testID="watch-detail-pause" />
        )}
        <SecondaryButton title="DELETE" onPress={handleDelete} disabled={busy} testID="watch-detail-delete" />
      </View>

      <PrimaryButton title="VIEW ON RETAILER" onPress={handleOpenRetailer} testID="watch-detail-open-retailer" />

      {events.length > 0 ? (
        <View style={styles.eventsSection}>
          <SectionHeader title="RECENT CHANGES" />
          {events.map((event) => (
            <View key={event.id} style={styles.eventRow}>
              <Text style={styles.eventLabel}>{EVENT_LABEL[event.eventType] ?? event.eventType}</Text>
              {event.priceAmount != null ? (
                <Text style={styles.eventPrice}>{formatCommercePrice(event.priceAmount, event.currency ?? watch.currency)}</Text>
              ) : null}
              <Text style={styles.eventTime}>{relativeTime(event.observedAt)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.lg },
  hero: { paddingHorizontal: SPACING.lg, alignItems: 'flex-start', gap: 4 },
  heroImage: { width: '100%', height: 220, borderRadius: RADIUS.lg, marginBottom: SPACING.sm, backgroundColor: LUXURY.colors.ivory },
  title: { ...TYPOGRAPHY.title, color: LUXURY.colors.plum },
  retailer: { ...TYPOGRAPHY.caption, color: LUXURY.colors.plumMuted, letterSpacing: 0.5 },
  currentPrice: { ...TYPOGRAPHY.headline, color: LUXURY.colors.plum, marginTop: SPACING.xs },
  startedPrice: { ...TYPOGRAPHY.caption, color: LUXURY.colors.plumMuted },
  intentPill: { marginTop: SPACING.sm },
  statusLine: { ...TYPOGRAPHY.bodyStrong, color: LUXURY.colors.plum, marginTop: SPACING.sm },
  checked: { ...TYPOGRAPHY.caption, color: LUXURY.colors.plumMuted },
  actionsRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    marginTop: SPACING.lg,
    marginBottom: SPACING.sm,
  },
  eventsSection: { paddingHorizontal: SPACING.lg, marginTop: SPACING.lg, gap: SPACING.xs },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    ...SHADOWS.editorialSmall,
  },
  eventLabel: { ...TYPOGRAPHY.bodyStrong, color: LUXURY.colors.plum, flex: 1 },
  eventPrice: { ...TYPOGRAPHY.bodyStrong, color: LUXURY.colors.plum },
  eventTime: { ...TYPOGRAPHY.caption, color: LUXURY.colors.plumMuted, marginLeft: SPACING.xs },
});
