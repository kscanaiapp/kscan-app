import React, { useCallback, useEffect, useState } from 'react';
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
} from '../constants/featureFlags';
import { FreeTierUtilitySection } from '../components/free-tier/FreeTierUtilitySection';
import { normalizeLocalSavedScan } from '../services/ownedClosetItems';
import { setAttachmentHandoff } from '../services/style-chat/styleChatAttachmentStore';
import { useCloset } from '../hooks/useCloset';
import { ClosetIntakeModal } from '../components/closet/ClosetIntakeModal';
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
  const [closetIntakeVisible, setClosetIntakeVisible] = useState(false);
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

  const handleOpenScan = (scan: SavedScan) => {
    setSelectedScan(scan);
    setClosetState('idle');
    if (!CLOSET_SEPARATION_V1) return;
    // Reflect an existing Closet item for this lineage so a re-open shows
    // "In Your Closet" rather than offering a duplicate promotion.
    void isScanPromoted(scan, closetActorId)
      .then((promoted) => {
        if (promoted) setClosetState('saved');
      })
      .catch(() => null);
  };
  const handleCloseScan = () => {
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

  const handleClosetIntakeSave = async (
    sourceUri: string,
    draft: { title: string | null; category: string | null }
  ): Promise<{ ok: boolean; reason?: string }> =>
    (await closet.addFromUri(sourceUri, draft)) as { ok: boolean; reason?: string };

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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
        title="Your Closet"
        subtitle="SAVED LOOKS & INSPIRATION"
        onBack={() => router.back()}
        backLabel="Back"
      />

      {aiStylistEnabled ? (
        <View style={styles.subNav} accessibilityRole="tablist">
          <View style={[styles.subNavTab, styles.subNavTabActive]} accessibilityRole="tab" accessibilityState={{ selected: true }}>
            <Text style={[styles.subNavText, styles.subNavTextActive]}>MY CLOSET</Text>
          </View>
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
            {closet.loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="large" color={LUXURY.colors.plum} />
              </View>
            ) : closet.items.length === 0 ? (
              <EmptyStateCard
                title="Your Closet is empty"
                subtitle={
                  CLOSET_DIRECT_INTAKE_ACTIVE
                    ? 'Add items you own with Add Item, or add one from a recent scan.'
                    : 'Open a recent scan and choose Add to Closet.'
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
                      subtitle={a.category ?? 'Owned item'}
                      date={formatDate(a.createdAt)}
                      status="Closet"
                      onDelete={() => handleDeleteClosetItem(a.id)}
                      style={{ width: CARD_W }}
                    />
                    {b ? (
                      <SavedLookCard
                        testID="closet-card"
                        imageUrl={b.thumbnailUri ?? b.imageUri}
                        title={b.title}
                        subtitle={b.category ?? 'Owned item'}
                        date={formatDate(b.createdAt)}
                        status="Closet"
                        onDelete={() => handleDeleteClosetItem(b.id)}
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
          title="Saved Looks"
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
            title="Start Your Closet"
            subtitle="Save a scan and your looks will live here."
          />
        ) : scans.length === 1 ? (
          <View style={styles.singleCardRow}>
            <SavedLookCard
              testID="scan-card"
              imageUrl={scans[0].thumbnailUri}
              title={scans[0].attributes.category || 'Scan'}
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
                  imageUrl={a.thumbnailUri}
                  title={a.attributes.category || 'Scan'}
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
                    imageUrl={b.thumbnailUri}
                    title={b.attributes.category || 'Scan'}
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
        />
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
  loadingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xl,
  },
});
