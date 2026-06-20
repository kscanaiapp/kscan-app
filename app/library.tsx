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
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

import { AnalysisCard } from '../components/AnalysisCard';
import type { Product } from '../components/ProductShelf';
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
  attributes: ScanAttributes;
  result: string;
  products: Product[];
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

  const [selectedScan, setSelectedScan] = useState<SavedScan | null>(null);
  const [dressingRoomModalVisible, setDressingRoomModalVisible] = useState(false);

  const [inspirations, setInspirations] = useState<InspirationItem[]>([]);
  const [inspirationLoading, setInspirationLoading] = useState(false);
  const [inspirationError, setInspirationError] = useState<string | null>(null);
  const [selectedInspirationUri, setSelectedInspirationUri] = useState<string | null>(null);
  const [showInspirationModal, setShowInspirationModal] = useState(false);

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

  const handleOpenScan = (scan: SavedScan) => setSelectedScan(scan);
  const handleCloseScan = () => {
    setSelectedScan(null);
    setDressingRoomModalVisible(false);
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

  const handleDeleteInspiration = async (id: string) => {
    Alert.alert(
      'Delete Inspiration?',
      'This will remove the image from your Closet and any Dressing Rooms it was added to.',
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
      ]
    );
  };

  const scanPairs = scans.reduce<[SavedScan, SavedScan | null][]>((pairs, scan, i) => {
    if (i % 2 === 0) pairs.push([scan, scans[i + 1] ?? null]);
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
        title="Closet"
        subtitle="SCANS & INSPIRATION"
        onBack={() => router.back()}
        backLabel="Back"
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <SectionHeader title="Scans" />

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          </View>
        ) : scans.length === 0 ? (
          <EmptyStateCard
            title="Build Your Style Archive"
            subtitle="Your saved scans and inspirations will appear here."
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
              onDelete={() => remove(scans[0].id)}
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
                  onDelete={() => remove(a.id)}
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
                    onDelete={() => remove(b.id)}
                    style={{ width: CARD_W }}
                  />
                ) : (
                  <View style={{ width: CARD_W, minHeight: CARD_MIN_H }} />
                )}
              </View>
            ))}
          </View>
        )}

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
            subtitle="Save screenshots and outfit references to your Closet."
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
            subtitle="Upload screenshots and outfit references to round out your Closet."
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
      </ScrollView>

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
          scanImageUri={selectedScan.imageUri ?? null}
          scanSourceId={selectedScan.id}
          scanSourceType="style_library_scan"
          onDismiss={handleCloseScan}
          onAddToDressingRoom={
            dressingRoomsEnabled && selectedScan.imageUri
              ? () => setDressingRoomModalVisible(true)
              : undefined
          }
        />
      )}

      {/* Top-level modal — never nested inside AnalysisCard's Modal */}
      {dressingRoomsEnabled && selectedScan && selectedScan.imageUri ? (
        <AddScanToDressingRoomModal
          visible={dressingRoomModalVisible}
          localImageUri={selectedScan.imageUri}
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

      <InspirationUploadModal
        visible={showInspirationModal}
        selectedUri={selectedInspirationUri}
        onClose={handleCloseInspirationModal}
        onSuccess={handleInspirationSuccess}
      />

      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/support')}
      />
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
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
