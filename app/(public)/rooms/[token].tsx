import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  StatusPill,
  InlineNotice,
  EmptyStateCard,
  SharedScanCard,
  SecondaryButton,
  PrivacyFooter,
} from '../../../components/luxury';
import { LUXURY, SPACING } from '../../../constants/theme';
import { getItemReactionCounts } from '../../../services/styleObjects';
import { ItemReactions, type ReactionCountsForItem } from '../../../components/dressing-rooms/ItemReactions';
import {
  isActiveDressingRoomReactionType,
  type ItemReactionCount,
} from '../../../types/styleObjects';

const { width: SCREEN_W } = Dimensions.get('window');
const ITEM_GRID_GAP = SPACING.md;
const ITEM_GRID_H_PAD = SPACING.xl;
const ITEM_GRID_CELL_W = Math.floor((SCREEN_W - ITEM_GRID_H_PAD * 2 - ITEM_GRID_GAP) / 2);

// ─── Feature flag ────────────────────────────────────────────────────────────
// Set to false to disable without removing the route. Shows a browser fallback.
const ENABLE_IN_APP_SHARED_ROOMS = true;

// ─── API ─────────────────────────────────────────────────────────────────────
const API_BASE = 'https://www.kscan.app/api/rooms';
const FETCH_TIMEOUT_MS = 10_000;
const BG_REFETCH_THRESHOLD_MS = 5 * 60 * 1000;

type ApiItem = {
  // ApiItem.id === public.dressing_room_items.id
  id: string | null;
  imageUrl: string | null;
  category: string | null;
  color: string | null;
  silhouette: string | null;
  title: string | null;
};

type ApiPreview = {
  token: string;
  title: string;
  note: string | null;
  itemCount: number;
  sharedAt: string | null;
  coverImageUrl: string | null;
  allowImport: false;
  maxItemsReturned: number;
  isCapped: boolean;
  nextCursor: null;
  items: ApiItem[];
};

type FetchState =
  | { phase: 'loading' }
  | { phase: 'available'; preview: ApiPreview }
  | { phase: 'empty'; preview: ApiPreview }
  | { phase: 'unavailable' }
  | { phase: 'malformed' }
  | { phase: 'rate_limited' }
  | { phase: 'network_error' }
  | { phase: 'timeout' };

const EMPTY_REACTION_COUNTS: ReactionCountsForItem = {
  love: 0,
  like: 0,
  looking: 0,
  thumbs_down: 0,
};

type ReactionCountsByItem = Record<string, ReactionCountsForItem>;

function createEmptyReactionCounts() {
  return { ...EMPTY_REACTION_COUNTS };
}

function buildReactionCountsByItem(itemIds: string[], rows: ItemReactionCount[]): ReactionCountsByItem {
  const base = Object.fromEntries(itemIds.map((itemId) => [itemId, createEmptyReactionCounts()])) as ReactionCountsByItem;
  rows.forEach((row) => {
    const itemId = String(row.item_id || '').trim();
    if (!itemId || !base[itemId]) return;
    if (!isActiveDressingRoomReactionType(row.reaction_type)) return;
    base[itemId][row.reaction_type] = Number.isFinite(row.count) ? row.count : 0;
  });
  return base;
}

async function fetchRoomPreview(token: string): Promise<FetchState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(token)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timer);

    if (response.status === 429) return { phase: 'rate_limited' };
    if (response.status === 400) return { phase: 'malformed' };
    if (response.status === 404) return { phase: 'unavailable' };
    if (!response.ok) return { phase: 'unavailable' };

    const json: { status: string; preview?: ApiPreview } = await response.json();

    if (json.status === 'malformed') return { phase: 'malformed' };
    if (json.status === 'rate_limited') return { phase: 'rate_limited' };
    if (json.status !== 'available' || !json.preview) return { phase: 'unavailable' };

    const preview = json.preview;
    if (preview.itemCount === 0 && preview.items.length === 0) {
      return { phase: 'empty', preview };
    }

    return { phase: 'available', preview };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') return { phase: 'timeout' };
    return { phase: 'network_error' };
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function formatSharedDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

function browserUrlForToken(token: string): string {
  return `https://www.kscan.app/rooms/${encodeURIComponent(token)}`;
}

// ─── Components ───────────────────────────────────────────────────────────────
interface SharedRoomPreviewCardProps {
  preview: ApiPreview;
}

