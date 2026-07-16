import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  StatusPill,
  InlineNotice,
  EmptyStateCard,
  PrimaryButton,
  SharedScanCard,
  SecondaryButton,
  TertiaryButton,
  PrivacyFooter,
} from '../../../components/luxury';
import { LUXURY, SPACING } from '../../../constants/theme';
import { AI_STYLIST_UI_ENABLED, ROOM_CHAT_ENABLED } from '../../../constants/featureFlags';
import { OutfitDecisionSection } from '../../../components/dressing-rooms/OutfitDecisionSection';
import { getPublicRoomDecisionPreview } from '../../../services/outfitDecisions';
import { useAuthSession } from '../../../contexts/AuthSessionContext';
import {
  getItemReactionCounts,
  getMyItemReaction,
  removeItemReaction,
  setItemReaction,
} from '../../../services/styleObjects';
import { joinSharedRoom, ROOM_JOIN_ERROR } from '../../../services/roomMessages';
import { ItemReactions, type ReactionCountsForItem } from '../../../components/dressing-rooms/ItemReactions';
import { RoomMessagesPanel } from '../../../components/rooms/RoomMessagesPanel';
import {
  type DressingRoomReactionType,
  isActiveDressingRoomReactionType,
  type ItemReactionCount,
} from '../../../types/styleObjects';
import {
  KSCAN_PUBLIC_BASE_URL,
  KSCAN_ROOM_API_BASE_URL,
  ROOM_OPEN_APP_TIMEOUT_MS,
  buildRoomAppUrl,
  buildRoomWebUrl,
  getRoomInstallUrl,
  isLikelyInAppBrowser,
  logRoomLinkEvent,
  normalizeRoomShareToken,
} from '../../../services/roomDeepLinks';
import { computeItemGridCellWidth } from '../../../services/sharedRoomLayout';
import { normalizeSharedRoomPreview } from '../../../services/sharedRoomPreview';
import { resolveSharedRoomImageUrls } from '../../../services/sharedRoomImageResolver';
import {
  captureSharedRoomMembershipAfterPreview,
  createMembershipCaptureAttemptTracker,
} from '../../../services/captureSharedRoomMembership';

const { width: SCREEN_W } = Dimensions.get('window');
const ITEM_GRID_GAP = SPACING.md;
const ITEM_GRID_H_PAD = SPACING.xl;
const ITEM_GRID_CELL_W = computeItemGridCellWidth(SCREEN_W, {
  horizontalPadding: ITEM_GRID_H_PAD,
  gap: ITEM_GRID_GAP,
});

// ─── Feature flag ────────────────────────────────────────────────────────────
// Set to false to disable without removing the route. Shows a browser fallback.
const ENABLE_IN_APP_SHARED_ROOMS = true;

// ─── API ─────────────────────────────────────────────────────────────────────
const API_BASE = KSCAN_ROOM_API_BASE_URL;
const FETCH_TIMEOUT_MS = 10_000;
const BG_REFETCH_THRESHOLD_MS = 5 * 60 * 1000;

