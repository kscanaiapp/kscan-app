import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  Dimensions,
  ScrollView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

import { AnalysisCard } from '../components/AnalysisCard';
import { AddScanToDressingRoomModal } from '../components/AddScanToDressingRoomModal';
import { InspirationUploadModal } from '../components/InspirationUploadModal';
import { useLibrary } from '../hooks/useLibrary';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  deleteInspirationItem,
  listInspirationItems,
} from '../services/styleObjects';
import type { InspirationItem } from '../types/styleObjects';
import {
  COLORS,
  LAYOUT,
  LOADING,
  RADIUS,
  SHADOWS,
  SPACING,
  TYPOGRAPHY,
} from '../constants/theme';

// ── Layout constants ──────────────────────────────────────────────────────────
const { width: SCREEN_W } = Dimensions.get('window');
const CARD_GAP  = SPACING.md;
const H_PAD     = LAYOUT.screenPadding;
const CARD_W    = Math.floor((SCREEN_W - H_PAD * 2 - CARD_GAP) / 2);
const THUMB_H   = CARD_W; // square thumbnail

// ── SavedScan interface ───────────────────────────────────────────────────────
interface ScanAttributes {
  category:          string;
  silhouette:        string;
  color_palette:     string;
  material_estimate: string | null;
  style_tags:        string[];
  confidence_score:  number | null;
}

interface SavedScan {
  id:           string;
  createdAt:    string;
  imageUri?:     string | null;
  thumbnailUri: string | null;
  attributes:   ScanAttributes;
  result:       string;
  products:     object[];
  source:       'scan';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now  = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7)   return `${diffDays} days ago`;
    const months = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];
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
    [{ text: 'OK' }],
  );
  return false;
}

// ── Sub-components ────────────────────────────────────────────────────────────
function ScanEmptyState() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>No scans yet.</Text>
      <Text style={styles.emptyBody}>Scan your first look.</Text>
    </View>
  );
}

function InspirationEmptyState() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>No inspiration uploads yet.</Text>
      <Text style={styles.emptyBody}>Tap Upload to save screenshots and outfit references.</Text>
    </View>
  );
}

interface ScanCardProps {
  scan:     SavedScan;
  onPress:  (scan: SavedScan) => void;
  onDelete: (id: string) => void;
}

function ScanCard({ scan, onPress, onDelete }: ScanCardProps) {
  return (
    <TouchableOpacity
      testID="scan-card"
      style={[styles.card, { width: CARD_W }]}
      onPress={() => onPress(scan)}
      activeOpacity={0.8}
    >
      {scan.thumbnailUri ? (
        <Image
          source={{ uri: scan.thumbnailUri }}
          style={[styles.thumb, { width: CARD_W, height: THUMB_H }]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder, { width: CARD_W, height: THUMB_H }]} />
      )}

      <View style={styles.cardInfo}>
        <Text style={styles.cardCategory} numberOfLines={1}>
          {scan.attributes.category || '—'}
        </Text>
        <Text style={styles.cardDate}>{formatDate(scan.createdAt)}</Text>
      </View>

      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => onDelete(scan.id)}
        hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
      >
        <Text style={styles.deleteBtnText}>×</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

interface InspirationCardProps {
  item: InspirationItem;
  onDelete: (id: string) => void;
}