function SharedRoomPreviewCard({ preview }: SharedRoomPreviewCardProps) {
  const [coverError, setCoverError] = useState(false);
  const date = formatSharedDate(preview.sharedAt);
  const hasCover = Boolean(preview.coverImageUrl) && !coverError;

  return (
    <View style={styles.previewCard}>
      <View style={styles.previewHeader}>
        <StatusPill label="Shared" variant="gold" />
        <View style={styles.metaPills}>
          <StatusPill
            label={`${preview.itemCount} ${preview.itemCount === 1 ? 'item' : 'items'}`}
            variant="neutral"
          />
          {date ? <StatusPill label={date} variant="neutral" /> : null}
        </View>
      </View>

      <Text style={styles.previewTitle}>{preview.title || 'Shared Dressing Room'}</Text>

      {preview.note ? <Text style={styles.previewNote}>{preview.note}</Text> : null}

      {hasCover ? (
        <View style={styles.coverWrap}>
          <Image
            source={{ uri: preview.coverImageUrl! }}
            style={styles.coverImage}
            resizeMode="cover"
            onError={() => setCoverError(true)}
            accessibilityLabel="Room cover image"
          />
        </View>
      ) : null}

      <Text style={styles.previewBody}>
        This is a preview of a private K Scan Dressing Room. Access is controlled by the share
        token. Only items the owner chose to share are visible here.
      </Text>
    </View>
  );
}