type ApiItem = {
  // ApiItem.id === public.dressing_room_items.id
  id: string | null;
  // Public HTTPS URL only. When absent, the screen asks
  // shared-room-image-url (a service-role Edge Function, not this client)
  // to resolve the item's private storage reference into a short-lived
  // signed URL, keyed by item id in resolvedImageUrls below. This type
  // intentionally has no bucket/path fields: this client never receives,
  // stores, or reasons about private storage coordinates directly.
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
type SelectedReactionsByItem = Record<string, DressingRoomReactionType | null>;

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

    const json = (await response.json()) as { status?: string; preview?: unknown };

    if (json.status === 'malformed') return { phase: 'malformed' };
    if (json.status === 'rate_limited') return { phase: 'rate_limited' };
    if (json.status !== 'available') return { phase: 'unavailable' };

    const preview = normalizeSharedRoomPreview(json);
    if (!preview) return { phase: 'unavailable' };

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

type OpenAppStatus = 'idle' | 'attempting' | 'failed';

function getWebUserAgent() {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return '';
  return navigator.userAgent || '';
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

// Read-only sanitized decision preview for public (non-joined) visitors.
// Backed by get_public_room_decision_preview: aggregate counts only, no voter
// or owner identities, no vote controls of any kind.
function PublicDecisionPreview({ token }: { token: string }) {
  const [decisions, setDecisions] = useState<
    Awaited<ReturnType<typeof getPublicRoomDecisionPreview>>['decisions']
  >([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const preview = await getPublicRoomDecisionPreview(token);
        if (!cancelled && preview.status === 'available') {
          setDecisions(preview.decisions);
        }
      } catch {
        // Read-only enrichment: failures degrade silently to no section.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!loaded || decisions.length === 0) return null;

  return (
    <View style={styles.decisionPreviewSection} testID="public-decision-preview">
      <SectionHeader title="Help Me Choose" subtitle="Sign in and join to vote" />
      {decisions.map((decision) => (
        <View key={decision.groupId} style={styles.decisionPreviewCard}>
          <Text style={styles.decisionQuestion}>{decision.question}</Text>
          {decision.options.map((option, index) => {
            const chosen = decision.chosenOptionId === option.optionId;
            return (
              <View key={option.optionId} style={styles.decisionOptionRow}>
                <View style={styles.decisionOptionImages}>
                  {option.items
                    .filter((item) => !!item.imageUrl)
                    .slice(0, 3)
                    .map((item, itemIndex) => (
                      <Image
                        key={`${option.optionId}-${itemIndex}`}
                        source={{ uri: item.imageUrl as string }}
                        style={styles.decisionOptionImage}
                        resizeMode="cover"
                      />
                    ))}
                </View>
                <View style={styles.decisionOptionMeta}>
                  <Text style={styles.decisionOptionTitle} numberOfLines={1}>
                    LOOK {index + 1}
                    {option.title ? ` · ${option.title}` : ''}
                  </Text>
                  <Text style={styles.decisionOptionVotes}>
                    {option.voteCount} vote{option.voteCount === 1 ? '' : 's'}
                    {chosen ? (decision.wearingConfirmed ? ' · CHOSEN · Wearing this' : ' · CHOSEN') : ''}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ))}
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

function WebFallbackActions({
  token,
  openAppStatus,
  webSelected,
  likelyInAppBrowser,
  installUrl,
  onOpenInApp,
  onOpenWeb,
  onGetApp,
}: {
  token: string;
  openAppStatus: OpenAppStatus;
  webSelected: boolean;
  likelyInAppBrowser: boolean;
  installUrl: string | null;
  onOpenInApp: () => void;
  onOpenWeb: () => void;
  onGetApp: () => void;
}) {
  if (Platform.OS !== 'web' || !normalizeRoomShareToken(token)) return null;

  return (
    <View style={styles.fallbackCard}>
      <View style={styles.fallbackCopy}>
        <StatusPill label="App-first link" variant="gold" />
        <Text style={styles.fallbackTitle}>Open this Dressing Room in K Scan</Text>
        <Text style={styles.fallbackBody}>
          The native app is the primary room experience. This page is here when app links
          cannot hand off automatically.
        </Text>
      </View>

      <View style={styles.fallbackActions}>
        <PrimaryButton
          title={openAppStatus === 'attempting' ? 'Opening App' : 'Open in App'}
          onPress={onOpenInApp}
          loading={openAppStatus === 'attempting'}
          accessibilityLabel="Open this Dressing Room in the K Scan app"
          testID="room-open-in-app-button"
        />
        <SecondaryButton
          title="Open in Web"
          onPress={onOpenWeb}
          accessibilityLabel="Continue viewing this Dressing Room in the browser"
          testID="room-open-in-web-button"
        />
        {installUrl ? (
          <TertiaryButton
            title="Get the App"
            onPress={onGetApp}
            accessibilityLabel="Get the K Scan app"
            testID="room-get-app-button"
          />
        ) : null}
      </View>

      {likelyInAppBrowser ? (
        <InlineNotice
          variant="info"
          body="If this does not open the app, tap the menu and choose Open in Safari or Open in Chrome."
          style={styles.notice}
        />
      ) : null}

      {openAppStatus === 'failed' ? (
        <InlineNotice
          variant="warning"
          title="App did not open"
          body="You can keep viewing the safe web preview here, or install K Scan on a supported device."
          style={styles.notice}
        />
      ) : null}

      {webSelected ? (
        <InlineNotice
          variant="success"
          body="You are viewing the safe web preview."
          style={styles.notice}
        />
      ) : null}
    </View>
  );
}

// Authenticated participant chat entry. Renders nothing for anonymous viewers
// or when the chat flag is off, so the public read-only preview is unchanged.
// An authenticated user joins via the existing share token, then sees the same
// backend-backed RoomMessagesPanel used on the owner's room detail screen.
function SharedRoomChatSection({
  token,
  roomId,
  onJoined,
}: {
  token: string;
  roomId: string | null;
  onJoined: (roomId: string) => void;
}) {
  const { isAuthenticated } = useAuthSession();
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const joinInFlight = useRef(false);

  const handleJoin = useCallback(async () => {
    if (joinInFlight.current) return;
    joinInFlight.current = true;
    setJoining(true);
    setJoinError(null);
    try {
      const joinedRoomId = await joinSharedRoom(token);
      onJoined(joinedRoomId);
    } catch (err: any) {
      // err.message is a friendly string from services/roomMessages - never a
      // raw Supabase/RLS error and never a token.
      setJoinError(typeof err?.message === 'string' ? err.message : ROOM_JOIN_ERROR);
    } finally {
      joinInFlight.current = false;
      setJoining(false);
    }
  }, [onJoined, token]);

  if (!ROOM_CHAT_ENABLED || !isAuthenticated) {
    return null;
  }

  if (roomId) {
    return <RoomMessagesPanel roomId={roomId} />;
  }

  return (
    <View style={styles.chatJoinCard}>
      <SectionHeader title="Room Chat" subtitle="Shared conversation" />
      <Text style={styles.chatJoinBody}>
        Join this shared room to chat with the owner and other participants.
      </Text>
      {joinError ? <Text style={styles.chatJoinError}>{joinError}</Text> : null}
      <SecondaryButton
        title={joining ? 'Opening Chat' : 'Join the Conversation'}
        onPress={handleJoin}
        disabled={joining}
        loading={joining}
        accessibilityLabel="Join the shared room conversation"
        accessibilityHint="Opens in-room chat with the room owner and participants"
      />
    </View>
  );
}

export default function SharedRoomScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { isAuthenticated, loading: authLoading, user } = useAuthSession();
  const [state, setState] = useState<FetchState>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [reactionCounts, setReactionCounts] = useState<ReactionCountsByItem>({});
  const [selectedReactions, setSelectedReactions] = useState<SelectedReactionsByItem>({});
  const [mutatingReactionItemId, setMutatingReactionItemId] = useState<string | null>(null);
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const [openAppStatus, setOpenAppStatus] = useState<OpenAppStatus>('idle');
  const [webSelected, setWebSelected] = useState(false);
  const linkOpenedGuard = useRef<string | null>(null);
  const outcomeAnalyticsGuard = useRef<string | null>(null);
  const lastFetchedAt = useRef<number | null>(null);
  const imageResolutionGuard = useRef<string | null>(null);
  const membershipCaptureTracker = useRef(createMembershipCaptureAttemptTracker());
  const previewRequestId = useRef(0);
  const routeTokenRef = useRef<string | null>(null);

  const insets = useSafeAreaInsets();
  const [resolvedImageUrls, setResolvedImageUrls] = useState<Record<string, string | null>>({});

  // The PrivacyFooter below is a normal-flow sibling of the ScrollView (not
  // absolutely positioned, not sticky) inside a flex column, so once the
  // ScrollView itself has `flex: 1` (see styles.flex usage below) it is
  // already correctly bounded above the footer by layout, with no overlap.
  // A static bottom padding is enough; there is no need to measure the
  // footer's height and add it again, which would only create a dead blank
  // gap under the last card equal to the footer's own height.
  const scrollContentStyle = styles.scrollContent;

  // Note on insets.bottom: this screen renders <LuxuryScreen safeArea={false}
  // scrollable={false}>, so LuxuryScreen itself contributes 0 for both
  // insets.top and insets.bottom (see components/luxury/LuxuryScreen.tsx:
  // paddingBottom is `(safeArea ? insets.bottom : 0) + bottomPadding`). The
  // View wrapping PrivacyFooter below is therefore the ONLY place
  // insets.bottom is applied on this screen; it is not double-counted.

  const rawToken = typeof token === 'string' ? token.trim() : '';
  const normalizedRouteToken = normalizeRoomShareToken(rawToken);
  routeTokenRef.current = normalizedRouteToken;
  const membershipPreviewToken =
    state.phase === 'available' || state.phase === 'empty'
      ? state.preview.token
      : null;
  const webUserAgent = getWebUserAgent();
  const installUrl = getRoomInstallUrl(webUserAgent);
  const likelyInAppBrowser = isLikelyInAppBrowser(webUserAgent);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, []);

  const load = useCallback(
    async (silent = false) => {
      const requestedToken = normalizedRouteToken;
      const requestId = ++previewRequestId.current;

      if (!requestedToken) {
        setState({ phase: 'malformed' });
        return;
      }

      if (!silent) setState({ phase: 'loading' });

      const result = await fetchRoomPreview(requestedToken);
      if (
        requestId !== previewRequestId.current ||
        routeTokenRef.current !== requestedToken
      ) {
        return;
      }
      lastFetchedAt.current = Date.now();
      setState(result);
    },
    [normalizedRouteToken]
  );

  const handleOpenInApp = useCallback(() => {
    const shareToken = normalizedRouteToken;
    if (!shareToken) {
      setOpenAppStatus('failed');
      logRoomLinkEvent('room_token_invalid', { surface: 'web_fallback' });
      return;
    }

    const appUrl = buildRoomAppUrl(shareToken);
    setOpenAppStatus('attempting');
    logRoomLinkEvent('room_open_app_cta_clicked', { surface: 'web_fallback' });

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.location.href = appUrl;
      window.setTimeout(() => {
        setOpenAppStatus('failed');
        logRoomLinkEvent('room_open_app_cta_failed', { surface: 'web_fallback' });
      }, ROOM_OPEN_APP_TIMEOUT_MS);
      return;
    }

    void Linking.openURL(appUrl).catch(() => {
      setOpenAppStatus('failed');
      logRoomLinkEvent('room_open_app_cta_failed', { surface: Platform.OS });
    });
  }, [normalizedRouteToken]);

  useEffect(() => {
    const shareToken = normalizeRoomShareToken(rawToken);
    if (!shareToken || state.phase === 'loading') return;

    const key = `${shareToken}:${state.phase}:${Platform.OS}`;
    if (outcomeAnalyticsGuard.current === key) return;
    outcomeAnalyticsGuard.current = key;

    if (state.phase === 'available' || state.phase === 'empty') {
      logRoomLinkEvent(Platform.OS === 'web' ? 'room_link_opened_web' : 'room_link_opened_native', {
        surface: Platform.OS === 'web' ? 'web_fallback' : 'native',
      });
      return;
    }

    if (state.phase === 'malformed') {
      logRoomLinkEvent('room_token_invalid', { surface: Platform.OS });
      return;
    }

    if (state.phase === 'unavailable') {
      logRoomLinkEvent('room_token_revoked', { surface: Platform.OS, reason: 'unavailable' });
    }
  }, [rawToken, state.phase]);

  const handleOpenWeb = useCallback(() => {
    const shareToken = normalizedRouteToken;
    if (!shareToken) return;

    logRoomLinkEvent('room_link_opened_web', {
      surface: Platform.OS === 'web' ? 'web_fallback' : 'native',
    });
    if (Platform.OS === 'web') {
      setWebSelected(true);
      return;
    }

    void Linking.openURL(buildRoomWebUrl(shareToken));
  }, [normalizedRouteToken]);

  const handleGetApp = useCallback(() => {
    if (!installUrl) return;
    void Linking.openURL(installUrl);
  }, [installUrl]);

  // Initial load
  useEffect(() => {
    void load();
  }, [load]);

  // Invalidate pending preview work before unmount so an old request cannot
  // update this route or qualify a membership capture after navigation.
  useEffect(() => () => {
    previewRequestId.current += 1;
    routeTokenRef.current = null;
  }, []);

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

  // Deep-link analytics: safe event names only, no token or user data.
  useEffect(() => {
    const shareToken = normalizedRouteToken;
    if (!shareToken || linkOpenedGuard.current === shareToken) return;
    linkOpenedGuard.current = shareToken;
    logRoomLinkEvent('room_share_link_opened', {
      surface: Platform.OS === 'web' ? 'web_fallback' : 'native',
    });
  }, [normalizedRouteToken]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    setJoinedRoomId(null);
    setSelectedReactions({});
    setMutatingReactionItemId(null);
    setOpenAppStatus('idle');
    setWebSelected(false);
    setResolvedImageUrls({});
    imageResolutionGuard.current = null;
    membershipCaptureTracker.current.reset();
  }, [normalizedRouteToken]);

  useEffect(() => {
    membershipCaptureTracker.current.reset();
  }, [user?.id]);

  // Account-anchored Shared with Me capture: non-blocking side effect after a
  // valid public preview resolves for an authenticated native viewer.
  useEffect(() => {
    if (state.phase !== 'available' && state.phase !== 'empty') return;
    if (!normalizedRouteToken || !membershipPreviewToken) return;

    const sessionState = authLoading
      ? { phase: 'loading' as const }
      : isAuthenticated && user?.id
        ? { phase: 'authenticated' as const, actorId: user.id }
        : { phase: 'unauthenticated' as const };

    void captureSharedRoomMembershipAfterPreview({
      shareToken: normalizedRouteToken,
      previewShareToken: membershipPreviewToken,
      previewStatus: state.phase,
      sessionState,
      platform: Platform.OS,
      hasAttempted: (key) => membershipCaptureTracker.current.hasAttempted(key),
      markAttempted: (key) => membershipCaptureTracker.current.markAttempted(key),
    });
  }, [
    authLoading,
    isAuthenticated,
    membershipPreviewToken,
    normalizedRouteToken,
    state.phase,
    user?.id,
  ]);

  // Resolve signed image URLs for items that have no public HTTPS imageUrl.
  // The share token and item ids are the only inputs; the Edge Function looks
  // up each private storage path, validates access, and signs if valid.
  //
  // Read-side mirror of services/dressingRoomItemContract.ts's storage > remote
  // priority: addScanImageToDressingRoom / addProductToDressingRoom write
  // EITHER image_url (remote) OR storage_bucket+storage_path (storage) for a
  // given item, never both, so "no imageUrl -> resolve via storage" here is
  // equivalent to that contract's resolution order, not a competing one. The
  // Edge Function (supabase/functions/shared-room-image-url) cannot import
  // this RN module directly (separate Deno runtime/deployment), so its
  // validation.ts#resolveStorageRefFromRow re-implements just the storage-ref
  // half of the same contract; keep the two in sync if the write-side
  // priority or the mutual-exclusivity assumption ever changes.
  useEffect(() => {
    const shareToken = normalizeRoomShareToken(rawToken);
    if (!shareToken || state.phase !== 'available') return;

    const key = `${shareToken}:${state.preview.items.length}`;
    if (imageResolutionGuard.current === key) return;
    imageResolutionGuard.current = key;

    const itemIdsNeedingResolution = state.preview.items
      .filter((item) => item.id && !item.imageUrl)
      .map((item) => item.id!);
    if (itemIdsNeedingResolution.length === 0) return;

    let cancelled = false;

    const resolve = async () => {
      const next = await resolveSharedRoomImageUrls(shareToken, itemIdsNeedingResolution);
      if (!cancelled) {
        setResolvedImageUrls((current) => ({ ...current, ...next }));
      }
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [rawToken, state]);

  useEffect(() => {
    if (state.phase !== 'available') {
      if (state.phase !== 'empty') {
        setReactionCounts({});
        setSelectedReactions({});
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
      setSelectedReactions({});
      return;
    }

    let cancelled = false;

    const loadReactions = async () => {
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

      if (!isAuthenticated || !joinedRoomId) {
        if (!cancelled) {
          setSelectedReactions(
            Object.fromEntries(itemIds.map((itemId) => [itemId, null])) as SelectedReactionsByItem,
          );
        }
        return;
      }

      try {
        const mine = await getMyItemReaction(itemIds);
        if (!cancelled) {
          setSelectedReactions(mine);
        }
      } catch {
        if (!cancelled) {
          setSelectedReactions(
            Object.fromEntries(itemIds.map((itemId) => [itemId, null])) as SelectedReactionsByItem,
          );
        }
      }
    };

    void loadReactions();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, joinedRoomId, state]);

  const refreshItemReactions = useCallback(async (itemIds: string[]) => {
    const normalizedItemIds = Array.from(new Set(itemIds.map((itemId) => String(itemId || '').trim()).filter(Boolean)));
    if (normalizedItemIds.length === 0) return;

    try {
      const counts = await getItemReactionCounts(normalizedItemIds);
      setReactionCounts((current) => ({
        ...current,
        ...buildReactionCountsByItem(normalizedItemIds, counts),
      }));
    } catch {
      setReactionCounts((current) => ({
        ...current,
        ...buildReactionCountsByItem(normalizedItemIds, []),
      }));
    }

    if (!isAuthenticated || !joinedRoomId) {
      setSelectedReactions((current) => ({
        ...current,
        ...Object.fromEntries(normalizedItemIds.map((itemId) => [itemId, null])),
      }));
      return;
    }

    try {
      const mine = await getMyItemReaction(normalizedItemIds);
      setSelectedReactions((current) => ({ ...current, ...mine }));
    } catch {
      setSelectedReactions((current) => ({
        ...current,
        ...Object.fromEntries(normalizedItemIds.map((itemId) => [itemId, null])),
      }));
    }
  }, [isAuthenticated, joinedRoomId]);

  const handleReact = useCallback(async (itemId: string, reactionType: DressingRoomReactionType) => {
    if (!isAuthenticated || !joinedRoomId || mutatingReactionItemId === itemId) return;

    const currentReaction = selectedReactions[itemId] ?? null;
    setMutatingReactionItemId(itemId);
    try {
      if (currentReaction === reactionType) {
        await removeItemReaction(itemId);
      } else {
        await setItemReaction(itemId, reactionType);
      }
      await refreshItemReactions([itemId]);
    } catch {
      Alert.alert('Unable to save reaction.', 'Please try again.');
    } finally {
      setMutatingReactionItemId((current) => (current === itemId ? null : current));
    }
  }, [
    isAuthenticated,
    joinedRoomId,
    mutatingReactionItemId,
    refreshItemReactions,
    selectedReactions,
  ]);

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
              onPress: () => void Linking.openURL(buildRoomWebUrl(rawToken) || KSCAN_PUBLIC_BASE_URL),
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
    if (Platform.OS !== 'web' && authLoading) {
      return (
        <View style={styles.centeredFill}>
          <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          <Text style={styles.loadingLabel}>Opening native Dressing Room...</Text>
        </View>
      );
    }

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
            style={styles.flex}
            contentContainerStyle={scrollContentStyle}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={LUXURY.colors.gold}
              />
            }
          >
            <WebFallbackActions
              token={rawToken}
              openAppStatus={openAppStatus}
              webSelected={webSelected}
              likelyInAppBrowser={likelyInAppBrowser}
              installUrl={installUrl}
              onOpenInApp={handleOpenInApp}
              onOpenWeb={handleOpenWeb}
              onGetApp={handleGetApp}
            />
            <SharedRoomPreviewCard preview={emptyPreview} />
            <EmptyStateCard
              title="No visible items"
              subtitle="This shared room does not have any visible items right now."
            />
            <SharedRoomChatSection token={rawToken} roomId={joinedRoomId} onJoined={setJoinedRoomId} />
          </ScrollView>
        );
      }

      case 'available': {
        const { preview } = state;
        return (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={scrollContentStyle}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={LUXURY.colors.gold}
              />
            }
          >
            <WebFallbackActions
              token={rawToken}
              openAppStatus={openAppStatus}
              webSelected={webSelected}
              likelyInAppBrowser={likelyInAppBrowser}
              installUrl={installUrl}
              onOpenInApp={handleOpenInApp}
              onOpenWeb={handleOpenWeb}
              onGetApp={handleGetApp}
            />
            <SharedRoomPreviewCard preview={preview} />

            {/* Outfit decisions: interactive voting for joined participants,
                sanitized read-only preview for public visitors. */}
            {AI_STYLIST_UI_ENABLED ? (
              isAuthenticated && joinedRoomId ? (
                <OutfitDecisionSection roomId={joinedRoomId} role="participant" />
              ) : (
                <PublicDecisionPreview token={rawToken} />
              )
            ) : null}

            {preview.items.length > 0 ? (
              <>
                <SectionHeader title="Items" />
                <View style={styles.itemGrid}>
                  {preview.items.map((item, index) => {
                    const label = item.title || item.category || `Item ${index + 1}`;
                    const chips = [item.category, item.color, item.silhouette].filter(Boolean) as string[];
                    const canReact = Boolean(isAuthenticated && joinedRoomId && item.id);
                    return (
                      <SharedScanCard
                        key={item.id ?? `item-${index}`}
                        imageUrl={item.imageUrl ?? resolvedImageUrls[item.id ?? ''] ?? null}
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
                              selectedReaction={selectedReactions[item.id] ?? null}
                              disabled={!canReact || mutatingReactionItemId === item.id}
                              isMutating={mutatingReactionItemId === item.id}
                              onReact={canReact ? handleReact : undefined}
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

            <SharedRoomChatSection token={rawToken} roomId={joinedRoomId} onJoined={setJoinedRoomId} />

            <SecondaryButton
              title="View in Browser"
              onPress={() => void Linking.openURL(buildRoomWebUrl(preview.token))}
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
      <KScanHeader
        title={Platform.OS === 'web' ? 'Shared Room' : 'Dressing Room'}
        subtitle={Platform.OS === 'web' ? 'WEB FALLBACK' : 'SHARED ROOM'}
        onBack={handleBack}
        backLabel="Back"
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {renderContent()}
      </KeyboardAvoidingView>
      <View style={{ paddingBottom: insets.bottom }}>
        <PrivacyFooter
          onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
          onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
        />
      </View>
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centeredFill: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  fallbackCard: {
    borderRadius: LUXURY.cards.product.borderRadius,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.md,
    ...LUXURY.cards.product.shadow,
  },
  fallbackCopy: {
    gap: SPACING.sm,
  },
  fallbackTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 21,
    color: LUXURY.colors.ink,
  },
  fallbackBody: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 21,
    color: LUXURY.colors.graphite,
  },
  fallbackActions: {
    gap: SPACING.sm,
    alignItems: 'center',
  },
  chatJoinCard: {
    borderRadius: LUXURY.cards.product.borderRadius,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...LUXURY.cards.product.shadow,
  },
  chatJoinBody: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  chatJoinError: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
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
  decisionPreviewSection: {
    gap: SPACING.md,
  },
  decisionPreviewCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  decisionQuestion: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  decisionOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  decisionOptionImages: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  decisionOptionImage: {
    width: 44,
    height: 56,
    borderRadius: 8,
    backgroundColor: LUXURY.colors.ivory,
  },
  decisionOptionMeta: {
    flex: 1,
    gap: 2,
  },
  decisionOptionTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 1.6,
  },
  decisionOptionVotes: {
    ...LUXURY.typography.body,
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