function InspirationCard({ item, onDelete }: InspirationCardProps) {
  return (
    <View style={[styles.card, { width: CARD_W }]}>
      {item.imageUrl ? (
        <Image
          source={{ uri: item.imageUrl }}
          style={[styles.thumb, { width: CARD_W, height: THUMB_H }]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder, { width: CARD_W, height: THUMB_H }]}>
          <Text style={styles.thumbPlaceholderText}>Loading...</Text>
        </View>
      )}

      <View style={styles.cardInfo}>
        <View style={styles.inspirationBadgeRow}>
          <View style={styles.inspirationBadge}>
            <Text style={styles.inspirationBadgeText}>UPLOAD</Text>
          </View>
        </View>
        {item.note ? (
          <Text style={styles.cardNote} numberOfLines={2}>{item.note}</Text>
        ) : null}
        <Text style={styles.cardDate}>{formatDate(item.createdAt)}</Text>
      </View>

      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => onDelete(item.id)}
        hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
      >
        <Text style={styles.deleteBtnText}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function LibraryScreen() {
  const router = useRouter();
  const { scans, loading, remove } = useLibrary();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { isAuthenticated, user } = useAuthSession();
  // Dressing Rooms are excluded from the iOS release, so the "Add to Dressing
  // Room" affordance must never wire up there even if the freeze flag is off.
  const dressingRoomsEnabled =
    Platform.OS !== 'ios' && !featureFreezeLoading && isFeatureEnabled('dressingRooms');

  const [selectedScan, setSelectedScan] = useState<SavedScan | null>(null);
  const [dressingRoomModalVisible, setDressingRoomModalVisible] = useState(false);

  const [inspirations, setInspirations] = useState<InspirationItem[]>([]);
  const [inspirationLoading, setInspirationLoading] = useState(false);
  const [inspirationError, setInspirationError] = useState<string | null>(null);
  const [selectedInspirationUri, setSelectedInspirationUri] = useState<string | null>(null);
  const [showInspirationModal, setShowInspirationModal] = useState(false);

  const loadInspirations = useCallback(async () => {
    // Inspiration uploads rely on photo-library import, which is not part of the
    // iOS release. Skip the fetch entirely so iOS triggers no backend call.
    if (!isAuthenticated || Platform.OS === 'ios') return;
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

  const handleOpenScan = (scan: SavedScan) => setSelectedScan(scan);
  const handleCloseScan = () => {
    setSelectedScan(null);
    setDressingRoomModalVisible(false);
  };

  const handleUploadInspiration = async () => {
    if (Platform.OS === 'ios') {
      Alert.alert('Camera scanning only', 'This iOS release uses the camera scan flow. Photo library import is not part of this build.');
      return;
    }
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

  const handleDeleteInspiration = async (id: string) => {
    Alert.alert(
      'Delete Inspiration?',
      'This will remove the image from your Style Library and any Dressing Rooms it was added to.',
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
              Alert.alert('Could not delete', err?.message || 'Try again.');
            }
          },
        },
      ],
    );
  };

  const inspirationGrid = inspirations.reduce<[InspirationItem, InspirationItem | null][]>((pairs, item, i) => {
    if (i % 2 === 0) pairs.push([item, inspirations[i + 1] ?? null]);
    return pairs;
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />

      <SafeAreaView style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
        >
          <Text style={styles.backBtnText}>←</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.brandTitle}>K-SCAN</Text>
          <Text style={styles.screenTitle}>STYLE LIBRARY</Text>
        </View>

        <View style={styles.headerRight} />
      </SafeAreaView>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Scans section ─────────────────────────────────────────────── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>SCANS</Text>
        </View>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size={LOADING.indicatorSize} color={COLORS.accent} />
          </View>
        ) : scans.length === 0 ? (
          <ScanEmptyState />
        ) : (
          <View>
            {scans.reduce<[SavedScan, SavedScan | null][]>((pairs, scan, i) => {
              if (i % 2 === 0) pairs.push([scan, scans[i + 1] ?? null]);
              return pairs;
            }, []).map(([a, b]) => (
              <View key={a.id} style={styles.gridRow}>
                <ScanCard scan={a} onPress={handleOpenScan} onDelete={remove} />
                {b ? <ScanCard scan={b} onPress={handleOpenScan} onDelete={remove} /> : <View style={{ width: CARD_W }} />}
              </View>
            ))}
          </View>
        )}

        {/* ── Inspiration section — excluded on iOS (photo-library import) ─── */}
        {Platform.OS !== 'ios' ? (
          <>
            <View style={[styles.sectionHeader, styles.sectionHeaderSpaced]}>
              <Text style={styles.sectionLabel}>INSPIRATION</Text>
              {isAuthenticated ? (
                <TouchableOpacity
                  style={styles.uploadBtn}
                  onPress={handleUploadInspiration}
                  testID="upload-inspiration-button"
                >
                  <Text style={styles.uploadBtnText}>UPLOAD</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {!isAuthenticated ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyBody}>Sign in to upload inspiration.</Text>
              </View>
            ) : inspirationLoading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size={LOADING.indicatorSize} color={COLORS.accent} />
              </View>
            ) : inspirationError ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyBody}>{inspirationError}</Text>
                <TouchableOpacity onPress={loadInspirations} style={styles.retryBtn}>
                  <Text style={styles.retryBtnText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : inspirations.length === 0 ? (
              <InspirationEmptyState />
            ) : (
              <View>
                {inspirationGrid.map(([a, b]) => (
                  <View key={a.id} style={styles.gridRow}>
                    <InspirationCard item={a} onDelete={handleDeleteInspiration} />
                    {b ? (
                      <InspirationCard item={b} onDelete={handleDeleteInspiration} />
                    ) : (
                      <View style={{ width: CARD_W }} />
                    )}
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}
      </ScrollView>

      {/* Reopen saved scan — no backend call, no useKScan involvement */}
      {selectedScan && (
        <AnalysisCard
          result={selectedScan.result}
          metadata={{
            category:   selectedScan.attributes.category,
            color:      selectedScan.attributes.color_palette,
            silhouette: selectedScan.attributes.silhouette,
          }}
          products={selectedScan.products as any}
          scanImageUri={(selectedScan as any).imageUri ?? null}
          scanSourceId={selectedScan.id}
          scanSourceType="style_library_scan"
          onDismiss={handleCloseScan}
          onAddToDressingRoom={
            dressingRoomsEnabled && (selectedScan as any).imageUri
              ? () => setDressingRoomModalVisible(true)
              : undefined
          }
        />
      )}

      {/* Top-level modal — never nested inside AnalysisCard's Modal */}
      {dressingRoomsEnabled && selectedScan && (selectedScan as any).imageUri ? (
        <AddScanToDressingRoomModal
          visible={dressingRoomModalVisible}
          localImageUri={(selectedScan as any).imageUri}
          scan={{
            sourceType: 'style_library_scan',
            sourceId:   selectedScan.id,
            result:     selectedScan.result,
            metadata: {
              category:   selectedScan.attributes.category,
              color:      selectedScan.attributes.color_palette,
              silhouette: selectedScan.attributes.silhouette,
            },
          }}
          onClose={() => setDressingRoomModalVisible(false)}
        />
      ) : null}

      <InspirationUploadModal
        visible={showInspirationModal}
        selectedUri={selectedInspirationUri}
        onClose={handleCloseInspirationModal}
        onSuccess={handleInspirationSuccess}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.canvasWarm,
  },
  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: H_PAD,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderHairline,
    backgroundColor: COLORS.canvasWarm,
  },
  backBtn: {
    width: 36,
    alignItems: 'flex-start',
  },
  backBtnText: {
    fontSize: 22,
    color: COLORS.accent,
    lineHeight: 26,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  brandTitle: {
    ...TYPOGRAPHY.brand,
    fontSize: 16,
    color: COLORS.editorialTextPrimary,
  },
  screenTitle: {
    ...TYPOGRAPHY.caption,
    marginTop: SPACING.xs,
    color: COLORS.goldPressed,
  },
  headerRight: {
    width: 36,
  },
  // ── Scroll ─────────────────────────────────────────────────────────────────
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: H_PAD,
    paddingTop: SPACING.xl,
    paddingBottom: 80,
  },
  // ── Section headers ────────────────────────────────────────────────────────
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  sectionHeaderSpaced: {
    marginTop: SPACING.xxl,
  },
  sectionLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 2.2,
  },
  uploadBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.gold,
    backgroundColor: COLORS.surfaceCard,
  },
  uploadBtnText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 1.4,
  },
  // ── Grid ───────────────────────────────────────────────────────────────────
  gridRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: SPACING.md,
  },
  // ── Scan card ──────────────────────────────────────────────────────────────
  card: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  thumb: {
    // width/height set inline from CARD_W
  },
  thumbPlaceholder: {
    backgroundColor: COLORS.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPlaceholderText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
  },
  cardInfo: {
    paddingHorizontal: SPACING.md,
    paddingVertical:   SPACING.md,
    gap: SPACING.xxs,
  },
  cardCategory: {
    fontSize:      12,
    fontWeight:    '600' as const,
    letterSpacing: 1.8,
    color:         COLORS.editorialTextPrimary,
    textTransform: 'uppercase' as const,
  },
  cardNote: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
    lineHeight: 16,
  },
  cardDate: {
    fontSize:      11,
    fontWeight:    '400' as const,
    color:         COLORS.editorialTextMuted,
    letterSpacing: 0.6,
  },
  deleteBtn: {
    position:        'absolute',
    top:             SPACING.xs,
    right:           SPACING.xs,
    width:           22,
    height:          22,
    borderRadius:    11,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderWidth:     StyleSheet.hairlineWidth,
    borderColor:     COLORS.borderHairline,
    alignItems:      'center',
    justifyContent:  'center',
  },
  deleteBtnText: {
    fontSize:   14,
    color:      COLORS.editorialTextSecondary,
    lineHeight: 16,
  },
  // ── Inspiration badge ──────────────────────────────────────────────────────
  inspirationBadgeRow: {
    flexDirection: 'row',
    marginBottom: SPACING.xxs,
  },
  inspirationBadge: {
    backgroundColor: COLORS.accentSoft,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  inspirationBadgeText: {
    fontSize:      9,
    fontWeight:    '700' as const,
    letterSpacing: 1.4,
    color:         COLORS.goldPressed,
    textTransform: 'uppercase' as const,
  },
  // ── Empty / loading ────────────────────────────────────────────────────────
  emptyWrap: {
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: H_PAD,
    gap:               SPACING.md,
    borderRadius:      RADIUS.lg,
    borderWidth:       StyleSheet.hairlineWidth,
    borderColor:       COLORS.borderHairline,
    backgroundColor:   COLORS.surfaceCard,
    paddingVertical:   SPACING.xxl,
    ...SHADOWS.editorialSmall,
  },
  emptyTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color:      COLORS.editorialTextPrimary,
    textAlign:  'center',
    letterSpacing: 0.4,
  },
  emptyBody: {
    ...TYPOGRAPHY.caption,
    color:      COLORS.editorialTextMuted,
    textAlign:  'center',
  },
  loadingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xl,
    backgroundColor: COLORS.canvasWarm,
  },
  retryBtn: {
    marginTop: SPACING.sm,
  },
  retryBtnText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 1.2,
  },
});
