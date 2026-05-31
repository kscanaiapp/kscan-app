import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AnalysisCard } from '../components/AnalysisCard';
import { AddScanToDressingRoomModal } from '../components/AddScanToDressingRoomModal';
import { useLibrary } from '../hooks/useLibrary';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
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

// ── Sub-components ────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>Your Style Library is empty.</Text>
      <Text style={styles.emptyBody}>Scan your first look.</Text>
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

// ── Screen ────────────────────────────────────────────────────────────────────
export default function LibraryScreen() {
  const router = useRouter();
  const { scans, loading, remove } = useLibrary();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const dressingRoomsEnabled = !featureFreezeLoading && isFeatureEnabled('dressingRooms');
  const [selectedScan, setSelectedScan] = useState<SavedScan | null>(null);
  const [dressingRoomModalVisible, setDressingRoomModalVisible] = useState(false);

  const handleOpenScan = (scan: SavedScan) => setSelectedScan(scan);
  const handleCloseScan = () => {
    setSelectedScan(null);
    setDressingRoomModalVisible(false);
  };

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

        {/* Spacer mirrors backBtn width for visual centering */}
        <View style={styles.headerRight} />
      </SafeAreaView>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size={LOADING.indicatorSize} color={COLORS.accent} />
        </View>
      ) : (
        <FlatList<SavedScan>
          data={scans}
          numColumns={2}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <ScanCard
              scan={item}
              onPress={handleOpenScan}
              onDelete={remove}
            />
          )}
          style={styles.list}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={[
            styles.listContent,
            scans.length === 0 && styles.listContentEmpty,
          ]}
          ListEmptyComponent={<EmptyState />}
          showsVerticalScrollIndicator={false}
        />
      )}

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
    width: 36, // mirrors backBtn for centering
  },
  // ── List ───────────────────────────────────────────────────────────────────
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: H_PAD,
    paddingTop: SPACING.xl,
    paddingBottom: 80,
  },
  listContentEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  gridRow: {
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
  // ── Empty state ────────────────────────────────────────────────────────────
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
  // ── Loading ────────────────────────────────────────────────────────────────
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.canvasWarm,
  },
});
