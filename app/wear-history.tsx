// Wear History — Build 29 Closet V2 / S6.
//
// A chronological record of what the user actually wore, plus two lightweight
// wardrobe insights. Deliberately NOT an analytics dashboard: Closet is a
// consumer fashion product, so this reads as "what I wore" rather than as an
// event log. Internal vocabulary stays technical; nothing on screen does.
//
// Every value here comes from the canonical wear-event model through the
// governed read contract in services/wearHistory.ts. This screen performs no
// Supabase query of its own and never falls back to the legacy local counter.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { LUXURY, RADIUS, SPACING } from '../constants/theme';
import {
  KScanHeader,
  SectionHeader,
  SecondaryButton,
  EmptyStateCard,
  InlineNotice,
} from '../components/luxury';
import { goBackOrHome } from '../services/navigationExit';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  createActorRequest,
  getActorContext,
  isActorRequestCurrent,
} from '../services/actorContext';
import {
  getWearHistory,
  getWearStats,
  rankByWear,
  rankingIsMeaningful,
  type WearHistoryCursor,
  type WearHistoryEntry,
  type WearStats,
} from '../services/wearHistory';

function formatWornAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'Unknown date';
  return new Date(parsed).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * What to call a history entry.
 *
 * Uses the point-in-time snapshot captured when the wear was recorded, never
 * the source object's current contents. If the look has since been edited,
 * history stays history.
 */
function entryTitle(entry: WearHistoryEntry): string {
  if (entry.kind === 'saved_look') {
    return entry.savedLookLive ? 'Saved look' : 'A look you no longer have';
  }
  const first = entry.items[0];
  return first?.titleSnapshot ?? 'An item you wore';
}

function entryDetail(entry: WearHistoryEntry): string {
  const named = entry.items
    .map((item) => item.titleSnapshot)
    .filter((title): title is string => !!title);
  if (named.length > 0) return named.join(' · ');
  // The garments were recorded but carried no display title at the time. Say
  // how many rather than inventing names for them.
  const count = entry.items.length;
  if (count === 0) return 'No garments recorded';
  return count === 1 ? '1 item' : `${count} items`;
}

