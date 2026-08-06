import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Dimensions,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Linking,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { goBackOrHome } from '../services/navigationExit';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

import { AnalysisCard } from '../components/AnalysisCard';
import type { Product } from '../components/ProductShelf';
import { AddScanToDressingRoomModal } from '../components/AddScanToDressingRoomModal';
import { AddInspirationToDressingRoomModal } from '../components/AddInspirationToDressingRoomModal';
import { InspirationUploadModal } from '../components/InspirationUploadModal';
import { useLibrary } from '../hooks/useLibrary';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  deleteInspirationItem,
  listInspirationItems,
} from '../services/styleObjects';
import {
  hasUsableDressingRoomImageSource,
  describeMissingImageReason,
} from '../services/dressingRoomItemContract';
import type { InspirationItem } from '../types/styleObjects';
import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  SavedLookCard,
  EmptyStateCard,
  InlineNotice,
  SecondaryButton,
  PrivacyFooter,
} from '../components/luxury';
import { LUXURY, SPACING } from '../constants/theme';
import { ELISE_IDENTITY } from '../constants/elise';
import { FREE_TIER_UTILITY_ENABLED } from '../constants/freeTierUtilityFlags';
import {
  AI_STYLIST_UI_ENABLED,
  STYLECHAT_ATTACHMENTS_ENABLED,
  CLOSET_SEPARATION_V1,
  CLOSET_DIRECT_INTAKE_ACTIVE,
  CLOSET_CANDIDATE_STAGING_ACTIVE,
  CLOSET_BATCH_REVIEW_V2_ACTIVE,
  MIRROR_SELFIE_V1_ACTIVE,
  PRIVATE_DRESSING_ROOM_V1,
} from '../constants/featureFlags';
import { FreeTierUtilitySection } from '../components/free-tier/FreeTierUtilitySection';
import { normalizeLocalSavedScan } from '../services/ownedClosetItems';
import { setAttachmentHandoff } from '../services/style-chat/styleChatAttachmentStore';
import { useCloset } from '../hooks/useCloset';
import { useClosetCandidates } from '../hooks/useClosetCandidates';
import { routeClosetIntake } from '../services/closetIntakeRouting';
import { createClosetBatchId } from '../services/closetCandidateSchema';
import { ClosetIntakeModal } from '../components/closet/ClosetIntakeModal';
import { MirrorSelfieExtractionModal } from '../components/closet/MirrorSelfieExtractionModal';
import { ClosetCandidateStatusPanel } from '../components/closet/ClosetCandidateStatusPanel';
import { isScanPromoted } from '../services/closetPromotion';

// ── Layout constants ──────────────────────────────────────────────────────────
const { width: SCREEN_W } = Dimensions.get('window');
const CARD_GAP = SPACING.md;
const H_PAD = SPACING.xl;
const CARD_W = Math.floor((SCREEN_W - H_PAD * 2 - CARD_GAP) / 2);
const CARD_MIN_H = CARD_W + 80;
const SINGLE_CARD_W = CARD_W * 2 + CARD_GAP;

// ── SavedScan interface ───────────────────────────────────────────────────────
interface ScanAttributes {
  category: string;
  silhouette: string;
  color_palette: string;
  material_estimate: string | null;
  style_tags: string[];
  confidence_score: number | null;
}

