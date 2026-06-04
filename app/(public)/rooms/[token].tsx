import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Linking,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  COLORS,
  LAYOUT,
  RADIUS,
  SHADOWS,
  SPACING,
  TYPOGRAPHY,
} from '../../../constants/theme';

// ─── Feature flag ────────────────────────────────────────────────────────────
// Set to false to disable without removing the route. Shows a browser fallback.
const ENABLE_IN_APP_SHARED_ROOMS = true;

// ─── API ─────────────────────────────────────────────────────────────────────
const API_BASE = 'https://www.kscan.app/api/rooms';
const FETCH_TIMEOUT_MS = 10_000;
const BG_REFETCH_THRESHOLD_MS = 5 * 60 * 1000;

type ApiItem = {
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
  | { phase: 'empty' }
  | { phase: 'unavailable' }
  | { phase: 'malformed' }
  | { phase: 'rate_limited' }
  | { phase: 'network_error' }
  | { phase: 'timeout' };

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
      return { phase: 'empty', preview } as unknown as FetchState;
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

// ─── Components ───────────────────────────────────────────────────────────────
function RoomHeader({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backButton} onPress={onBack} hitSlop={12}>
        <Text style={styles.backChevron}>‹</Text>
      </TouchableOpacity>
      <View style={styles.headerCenter}>
        <Text style={styles.brand}>K-SCAN</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Shared Room</Text>
        </View>
      </View>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function MetaRow({ itemCount, sharedAt }: { itemCount: number; sharedAt: string | null }) {
  const date = formatSharedDate(sharedAt);
  return (
    <View style={styles.metaRow}>
      <View style={styles.metaChip}>
        <Text style={styles.metaChipText}>
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </Text>
      </View>
      {date ? (
        <View style={styles.metaChip}>
          <Text style={styles.metaChipText}>{date}</Text>
        </View>
      ) : null}
    </View>
  );
}

function CoverCard({ uri }: { uri: string }) {
  const [errored, setErrored] = useState(false);
  return (
    <View style={styles.coverCard}>
      {!errored ? (
        <Image
          source={{ uri }}
          style={styles.coverImage}
          resizeMode="cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <View style={[styles.coverImage, styles.imageFallback]}>
          <Text style={styles.imageFallbackText}>Preview unavailable</Text>
        </View>
      )}
    </View>
  );
}

function ItemCard({ item, index }: { item: ApiItem; index: number }) {
  const [errored, setErrored] = useState(false);
  const label = item.title || item.category || `Item ${index + 1}`;
  const chips = [item.category, item.color, item.silhouette].filter(Boolean) as string[];

  return (
    <View style={styles.itemCard}>
      <View style={styles.itemImageWrap}>
        {item.imageUrl && !errored ? (
          <Image
            source={{ uri: item.imageUrl }}
            style={styles.itemImage}
            resizeMode="cover"
            onError={() => setErrored(true)}
          />
        ) : (
          <View style={[styles.itemImage, styles.imageFallback]}>
            <Text style={styles.imageFallbackText}>Preview{'\n'}unavailable</Text>
          </View>
        )}
      </View>
      <View style={styles.itemBody}>
        <Text style={styles.itemLabel} numberOfLines={2}>{label}</Text>
        {chips.length > 0 ? (
          <View style={styles.chipRow}>
            {chips.map((chip) => (
              <View key={chip} style={styles.chip}>
                <Text style={styles.chipText}>{chip}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function RetryButton({ onPress, label = 'Try Again' }: { onPress: () => void; label?: string }) {
  return (
    <TouchableOpacity style={styles.retryButton} onPress={onPress} activeOpacity={0.8}>
      <Text style={styles.retryButtonText}>{label.toUpperCase()}</Text>
    </TouchableOpacity>
  );
}

function CenteredMessage({
  eyebrow,
  title,
  body,
  children,
}: {
  eyebrow: string;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.centeredMessage}>
      <Text style={styles.centeredEyebrow}>{eyebrow.toUpperCase()}</Text>
      <Text style={styles.centeredTitle}>{title}</Text>
      <Text style={styles.centeredBody}>{body}</Text>
      {children}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function SharedRoomScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [state, setState] = useState<FetchState>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const analyticsGuard = useRef(false);
  const lastFetchedAt = useRef<number | null>(null);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, []);

  const load = useCallback(
    async (silent = false) => {
      const rawToken = typeof token === 'string' ? token.trim() : '';

      if (!rawToken) {
        setState({ phase: 'malformed' });
        return;
      }

      if (!silent) setState({ phase: 'loading' });

      const result = await fetchRoomPreview(rawToken);
      lastFetchedAt.current = Date.now();
      setState(result);
    },
    [token]
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

  // ── Feature flag fallback ──────────────────────────────────────────────────
  if (!ENABLE_IN_APP_SHARED_ROOMS) {
    const rawToken = typeof token === 'string' ? token.trim() : '';
    const browserUrl = rawToken
      ? `https://www.kscan.app/rooms/${encodeURIComponent(rawToken)}`
      : 'https://www.kscan.app';

    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
        <SafeAreaView style={styles.safeTop} />
        <RoomHeader onBack={handleBack} />
        <View style={styles.centeredFill}>
          <CenteredMessage
            eyebrow="Shared Room"
            title="Shared rooms are coming soon."
            body="This feature is being prepared for the next release."
          >
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => void Linking.openURL(browserUrl)}
              activeOpacity={0.8}
            >
              <Text style={styles.retryButtonText}>VIEW IN BROWSER</Text>
            </TouchableOpacity>
          </CenteredMessage>
        </View>
      </View>
    );
  }

  // ── States ────────────────────────────────────────────────────────────────
  const renderContent = () => {
    switch (state.phase) {
      case 'loading':
        return (
          <View style={styles.centeredFill}>
            <Text style={styles.loadingLabel}>Opening shared room…</Text>
          </View>
        );

      case 'malformed':
        return (
          <View style={styles.centeredFill}>
            <CenteredMessage
              eyebrow="Invalid Link"
              title="This room link appears invalid."
              body="Check the link and try again. Nothing private was accessed."
            />
          </View>
        );

      case 'unavailable':
        return (
          <View style={styles.centeredFill}>
            <CenteredMessage
              eyebrow="Shared Room"
              title="This shared room is no longer available."
              body="The link may have been disabled or expired."
            />
          </View>
        );

      case 'rate_limited':
        return (
          <View style={styles.centeredFill}>
            <CenteredMessage
              eyebrow="Shared Room"
              title="Too many requests."
              body="Please try again shortly."
            >
              <RetryButton onPress={() => void load()} />
            </CenteredMessage>
          </View>
        );

      case 'network_error':
        return (
          <View style={styles.centeredFill}>
            <CenteredMessage
              eyebrow="Connection Error"
              title="Unable to load shared room."
              body="Check your connection and try again."
            >
              <RetryButton onPress={() => void load()} />
            </CenteredMessage>
          </View>
        );

      case 'timeout':
        return (
          <View style={styles.centeredFill}>
            <CenteredMessage
              eyebrow="Request Timed Out"
              title="Unable to load shared room."
              body="Please try again."
            >
              <RetryButton onPress={() => void load()} />
            </CenteredMessage>
          </View>
        );

      case 'empty': {
        const emptyPreview = (state as unknown as { phase: 'empty'; preview: ApiPreview }).preview;
        return (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={COLORS.gold}
              />
            }
          >
            <Text style={styles.roomTitle}>
              {emptyPreview?.title ?? 'Shared Dressing Room'}
            </Text>
            <MetaRow itemCount={0} sharedAt={emptyPreview?.sharedAt ?? null} />
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>This shared room does not have any visible items.</Text>
            </View>
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
                tintColor={COLORS.gold}
              />
            }
          >
            <Text style={styles.roomTitle}>{preview.title}</Text>
            <MetaRow itemCount={preview.itemCount} sharedAt={preview.sharedAt} />

            {preview.coverImageUrl ? (
              <CoverCard uri={preview.coverImageUrl} />
            ) : null}

            {preview.items.length > 0 ? (
              <View style={styles.itemGrid}>
                {preview.items.map((item, index) => (
                  <Pressable
                    key={item.id ?? `item-${index}`}
                    style={styles.itemGridCell}
                    onPress={() => {}}
                  >
                    <ItemCard item={item} index={index} />
                  </Pressable>
                ))}
              </View>
            ) : null}

            {preview.isCapped ? (
              <Text style={styles.cappedNote}>
                Showing first {preview.maxItemsReturned} items.
              </Text>
            ) : null}
          </ScrollView>
        );
      }

      default:
        return null;
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeTop} />
      <RoomHeader onBack={handleBack} />
      {renderContent()}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.canvasWarm,
  },
  safeTop: {
    backgroundColor: COLORS.canvasWarm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: LAYOUT.screenPadding,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderHairline,
    backgroundColor: COLORS.canvasWarm,
  },
  backButton: {
    width: 42,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  backChevron: {
    fontSize: 30,
    color: COLORS.goldPressed,
    lineHeight: 34,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    gap: SPACING.xs,
  },
  headerSpacer: {
    width: 42,
  },
  brand: {
    ...TYPOGRAPHY.brand,
    fontSize: 15,
    color: COLORS.editorialTextPrimary,
  },
  badge: {
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.goldMuted,
    backgroundColor: COLORS.accentSoft,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xxs,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: COLORS.goldPressed,
  },
  scrollContent: {
    padding: LAYOUT.screenPadding,
    paddingBottom: 80,
  },
  roomTitle: {
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: COLORS.editorialTextPrimary,
    marginBottom: SPACING.md,
    lineHeight: 36,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginBottom: SPACING.xl,
  },
  metaChip: {
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  metaChipText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: COLORS.editorialTextSecondary,
  },
  coverCard: {
    borderRadius: RADIUS.lg,
    overflow: 'hidden',
    marginBottom: SPACING.xxl,
    ...SHADOWS.editorialRaised,
  },
  coverImage: {
    width: '100%',
    aspectRatio: 4 / 5,
    backgroundColor: COLORS.surfaceMuted,
  },
  itemGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  itemGridCell: {
    width: '47%',
  },
  itemCard: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.white,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  itemImageWrap: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: COLORS.surfaceMuted,
  },
  itemImage: {
    width: '100%',
    height: '100%',
  },
  imageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageFallbackText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    textAlign: 'center',
    color: COLORS.editorialTextMuted,
  },
  itemBody: {
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  itemLabel: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.3,
    color: COLORS.editorialTextPrimary,
    lineHeight: 18,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  chip: {
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.8,
    color: COLORS.editorialTextSecondary,
  },
  cappedNote: {
    marginTop: SPACING.xl,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: COLORS.editorialTextMuted,
    textAlign: 'center',
  },
  emptyCard: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.white,
    padding: SPACING.xl,
    marginTop: SPACING.xl,
    alignItems: 'center',
    ...SHADOWS.editorialSmall,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: COLORS.editorialTextSecondary,
    textAlign: 'center',
    lineHeight: 24,
  },
  centeredFill: {
    flex: 1,
    justifyContent: 'center',
    padding: LAYOUT.screenPadding,
  },
  centeredMessage: {
    gap: SPACING.md,
    alignItems: 'center',
  },
  centeredEyebrow: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    color: COLORS.goldPressed,
    textAlign: 'center',
  },
  centeredTitle: {
    fontSize: 22,
    fontWeight: '600',
    letterSpacing: 0.2,
    color: COLORS.editorialTextPrimary,
    textAlign: 'center',
    lineHeight: 30,
  },
  centeredBody: {
    fontSize: 14,
    fontWeight: '400',
    color: COLORS.editorialTextSecondary,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 300,
  },
  loadingLabel: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: COLORS.editorialTextMuted,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: SPACING.lg,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.goldMuted,
    backgroundColor: COLORS.accentSoft,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
  },
  retryButtonText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: COLORS.goldPressed,
  },
});