export default function WearHistoryScreen() {
  const router = useRouter();
  const { isAuthenticated, loading: actorLoading, user } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorEpoch = getActorContext().epoch;
  const actorStamp = actorId ? `user:${actorId}:epoch:${actorEpoch}` : null;
  const [stateActorStamp, setStateActorStamp] = useState<string | null>(null);
  const [entries, setEntries] = useState<WearHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<WearHistoryCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [stats, setStats] = useState<WearStats[]>([]);
  const [statsTruncated, setStatsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const loadFirstPage = useCallback(async () => {
    const sequence = ++requestSequenceRef.current;
    const actorRequest = createActorRequest();
    setStateActorStamp(actorStamp);
    setLoading(true);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    setError(null);
    setEntries([]);
    setCursor(null);
    setHasMore(false);
    setStats([]);
    setStatsTruncated(false);
    if (actorLoading || !actorId) {
      setLoading(false);
      return;
    }
    const [history, wardrobeStats] = await Promise.all([getWearHistory(), getWearStats()]);
    if (
      sequence !== requestSequenceRef.current ||
      !isActorRequestCurrent(actorRequest)
    ) return;
    if (history.ok !== true) {
      setError(history.error);
      setLoading(false);
      return;
    }
    setEntries(history.page.entries);
    setCursor(history.page.nextCursor);
    setHasMore(history.page.hasMore);
    if (wardrobeStats.ok === true) {
      setStats(wardrobeStats.stats);
      setStatsTruncated(wardrobeStats.truncated);
    }
    setLoading(false);
  }, [actorId, actorLoading, actorStamp]);

  useEffect(() => {
    void loadFirstPage();
    return () => {
      requestSequenceRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMoreRef.current || stateActorStamp !== actorStamp) return;
    loadingMoreRef.current = true;
    const sequence = requestSequenceRef.current;
    const actorRequest = createActorRequest();
    setLoadingMore(true);
    const next = await getWearHistory({ cursor });
    if (
      sequence !== requestSequenceRef.current ||
      !isActorRequestCurrent(actorRequest)
    ) return;
    if (next.ok === true) {
      // Append rather than replace. The keyset cursor guarantees no overlap,
      // so a de-duplication pass here would only mask a paging bug.
      setEntries((current) => [...current, ...next.page.entries]);
      setCursor(next.page.nextCursor);
      setHasMore(next.page.hasMore);
    } else {
      setError(next.error);
    }
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, [actorStamp, cursor, stateActorStamp]);

  // Actor-stamped rendering closes the frame between an auth transition and
  // the clearing effect. State from the prior actor may still exist in React,
  // but it is never eligible to render under a different actor/epoch.
  const stateIsCurrent = stateActorStamp === actorStamp;
  const visibleEntries = stateIsCurrent ? entries : [];
  const visibleStats = stateIsCurrent ? stats : [];
  const visibleError = stateIsCurrent ? error : null;
  const visibleLoading = stateIsCurrent ? loading : true;
  const visibleHasMore = stateIsCurrent ? hasMore : false;
  const visibleStatsTruncated = stateIsCurrent ? statsTruncated : false;

  const showRanking = rankingIsMeaningful(visibleStats);
  const mostWorn = showRanking ? rankByWear(visibleStats, 'most', 3) : [];
  const leastWorn = showRanking ? rankByWear(visibleStats, 'least', 3) : [];

  const labelFor = (stat: WearStats): string => {
    const entry = visibleEntries.find((e) =>
      e.items.some((item) => item.sourceItemId === stat.sourceItemId),
    );
    const named = entry?.items.find((item) => item.sourceItemId === stat.sourceItemId);
    return named?.titleSnapshot ?? 'An item in your Closet';
  };

  return (
    <View style={styles.screen}>
      <KScanHeader title="Wear History" onBack={() => goBackOrHome(router)} />
      <ScrollView contentContainerStyle={styles.content} testID="wear-history-scroll">
        {visibleLoading ? (
          <ActivityIndicator
            color={LUXURY.colors.plum}
            accessibilityLabel="Loading your wear history"
          />
        ) : visibleError ? (
          <View>
            <InlineNotice variant="error" title="Wear History" body={visibleError} />
            <View style={styles.retry}>
              <SecondaryButton
                title="Try again"
                onPress={() => void loadFirstPage()}
                accessibilityLabel="Try loading your wear history again"
                testID="wear-history-retry"
              />
            </View>
          </View>
        ) : visibleEntries.length === 0 ? (
          <EmptyStateCard
            title="No wears recorded yet"
            subtitle="Tap Wore this on a Closet item to start building your history."
          />
        ) : (
          <>
            {showRanking ? (
              <>
                <SectionHeader title="Most worn" />
                {mostWorn.map((stat) => (
                  <View
                    key={`most-${stat.sourceItemId}`}
                    style={styles.statRow}
                    testID="wear-most-worn-row"
                    accessibilityRole="text"
                    accessibilityLabel={`${labelFor(stat)}, worn ${stat.timesWorn} times`}
                  >
                    <Text style={styles.statTitle} numberOfLines={1}>
                      {labelFor(stat)}
                    </Text>
                    <Text style={styles.statValue}>
                      {stat.timesWorn === 1 ? 'Once' : `${stat.timesWorn} times`}
                    </Text>
                  </View>
                ))}

                <SectionHeader title="Worn least" />
                {leastWorn.map((stat) => (
                  <View
                    key={`least-${stat.sourceItemId}`}
                    style={styles.statRow}
                    testID="wear-least-worn-row"
                    accessibilityRole="text"
                    accessibilityLabel={`${labelFor(stat)}, worn ${stat.timesWorn} times`}
                  >
                    <Text style={styles.statTitle} numberOfLines={1}>
                      {labelFor(stat)}
                    </Text>
                    <Text style={styles.statValue}>
                      {stat.timesWorn === 1 ? 'Once' : `${stat.timesWorn} times`}
                    </Text>
                  </View>
                ))}

                {visibleStatsTruncated ? (
                  <Text style={styles.caveat} testID="wear-stats-truncated">
                    Based on your most recent wears.
                  </Text>
                ) : null}
              </>
            ) : (
              // Ranking three garments out of two recorded wears is noise wearing
              // the authority of a statistic. Say so instead.
              <Text style={styles.caveat} testID="wear-stats-insufficient">
                Record a few more wears to see your most and least worn pieces.
              </Text>
            )}

            <SectionHeader title="Recently worn" />
            {visibleEntries.map((entry) => (
              <View
                key={entry.id}
                style={styles.entry}
                testID="wear-history-entry"
                accessibilityRole="text"
                accessibilityLabel={`${formatWornAt(entry.wornAt)}. ${entryTitle(entry)}. ${entryDetail(entry)}`}
              >
                <Text style={styles.entryDate}>{formatWornAt(entry.wornAt)}</Text>
                <Text style={styles.entryTitle} numberOfLines={1}>
                  {entryTitle(entry)}
                </Text>
                <Text style={styles.entryDetail} numberOfLines={2}>
                  {entryDetail(entry)}
                </Text>
              </View>
            ))}

            {visibleHasMore ? (
              <View style={styles.more}>
                <SecondaryButton
                  title={loadingMore ? 'Loading…' : 'Show more'}
                  onPress={() => void loadMore()}
                  accessibilityLabel="Load older wear history"
                  testID="wear-history-load-more"
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: LUXURY.colors.ivory },
  content: { padding: SPACING.lg, paddingBottom: SPACING.xl },
  entry: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  entryDate: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1,
    color: LUXURY.colors.stone,
  },
  entryTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    marginTop: 2,
  },
  entryDetail: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    marginTop: 2,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
  },
  statTitle: { ...LUXURY.typography.body, color: LUXURY.colors.ink, flex: 1 },
  statValue: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    marginLeft: SPACING.sm,
  },
  caveat: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginTop: SPACING.sm,
  },
  more: { marginTop: SPACING.md },
  retry: { marginTop: SPACING.md },
});