interface SavedScan {
  id: string;
  createdAt: string;
  imageUri?: string | null;
  thumbnailUri: string | null;
  // Phase 2 additive durable media reference (cloud-synced scans only). May
  // be present even when imageUri is null — see
  // services/dressingRoomItemContract.ts for source resolution order.
  storageBucket?: string | null;
  storagePath?: string | null;
  attributes: ScanAttributes;
  result: string;
  products: Product[];
  /** Persisted live commerce snapshot; never re-fetched on reopen. */
  purchaseOptions?: Product[];
  source: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Bounded, user-facing copy for a running or just-finished Mirror staging
 * operation (Build 2.5 Step 4).
 *
 * Deliberately ignorant of groups, batch IDs, error codes and provider names —
 * the user asked to add some garments, and this says how that is going in
 * exactly those terms. "Adding 9 garments" rather than "staging group 2 of 2":
 * the internal 8-item partition is Step 4's concern, not the user's.
 */
function mirrorStagingProgressLabel(integration: {
  totalCropCount: number;
  successCount: number;
  retryableCount: number;
  nonRetryableCount: number;
  done: boolean;
}): string {
  const { totalCropCount, successCount, retryableCount, nonRetryableCount, done } = integration;
  const noun = totalCropCount === 1 ? 'garment' : 'garments';
  if (!done) {
    return `Adding ${totalCropCount} ${noun} to your Closet review…`;
  }
  const unresolved = retryableCount + nonRetryableCount;
  if (unresolved === 0) {
    return successCount === 1
      ? '1 garment was added to your Closet review.'
      : `${successCount} garments were added to your Closet review.`;
  }
  if (successCount === 0) {
    return "We couldn't add those garments. Please try again.";
  }
  return `${successCount} of ${totalCropCount} garments were added to your review.`;
}

/**
 * The Closet card's secondary line, or nothing when it would only repeat the
 * title.
 *
 * A promoted item's title is built from its taxonomy — brand plus the most
 * specific descriptor — so an item with neither a brand nor a subtype gets its
 * bare category as a title. Rendering the category underneath it produced a
 * card reading "Tops" over "Tops".
 */
function closetCardSubtitle(title: string, category: string | null): string | undefined {
  const fallback = 'Owned item';
  if (!category) return fallback;
  return category.trim().toLowerCase() === String(title ?? '').trim().toLowerCase()
    ? undefined
    : category;
}

function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}`;
  } catch {
    return '';
  }
}

async function requestPhotoLibraryPermission(): Promise<boolean> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status === 'granted') return true;
  Alert.alert(
    'Photo Access Required',
    'Allow K Scan to access your photo library in Settings to upload inspiration.',
    [{ text: 'OK' }]
  );
  return false;
}

// ── Section identity ──────────────────────────────────────────────────────────
// Recent Scans is scan history and discovery; the Closet is owned inventory.
// Neither surface may borrow the other's language: a scanned item is not owned,
// and an owned garment is not a piece of scan history. The screen is shared, so
// this table is the single place the two product identities are declared.
const SECTION_CHROME = {
  recent: {
    title: 'Recent Scans',
    subtitle: 'SCAN HISTORY & DISCOVERY',
    emptyTitle: 'No Recent Scans Yet',
    emptyBody: 'Items you scan will appear here.',
  },
  closet: {
    title: 'Your Closet',
    subtitle: 'YOUR OWNED WARDROBE',
    emptyTitle: 'Your Closet is empty',
    // No emptyBody. The Closet's empty body depends on whether direct intake is
    // available, so it is written at the call site. A static string here was a
    // SECOND body for the same state that nothing rendered — the kind of
    // duplicate copy this table exists to prevent.
  },
} as const;

// Pre-separation chrome. With CLOSET_SEPARATION_V1 off there is no section
// concept at all — no tabs and no Closet surface — so the screen keeps exactly
// the identity it shipped with rather than adopting section language it has no
// way to switch between.
const LEGACY_CHROME = {
  title: 'Your Closet',
  subtitle: 'SAVED LOOKS & INSPIRATION',
  emptyTitle: 'Start Your Closet',
  emptyBody: 'Save a scan and your looks will live here.',
} as const;

// ── Screen ────────────────────────────────────────────────────────────────────
export default function LibraryScreen() {
  const router = useRouter();
  const { scans, loading, remove } = useLibrary();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { isAuthenticated, user } = useAuthSession();
  const dressingRoomsEnabled = !featureFreezeLoading && isFeatureEnabled('dressingRooms');
  const aiStylistEnabled =
    AI_STYLIST_UI_ENABLED &&
    !featureFreezeLoading &&
    isFeatureEnabled('aiStylist') &&
    isFeatureEnabled('outfitRemixLooks');

  const [selectedScan, setSelectedScan] = useState<SavedScan | null>(null);
  const [dressingRoomModalVisible, setDressingRoomModalVisible] = useState(false);

  // ── Closet separation ──────────────────────────────────────────────────────
  // The section is explicit route state, never inferred from which segment
  // happens to be selected. A record's domain is determined by which store it
  // came from, so a Recent Scan can never be classified as a Closet item (or
  // vice versa) by navigating between segments.
  const params = useLocalSearchParams<{ section?: string }>();
  const requestedSection = params?.section === 'closet' ? 'closet' : 'recent';
  const [section, setSection] = useState<'recent' | 'closet'>(requestedSection);
  useEffect(() => {
    setSection(requestedSection);
  }, [requestedSection]);

  const closet = useCloset();
  // The ONE candidate-hook instance for this screen. Intake routes through it
  // and the status panel renders from it, so a staged photo appears immediately
  // rather than on the next focus.
  const closetCandidates = useClosetCandidates();

  /**
   * Promotion is the ONLY path that writes a committed Closet item from the
   * candidate side, and the two hooks hold independent snapshots. Without this
   * bridge the item lands on disk and the grid below never re-reads it, which
   * reads to the user as "the item I just added is missing" — or, on a
   * first-ever add, as an empty Closet.
   *
   * The re-read is additive: `refresh` cannot clear the grid, so a promotion
   * whose follow-up read fails leaves the existing items alone.
   */
  const closetCandidatesWithCommitBridge = useMemo(
    () => ({
      ...closetCandidates,
      promoteSelected: async (...args: Parameters<typeof closetCandidates.promoteSelected>) => {
        const result = await closetCandidates.promoteSelected(...args);
        await closet.refresh();
        return result;
      },
    }),
    [closetCandidates, closet.refresh]
  );
  const [closetIntakeVisible, setClosetIntakeVisible] = useState(false);
  const [mirrorSelfieVisible, setMirrorSelfieVisible] = useState(false);
  const [closetState, setClosetState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [inspirations, setInspirations] = useState<InspirationItem[]>([]);
  const [inspirationLoading, setInspirationLoading] = useState(false);
  const [inspirationError, setInspirationError] = useState<string | null>(null);
  const [selectedInspirationUri, setSelectedInspirationUri] = useState<string | null>(null);
  const [showInspirationModal, setShowInspirationModal] = useState(false);
  const [inspirationForRoom, setInspirationForRoom] = useState<InspirationItem | null>(null);

  const loadInspirations = useCallback(async () => {
    if (!isAuthenticated) return;
    setInspirationLoading(true);
    setInspirationError(null);
    try {
      setInspirations(await listInspirationItems());
    } catch (err: any) {
      setInspirationError(err?.message || 'Unable to load inspiration uploads.');
    } finally {
      setInspirationLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void loadInspirations();
  }, [loadInspirations]);

  const closetActorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = closetActorId ? `user:${closetActorId}` : 'device-local';

  // Monotonic open-sequence guard for the promoted-lineage lookup. The lookup's
  // disk read serializes behind the Closet mutation queue, so its latency is
  // unbounded; without this guard a lookup started for one scan could resolve
  // after a different scan (or a different actor's session) is on screen and
  // stamp a stale "In Your Closet" badge on it — falsely disabling promotion.
  const scanOpenSeqRef = useRef(0);

  // Detail-view safety (parity with the iOS line): an actor transition must
  // immediately stop exposing the previous actor's scan. Clearing selectedScan
  // unmounts the AnalysisCard modal, which also drops the selected image URI,
  // and resets the Closet affordance so a stale "In Your Closet" badge cannot
  // survive an account switch. Invalidating the open sequence rejects any
  // lineage lookup still in flight from the previous actor's session.
  useEffect(() => {
    scanOpenSeqRef.current += 1;
    setSelectedScan(null);
    setDressingRoomModalVisible(false);
    setClosetState('idle');
  }, [actorKey]);

  const handleOpenScan = (scan: SavedScan) => {
    const seq = ++scanOpenSeqRef.current;
    setSelectedScan(scan);
    setClosetState('idle');
    if (!CLOSET_SEPARATION_V1) return;
    // Reflect an existing Closet item for this lineage so a re-open shows
    // "In Your Closet" rather than offering a duplicate promotion.
    void isScanPromoted(scan, closetActorId)
      .then((promoted) => {
        if (promoted && scanOpenSeqRef.current === seq) setClosetState('saved');
      })
      .catch(() => null);
  };
  const handleCloseScan = () => {
    scanOpenSeqRef.current += 1; // invalidate any in-flight lineage lookup
    setSelectedScan(null);
    setDressingRoomModalVisible(false);
    setClosetState('idle');
  };

  /**
   * Non-destructive promotion. The source scan is untouched: this only reads it
   * and writes a separate Closet record, so the commerce snapshot rendered
   * underneath this card is unchanged before and after.
   */
  const handleAddToCloset = async () => {
    if (!selectedScan || closetState !== 'idle') return;
    setClosetState('saving');
    const result = (await closet.addFromScan(selectedScan)) as {
      ok: boolean;
      reason?: string;
    };
    if (result?.ok) {
      setClosetState('saved');
      return;
    }
    setClosetState('idle');
    Alert.alert(
      'Could not add to Closet',
      result?.reason === 'android_requires_authenticated_actor'
        ? 'Sign in to save items to your Closet.'
        : result?.reason === 'no_local_media_to_promote'
          ? 'This scan has no image saved on this device yet.'
          : 'This item could not be added. Please try again.'
    );
  };

  /**
   * THE Closet intake fork.
   *
   * With staging active the photo becomes a CANDIDATE — candidate-owned media, a
   * durable manifest record, and a classification queue entry — and the committed
   * Closet is not written at all. With staging off this is exactly the direct
   * intake that shipped before, unchanged.
   *
   * The decision lives in services/closetIntakeRouting.js rather than here so it
   * can be executed in a test with both destinations stubbed. The screen supplies
   * the two real destinations and nothing else: it never normalizes media and
   * never writes to either manifest itself.
   */
  const handleClosetIntakeSave = async (
    sourceUri: string,
    draft: { title: string | null; category: string | null },
    sourceType: 'camera' | 'gallery'
  ): Promise<{ ok: boolean; reason?: string }> =>
    (await routeClosetIntake({
      stagingActive: CLOSET_CANDIDATE_STAGING_ACTIVE,
      sourceUri,
      sourceType,
      draft,
      committedIntake: (uri, intakeDraft) => closet.addFromUri(uri, intakeDraft),
      candidateIntake: (uri, intake) => closetCandidates.addFromUri(uri, intake),
      createBatchId: createClosetBatchId,
    })) as { ok: boolean; reason?: string };

  const handleClosetIntakeBatchSave = async (
    assets: ImagePicker.ImagePickerAsset[],
    draft: { title: string | null; category: string | null },
    sourceType: 'camera' | 'gallery',
  ) => {
    const outcome = await closetCandidates.addFromAssets(assets, {
      sourceType,
      draft,
    });
    const acceptedCount =
      typeof outcome.acceptedCount === 'number' ? outcome.acceptedCount : 0;
    return {
      ok: Array.isArray(outcome.createdCandidateIds) && outcome.createdCandidateIds.length > 0,
      reason: typeof outcome.code === 'string' ? outcome.code : undefined,
      batchOutcome: {
        selectedCount: typeof outcome.selectedCount === 'number' ? outcome.selectedCount : 0,
        acceptedCount,
        rejectedForCapacityCount:
          typeof outcome.rejectedForCapacityCount === 'number'
            ? outcome.rejectedForCapacityCount
            : 0,
        failedSourceIndexes: Array.isArray(outcome.failedSourceIndexes)
          ? outcome.failedSourceIndexes
          : [],
      },
    };
  };

  /**
   * Private Dressing Room entry for a Closet item.
   *
   * Flag-gated: with the workspace off this contributes no props at all, so the
   * card renders exactly as it does today. Only the selected `closetItemId` is
   * passed — the route validates it against the actor's own Closet before it can
   * become an anchor. This is additive and leaves the collaborative
   * "Add to Room" action on the scan/inspiration cards untouched.
   */
  const closetOutfitAction = (id: string) =>
    PRIVATE_DRESSING_ROOM_V1
      ? {
          viewLabel: 'Build an outfit',
          onPress: () =>
            router.push({
              pathname: '/stylist/dressing-room',
              params: { closetItemId: id },
            }),
        }
      : {};

  const handleDeleteClosetItem = (id: string) => {
    Alert.alert(
      'Remove from Closet?',
      'This removes the item from your Closet. Your scans are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const ok = await closet.remove(id);
            if (!ok) {
              Alert.alert('Could not remove', 'Please try again.');
            }
          },
        },
      ]
    );
  };

  const handleUploadInspiration = async () => {
    const granted = await requestPhotoLibraryPermission();
    if (!granted) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
      allowsEditing: false,
      allowsMultipleSelection: false,
    });

    if (!result.canceled && result.assets?.[0]?.uri) {
      setSelectedInspirationUri(result.assets[0].uri);
      setShowInspirationModal(true);
    }
  };

  const handleInspirationSuccess = (item: InspirationItem) => {
    setInspirations((current) => [item, ...current]);
  };

  const handleCloseInspirationModal = () => {
    setShowInspirationModal(false);
    setSelectedInspirationUri(null);
  };

  const handleDeleteScan = (id: string) => {
    Alert.alert(
      'Delete Scan?',
      'This will remove the scan from your Style Closet.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await remove(id);
            } catch (err: any) {
              if (__DEV__) {
                console.warn('Delete scan failed', err);
              }
              Alert.alert('Could not delete', 'Could not delete this scan. Please try again.');
            }
          },
        },
      ]
    );
  };

  // Tapping a Closet/Inspiration item opens the room picker so it can be added
  // to a Dressing Room. Gated by the dressingRooms feature flag.
  const handleAddInspirationToRoom = (item: InspirationItem) => {
    setInspirationForRoom(item);
  };

  const handleDeleteInspiration = async (id: string) => {
    Alert.alert(
      'Delete Inspiration?',
      'This will remove the image from your Style Closet and any Dressing Rooms it was added to.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteInspirationItem(id);
              setInspirations((current) => current.filter((item) => item.id !== id));
            } catch (err: any) {
              // Never surface raw Supabase/RLS errors to users.
              if (__DEV__) {
                console.warn('Delete inspiration failed', err);
              }
              Alert.alert('Could not delete', 'Could not delete this Closet item. Please try again.');
            }
          },
        },
      ]
    );
  };

  // With separation OFF the screen renders exactly as before: no section tabs
  // and no Closet surface. Nothing about Recent Scans changes either way.
  const showRecentSection = !CLOSET_SEPARATION_V1 || section === 'recent';
  const showClosetSection = CLOSET_SEPARATION_V1 && section === 'closet';

  // Chrome follows the ACTIVE SECTION, never the screen's file name. Without
  // this the route could resolve to Recent Scans while the header still claimed
  // "Your Closet" — the alias that made scan history look like owned inventory.
  const chrome = CLOSET_SEPARATION_V1 ? SECTION_CHROME[section] : LEGACY_CHROME;
  // This empty state only ever renders under the Recent Scans or the
  // pre-separation chrome; the Closet writes its own, intake-dependent body.
  const recentEmptyBody = CLOSET_SEPARATION_V1
    ? SECTION_CHROME.recent.emptyBody
    : LEGACY_CHROME.emptyBody;

  const scanPairs = scans.reduce<[SavedScan, SavedScan | null][]>((pairs, scan, i) => {
    if (i % 2 === 0) pairs.push([scan, scans[i + 1] ?? null]);
    return pairs;
  }, []);

  const closetPairs = closet.items.reduce<[any, any | null][]>((pairs, item, i) => {
    if (i % 2 === 0) pairs.push([item, closet.items[i + 1] ?? null]);
    return pairs;
  }, []);

  const inspirationPairs = inspirations.reduce<[InspirationItem, InspirationItem | null][]>((pairs, item, i) => {
    if (i % 2 === 0) pairs.push([item, inspirations[i + 1] ?? null]);
    return pairs;
  }, []);

  return (
    <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
      <StatusBar style="dark" />
      <KScanHeader
        title={chrome.title}
        subtitle={chrome.subtitle}
        onBack={() => goBackOrHome(router)}
        backLabel="Back"
      />

      {aiStylistEnabled ? (
        <View style={styles.subNav} accessibilityRole="tablist">
          {/*
            The legacy AI Stylist "MY CLOSET" entry was a non-interactive View
            hardcoded to selected. It stayed lit while Recent Scan records were
            on screen, and it never opened the committed Closet grid — it was
            decorative chrome that asserted a domain the screen was not showing.
            With separation active the section tablist below is the authoritative
            Closet/Recent control, so this redundant label is not rendered.
            My Looks stays: Saved Looks is its own concept, neither Recent Scan
            history nor owned inventory.
          */}
          {CLOSET_SEPARATION_V1 ? null : (
            <View style={[styles.subNavTab, styles.subNavTabActive]} accessibilityRole="tab" accessibilityState={{ selected: true }}>
              <Text style={[styles.subNavText, styles.subNavTextActive]}>MY CLOSET</Text>
            </View>
          )}
          <TouchableOpacity
            style={styles.subNavTab}
            onPress={() => router.push('/looks')}
            accessibilityRole="tab"
            accessibilityState={{ selected: false }}
            accessibilityLabel="My Looks"
            testID="library-my-looks-tab"
          >
            <Text style={styles.subNavText}>MY LOOKS</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {CLOSET_SEPARATION_V1 ? (
        <View style={styles.subNav} accessibilityRole="tablist">
          <TouchableOpacity
            style={[styles.subNavTab, section === 'recent' && styles.subNavTabActive]}
            onPress={() => router.setParams({ section: 'recent' })}
            accessibilityRole="tab"
            accessibilityState={{ selected: section === 'recent' }}
            accessibilityLabel="Recent Scans"
            accessibilityHint="Show your scan history"
            testID="library-section-recent"
          >
            <Text style={[styles.subNavText, section === 'recent' && styles.subNavTextActive]}>
              RECENT SCANS
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.subNavTab, section === 'closet' && styles.subNavTabActive]}
            onPress={() => router.setParams({ section: 'closet' })}
            accessibilityRole="tab"
            accessibilityState={{ selected: section === 'closet' }}
            accessibilityLabel="My Closet"
            accessibilityHint="Show the items you own"
            testID="library-section-closet"
          >
            <Text style={[styles.subNavText, section === 'closet' && styles.subNavTextActive]}>
              MY CLOSET
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {showClosetSection ? (
          <>
            <SectionHeader
              title="My Closet"
              actionLabel={CLOSET_DIRECT_INTAKE_ACTIVE ? 'Add Item' : undefined}
              onAction={
                CLOSET_DIRECT_INTAKE_ACTIVE ? () => setClosetIntakeVisible(true) : undefined
              }
              actionAccessibilityLabel="Add an item to your Closet"
            />
            {/*
              Mirror Selfie intake (Build 2.5 Step 3).

              A DISTINCT ACTION ON THE EXISTING CLOSET INTAKE SURFACE — not a new
              tab, not a Scanner entry point, not an Elise or commerce entry
              point, and not a second Closet. It sits beside Add Item because it
              fills the same Closet by a different route: one photo of an outfit
              instead of one photo per garment.

              Renders NOTHING while MIRROR_SELFIE_V1_ACTIVE is false, which is
              its state in every profile in this build.
            */}
            {MIRROR_SELFIE_V1_ACTIVE ? (
              <View style={styles.mirrorAction}>
                <SecondaryButton
                  title="Mirror Selfie"
                  onPress={() => setMirrorSelfieVisible(true)}
                  accessibilityLabel="Add several items from one mirror selfie"
                  testID="closet-mirror-selfie-button"
                />
              </View>
            ) : null}
            {/*
              Candidate staging surface (Closet Upgrade Build 1).

              Mounted ONLY when the derived capability is active, so a build with
              the flag off performs no candidate disk read, starts no
              classification, and renders exactly what it renders today. The panel
              lists STAGED candidates; the committed Closet grid below is
              unchanged and remains the only owned-inventory view.
            */}
            {CLOSET_CANDIDATE_STAGING_ACTIVE ? (
              <ClosetCandidateStatusPanel api={closetCandidatesWithCommitBridge} />
            ) : null}
            {closet.loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="large" color={LUXURY.colors.plum} />
              </View>
            ) : closet.error && closet.items.length === 0 ? (
              /*
                A Closet we could not READ is not an empty Closet. Saying
                "empty" here would tell the user their items are gone and offer
                "Add Item" as the remedy, when the items are on disk and the
                remedy is to try the read again.
              */
              <EmptyStateCard
                testID="closet-load-error-card"
                title="We couldn't load your Closet"
                subtitle={`${closet.error.message} Your items are safe — this was a problem reading them.`}
                action={{
                  label: 'Try Again',
                  onPress: () => {
                    void closet.refresh();
                  },
                  accessibilityLabel: 'Try loading your Closet again',
                  testID: 'closet-load-error-retry-button',
                }}
              />
            ) : closet.items.length === 0 ? (
              <EmptyStateCard
                title={chrome.emptyTitle}
                subtitle={
                  CLOSET_DIRECT_INTAKE_ACTIVE
                    ? 'Add items you own with Add Item, or add one from a recent scan.'
                    : 'Open a recent scan and choose Add to Closet.'
                }
                action={
                  CLOSET_DIRECT_INTAKE_ACTIVE
                    ? {
                        // The Closet is filled by intake or promotion, never by
                        // opening the Scanner — that would create a Recent Scan.
                        label: 'Add Item',
                        onPress: () => setClosetIntakeVisible(true),
                        accessibilityLabel: 'Add an item to your Closet',
                        testID: 'closet-empty-add-item-button',
                      }
                    : undefined
                }
              />
            ) : (
              <View style={styles.grid}>
                {closetPairs.map(([a, b]) => (
                  <View key={a.id} style={styles.gridRow}>
                    <SavedLookCard
                      testID="closet-card"
                      imageUrl={a.thumbnailUri ?? a.imageUri}
                      title={a.title}
                      accessibilityLabel={`${a.title} Closet item`}
                      subtitle={closetCardSubtitle(a.title, a.category)}
                      date={formatDate(a.createdAt)}
                      status="Closet"
                      onDelete={() => handleDeleteClosetItem(a.id)}
                      {...closetOutfitAction(a.id)}
                      style={{ width: CARD_W }}
                    />
                    {b ? (
                      <SavedLookCard
                        testID="closet-card"
                        imageUrl={b.thumbnailUri ?? b.imageUri}
                        title={b.title}
                        accessibilityLabel={`${b.title} Closet item`}
                        subtitle={closetCardSubtitle(b.title, b.category)}
                        date={formatDate(b.createdAt)}
                        status="Closet"
                        onDelete={() => handleDeleteClosetItem(b.id)}
                        {...closetOutfitAction(b.id)}
                        style={{ width: CARD_W }}
                      />
                    ) : (
                      <View style={{ width: CARD_W, minHeight: CARD_MIN_H }} />
                    )}
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}

        {showRecentSection ? (
          <>
        <SectionHeader
          title={CLOSET_SEPARATION_V1 ? 'Recent Scans' : 'Saved Looks'}
          actionLabel={aiStylistEnabled ? ELISE_IDENTITY.styleWithEliseLabel : undefined}
          onAction={aiStylistEnabled ? () => router.push('/stylist') : undefined}
          actionAccessibilityLabel="Style with Elise from my closet"
        />

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          </View>
        ) : scans.length === 0 ? (
          <EmptyStateCard
            title={chrome.emptyTitle}
            subtitle={recentEmptyBody}
            action={
              CLOSET_SEPARATION_V1
                ? {
                    // Recent Scans is filled by scanning, never by Closet
                    // intake — this CTA must not create an owned item.
                    label: 'Start Scanning',
                    onPress: () => router.push('/scan'),
                    accessibilityLabel: 'Start scanning',
                    testID: 'recent-empty-scan-button',
                  }
                : undefined
            }
          />
        ) : scans.length === 1 ? (
          <View style={styles.singleCardRow}>
            <SavedLookCard
              testID="scan-card"
              // The solo card spans both columns, so a card-sized thumbnail is
              // the one derivative that cannot cover it. This is a single card,
              // not a list cell — reading the full image here is cheap and is
              // the only way the layout is not upscaling.
              imageUrl={scans[0].imageUri ?? scans[0].thumbnailUri}
              title={scans[0].attributes.category || 'Scan'}
              accessibilityLabel={`${scans[0].attributes.category || 'Scan'} Recent Scan`}
              subtitle={scans[0].result}
              tags={[scans[0].attributes.color_palette, scans[0].attributes.silhouette].filter(Boolean) as string[]}
              date={formatDate(scans[0].createdAt)}
              status="Scan"
              onPress={() => handleOpenScan(scans[0])}
              onDelete={() => handleDeleteScan(scans[0].id)}
              style={{ width: SINGLE_CARD_W }}
            />
          </View>
        ) : (
          <View style={styles.grid}>
            {scanPairs.map(([a, b]) => (
              <View key={a.id} style={styles.gridRow}>
                <SavedLookCard
                  testID="scan-card"
                  imageUrl={a.thumbnailUri ?? a.imageUri}
                  title={a.attributes.category || 'Scan'}
                  accessibilityLabel={`${a.attributes.category || 'Scan'} Recent Scan`}
                  subtitle={a.result}
                  tags={[a.attributes.color_palette, a.attributes.silhouette].filter(Boolean) as string[]}
                  date={formatDate(a.createdAt)}
                  status="Scan"
                  onPress={() => handleOpenScan(a)}
                  onDelete={() => handleDeleteScan(a.id)}
                  style={{ width: CARD_W }}
                />
                {b ? (
                  <SavedLookCard
                    imageUrl={b.thumbnailUri ?? b.imageUri}
                    title={b.attributes.category || 'Scan'}
                    accessibilityLabel={`${b.attributes.category || 'Scan'} Recent Scan`}
                    subtitle={b.result}
                    tags={[b.attributes.color_palette, b.attributes.silhouette].filter(Boolean) as string[]}
                    date={formatDate(b.createdAt)}
                    status="Scan"
                    onPress={() => handleOpenScan(b)}
                    onDelete={() => handleDeleteScan(b.id)}
                    style={{ width: CARD_W }}
                  />
                ) : (
                  <View style={{ width: CARD_W, minHeight: CARD_MIN_H }} />
                )}
              </View>
            ))}
          </View>
        )}

        {/* Free Tier Utility section (flag-guarded; renders null by default) */}
        {FREE_TIER_UTILITY_ENABLED ? (
          <FreeTierUtilitySection rawItems={scans} variant="library" />
        ) : null}

        <SectionHeader
          title="Inspiration"
          actionLabel={isAuthenticated ? 'Upload' : undefined}
          onAction={isAuthenticated ? handleUploadInspiration : undefined}
          actionAccessibilityLabel="Upload inspiration"
          style={styles.sectionSpaced}
        />

        {!isAuthenticated ? (
          <EmptyStateCard
            title="Sign in to upload inspiration"
            subtitle="Save screenshots and outfit references to your Style Closet."
          />
        ) : inspirationLoading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          </View>
        ) : inspirationError ? (
          <>
            <InlineNotice
              variant="error"
              title="Unable to load inspiration uploads"
              body={inspirationError}
              action={{ label: 'Retry', onPress: loadInspirations, accessibilityLabel: 'Retry loading inspiration' }}
            />
          </>
        ) : inspirations.length === 0 ? (
          <EmptyStateCard
            title="Capture Inspiration"
            subtitle="Upload screenshots and outfit references to round out your Style Closet."
            action={{
              label: 'Upload',
              onPress: handleUploadInspiration,
              accessibilityLabel: 'Upload inspiration',
              testID: 'upload-inspiration-button',
            }}
          />
        ) : inspirations.length === 1 ? (
          <View style={styles.singleCardRow}>
            <SavedLookCard
              imageUrl={inspirations[0].imageUrl}
              title={inspirations[0].note || 'Inspiration'}
              subtitle="Upload"
              date={formatDate(inspirations[0].createdAt)}
              status="Upload"
              onPress={dressingRoomsEnabled ? () => handleAddInspirationToRoom(inspirations[0]) : undefined}
              viewLabel="Add to Room"
              onDelete={() => handleDeleteInspiration(inspirations[0].id)}
              style={{ width: SINGLE_CARD_W }}
            />
          </View>
        ) : (
          <View style={styles.grid}>
            {inspirationPairs.map(([a, b]) => (
              <View key={a.id} style={styles.gridRow}>
                <SavedLookCard
                  imageUrl={a.imageUrl}
                  title={a.note || 'Inspiration'}
                  subtitle="Upload"
                  date={formatDate(a.createdAt)}
                  status="Upload"
                  onPress={dressingRoomsEnabled ? () => handleAddInspirationToRoom(a) : undefined}
                  viewLabel="Add to Room"
                  onDelete={() => handleDeleteInspiration(a.id)}
                  style={{ width: CARD_W }}
                />
                {b ? (
                  <SavedLookCard
                    imageUrl={b.imageUrl}
                    title={b.note || 'Inspiration'}
                    subtitle="Upload"
                    date={formatDate(b.createdAt)}
                    status="Upload"
                    onPress={dressingRoomsEnabled ? () => handleAddInspirationToRoom(b) : undefined}
                    viewLabel="Add to Room"
                    onDelete={() => handleDeleteInspiration(b.id)}
                    style={{ width: CARD_W }}
                  />
                ) : (
                  <View style={{ width: CARD_W, minHeight: CARD_MIN_H }} />
                )}
              </View>
            ))}
          </View>
        )}
          </>
        ) : null}
      </ScrollView>

      {CLOSET_DIRECT_INTAKE_ACTIVE ? (
        <ClosetIntakeModal
          visible={closetIntakeVisible}
          onClose={() => setClosetIntakeVisible(false)}
          onSave={handleClosetIntakeSave}
          onSaveBatch={handleClosetIntakeBatchSave}
          stagingActive={CLOSET_CANDIDATE_STAGING_ACTIVE}
          batchIntakeActive={CLOSET_BATCH_REVIEW_V2_ACTIVE}
        />
      ) : null}

      {/*
        Mirror Selfie extraction (Build 2.5 Step 3) and candidate staging
        (Build 2.5 Step 4).

        The sheet returns a typed MirrorExtractionSelection through the
        existing `onExtracted` callback boundary — no global state, no
        filesystem discovery, no navigation payload. The selection is handed
        directly to the SAME useClosetCandidates() instance every other Closet
        intake on this screen already uses, so Mirror-created candidates
        appear in the existing review surface below through the existing
        snapshot, with no second review UI.
      */}
      {MIRROR_SELFIE_V1_ACTIVE ? (
        <MirrorSelfieExtractionModal
          visible={mirrorSelfieVisible}
          onClose={() => setMirrorSelfieVisible(false)}
          onExtracted={(selection) => {
            void closetCandidates.stageMirrorSelection(selection);
          }}
        />
      ) : null}

      {/*
        Bounded Mirror staging progress (Build 2.5 Step 4).

        Rendered only while MIRROR_SELFIE_V1_ACTIVE and only while an
        operation is actually running or has just finished with something
        worth telling the user about a partial result. No internal group
        numbers, candidate IDs, or backend terms — see
        mirrorStagingProgressLabel below.
      */}
      {MIRROR_SELFIE_V1_ACTIVE && closetCandidates.mirrorIntegration ? (
        <View style={styles.mirrorStagingBanner} accessibilityLiveRegion="polite">
          <Text style={styles.mirrorStagingBannerText}>
            {mirrorStagingProgressLabel(closetCandidates.mirrorIntegration)}
          </Text>
        </View>
      ) : null}

      {/* Reopen saved scan — no backend call, no useKScan involvement */}
      {selectedScan && (
        <AnalysisCard
          result={selectedScan.result}
          metadata={{
            category: selectedScan.attributes.category,
            color: selectedScan.attributes.color_palette,
            silhouette: selectedScan.attributes.silhouette,
          }}
          products={selectedScan.products}
          purchaseOptions={selectedScan.purchaseOptions}
          scanImageUri={selectedScan.imageUri ?? null}
          scanSourceId={selectedScan.id}
          scanSourceType="style_library_scan"
          relatedSavedScans={scans}
          onDismiss={handleCloseScan}
          onAddToCloset={CLOSET_SEPARATION_V1 ? handleAddToCloset : undefined}
          closetState={closetState}
          onAddToDressingRoom={
            dressingRoomsEnabled && hasUsableDressingRoomImageSource({
              localUri: selectedScan.imageUri,
              storageBucket: selectedScan.storageBucket,
              storagePath: selectedScan.storagePath,
            })
              ? () => setDressingRoomModalVisible(true)
              : undefined
          }
          addToDressingRoomUnavailableReason={
            dressingRoomsEnabled && !hasUsableDressingRoomImageSource({
              localUri: selectedScan.imageUri,
              storageBucket: selectedScan.storageBucket,
              storagePath: selectedScan.storagePath,
            })
              ? describeMissingImageReason()
              : null
          }
          onAskStyleChat={
            aiStylistEnabled && STYLECHAT_ATTACHMENTS_ENABLED
              ? () => {
                  // One-time handoff into the unsent StyleChat draft (never
                  // auto-sends). Local-only scans run the full resolution
                  // saga (row + private media) inside the composer.
                  const item = normalizeLocalSavedScan(selectedScan as never);
                  setAttachmentHandoff({
                    resolved: null,
                    ownedItem: item,
                    localScan: selectedScan,
                    summary: {
                      title: item.title,
                      subtitle: item.category ?? null,
                      imageUri: item.imageUri ?? null,
                      itemCount: 1,
                    },
                    createdAt: new Date().toISOString(),
                  });
                  handleCloseScan();
                  router.push('/style-chat');
                }
              : undefined
          }
        />
      )}

      {/* Top-level modal — never nested inside AnalysisCard's Modal.
          Gated by the same canonical contract as the Add CTA above, not bare
          imageUri truthiness, so a cloud-synced scan with a durable storage
          reference (but no local file left on this device) still opens the
          modal instead of being silently excluded. */}
      {dressingRoomsEnabled && selectedScan && hasUsableDressingRoomImageSource({
        localUri: selectedScan.imageUri,
        storageBucket: selectedScan.storageBucket,
        storagePath: selectedScan.storagePath,
      }) ? (
        <AddScanToDressingRoomModal
          visible={dressingRoomModalVisible}
          localImageUri={selectedScan.imageUri}
          storageBucket={selectedScan.storageBucket}
          storagePath={selectedScan.storagePath}
          scan={{
            sourceType: 'style_library_scan',
            sourceId: selectedScan.id,
            result: selectedScan.result,
            metadata: {
              category: selectedScan.attributes.category,
              color: selectedScan.attributes.color_palette,
              silhouette: selectedScan.attributes.silhouette,
            },
          }}
          onClose={() => setDressingRoomModalVisible(false)}
        />
      ) : null}

      {dressingRoomsEnabled ? (
        <AddInspirationToDressingRoomModal
          visible={!!inspirationForRoom}
          inspirationId={inspirationForRoom?.id ?? null}
          inspirationLabel={inspirationForRoom?.note ?? null}
          onClose={() => setInspirationForRoom(null)}
        />
      ) : null}

      <InspirationUploadModal
        visible={showInspirationModal}
        selectedUri={selectedInspirationUri}
        onClose={handleCloseInspirationModal}
        onSuccess={handleInspirationSuccess}
      />

      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
      />
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  subNav: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.xl,
    paddingBottom: SPACING.sm,
  },
  subNavTab: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xs,
  },
  subNavTabActive: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.plum,
  },
  subNavText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    letterSpacing: 1.6,
  },
  subNavTextActive: {
    color: LUXURY.colors.pearl,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  sectionSpaced: {
    marginTop: SPACING.xxl,
  },
  grid: {
    gap: SPACING.md,
  },
  gridRow: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  singleCardRow: {
    alignItems: 'center',
  },
  // Mirror Selfie action, sitting under the Closet section header beside the
  // existing Add Item affordance.
  mirrorAction: {
    paddingHorizontal: SPACING.xl,
    paddingBottom: SPACING.md,
  },
  // Bounded Mirror candidate-staging progress banner (Build 2.5 Step 4).
  mirrorStagingBanner: {
    marginHorizontal: SPACING.xl,
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    backgroundColor: LUXURY.colors.pearl,
  },
  mirrorStagingBannerText: {
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  loadingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xl,
  },
});