function ErrorState({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  return (
    <InlineNotice
      variant="error"
      title={title}
      body={body}
      action={{ label: 'Try Again', onPress: onRetry, accessibilityLabel: 'Retry loading shared room' }}
      style={styles.notice}
    />
  );
}

export default function SharedRoomScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [state, setState] = useState<FetchState>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [reactionCounts, setReactionCounts] = useState<ReactionCountsByItem>({});
  const analyticsGuard = useRef(false);
  const lastFetchedAt = useRef<number | null>(null);

  const rawToken = typeof token === 'string' ? token.trim() : '';

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!rawToken) {
        setState({ phase: 'malformed' });
        return;
      }

      if (!silent) setState({ phase: 'loading' });

      const result = await fetchRoomPreview(rawToken);
      lastFetchedAt.current = Date.now();
      setState(result);
    },
    [rawToken]
  );

  // Initial load
  useEffect(() => {
    void load();
  }, [load]);

  // Refetch after returning from background (>5 min)
  useEffect(() => {
    const { AppState } = require('react-native');
    const sub = AppState.addEventListener('change', (nextState: string) => {
      if (nextState !== 'active') return;
      if (!lastFetchedAt.current) return;
      if (Date.now() - lastFetchedAt.current > BG_REFETCH_THRESHOLD_MS) {
        void load(true);
      }
    });
    return () => sub.remove();
  }, [load]);

  // Analytics guard — fire only once per successful load
  useEffect(() => {
    if (state.phase !== 'available' || analyticsGuard.current) return;
    analyticsGuard.current = true;
    // room_shared_view_opened — no token, no title, no item data
  }, [state.phase]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    if (state.phase !== 'available') {
      if (state.phase !== 'empty') {
        setReactionCounts({});
      }
      return;
    }

    const itemIds = [
      ...new Set(
        state.preview.items
          .map((item) => String(item.id || '').trim())
          .filter(Boolean)
      ),
    ];

    if (itemIds.length === 0) {
      setReactionCounts({});
      return;
    }

    let cancelled = false;

    const loadReactionCounts = async () => {
      try {
        const counts = await getItemReactionCounts(itemIds);
        if (!cancelled) {
          setReactionCounts(buildReactionCountsByItem(itemIds, counts));
        }
      } catch {
        if (!cancelled) {
          setReactionCounts(buildReactionCountsByItem(itemIds, []));
        }
      }
    };

    void loadReactionCounts();

    return () => {
      cancelled = true;
    };
  }, [state]);

  // ── Feature flag fallback ──────────────────────────────────────────────────
  if (!ENABLE_IN_APP_SHARED_ROOMS) {
    return (
      <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
        <StatusBar style="dark" />
        <KScanHeader title="Shared Room" subtitle="PREVIEW" onBack={handleBack} backLabel="Back" />
        <View style={styles.centeredFill}>
          <EmptyStateCard
            title="Shared rooms are coming soon."
            subtitle="This feature is being prepared for the next release."
            action={{
              label: 'View in Browser',
              onPress: () => void Linking.openURL(browserUrlForToken(rawToken) || 'https://www.kscan.app'),
              accessibilityLabel: 'View shared room in browser',
            }}
          />
        </View>
        <PrivacyFooter
          onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
          onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
        />
      </LuxuryScreen>
    );
  }

  // ── States ────────────────────────────────────────────────────────────────
  const renderContent = () => {
    switch (state.phase) {
      case 'loading':
        return (
          <View style={styles.centeredFill}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
            <Text style={styles.loadingLabel}>Opening shared room…</Text>
          </View>
        );

      case 'malformed':
        return (
          <View style={styles.centeredFill}>
            <ErrorState
              title="Invalid Link"
              body="This room link appears invalid. Check the link and try again. Nothing private was accessed."
              onRetry={() => void load()}
            />
          </View>
        );

      case 'unavailable':
        return (
          <View style={styles.centeredFill}>
            <ErrorState
              title="Room Unavailable"
              body="This shared room is no longer available. The link may have been disabled or expired."
              onRetry={() => void load()}
            />
          </View>
        );

      case 'rate_limited':
        return (
          <View style={styles.centeredFill}>
            <ErrorState
              title="Too Many Requests"
              body="Please try again shortly."
              onRetry={() => void load()}
            />
          </View>
        );

      case 'network_error':
        return (
          <View style={styles.centeredFill}>
            <ErrorState
              title="Connection Error"
              body="Unable to load shared room. Check your connection and try again."
              onRetry={() => void load()}
            />
          </View>
        );

      case 'timeout':
        return (
          <View style={styles.centeredFill}>
            <ErrorState
              title="Request Timed Out"
              body="Unable to load shared room. Please try again."
              onRetry={() => void load()}
            />
          </View>
        );

      case 'empty': {
        const { preview: emptyPreview } = state;
        return (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={LUXURY.colors.gold}
              />
            }
          >
            <SharedRoomPreviewCard preview={emptyPreview} />
            <EmptyStateCard
              title="No visible items"
              subtitle="This shared room does not have any visible items right now."
            />
          </ScrollView>
        );
      }

      case 'available': {
        const { preview } = state;
        return (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={LUXURY.colors.gold}
              />
            }
          >
            <SharedRoomPreviewCard preview={preview} />

            {preview.items.length > 0 ? (
              <>
                <SectionHeader title="Items" />
                <View style={styles.itemGrid}>
                  {preview.items.map((item, index) => {
                    const label = item.title || item.category || `Item ${index + 1}`;
                    const chips = [item.category, item.color, item.silhouette].filter(Boolean) as string[];
                    return (
                      <SharedScanCard
                        key={item.id ?? `item-${index}`}
                        imageUrl={item.imageUrl}
                        title={label}
                        subtitle="Shared item"
                        chips={chips}
                        status="Shared"
                        accessibilityLabel={`${label} shared item`}
                        style={{ width: ITEM_GRID_CELL_W }}
                        footer={
                          item.id ? (
                            <ItemReactions
                              itemId={item.id}
                              counts={reactionCounts[item.id] ?? createEmptyReactionCounts()}
                              selectedReaction={null}
                              disabled
                            />
                          ) : null
                        }
                      />
                    );
                  })}
                </View>
              </>
            ) : null}

            {preview.isCapped ? (
              <InlineNotice
                variant="info"
                body={`Showing first ${preview.maxItemsReturned} items.`}
                style={styles.notice}
              />
            ) : null}

            <SecondaryButton
              title="View in Browser"
              onPress={() => void Linking.openURL(browserUrlForToken(preview.token))}
              accessibilityLabel="View shared room in browser"
              style={styles.browserButton}
            />
          </ScrollView>
        );
      }

      default:
        return null;
    }
  };

  return (
    <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
      <StatusBar style="dark" />
      <KScanHeader title="Shared Room" subtitle="DRESSING ROOM PREVIEW" onBack={handleBack} backLabel="Back" />
      {renderContent()}
      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
      />
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  centeredFill: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  loadingLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  previewCard: {
    ...LUXURY.cards.hero,
    gap: SPACING.md,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  metaPills: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  previewTitle: {
    ...LUXURY.typography.displayHeadline,
    fontSize: 24,
    color: LUXURY.colors.ink,
  },
  previewNote: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 22,
    color: LUXURY.colors.graphite,
  },
  coverWrap: {
    borderRadius: LUXURY.cards.product.borderRadius,
    overflow: 'hidden',
    ...LUXURY.cards.product.shadow,
  },
  coverImage: {
    width: '100%',
    aspectRatio: 4 / 5,
    backgroundColor: LUXURY.colors.champagne,
  },
  previewBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  itemGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: ITEM_GRID_GAP,
  },
  notice: {
    marginBottom: 0,
  },
  browserButton: {
    alignSelf: 'center',
  },
});
