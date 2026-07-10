import React from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Linking,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
import {
  LuxuryScreen,
  KScanHeader,
  SectionHeader,
  SavedLookCard,
  EmptyStateCard,
  InlineNotice,
  PrivacyFooter,
} from '../../components/luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useLooks } from '../../hooks/useStyleObjects';
import type { Look } from '../../types/styleObjects';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_GAP = SPACING.md;
const H_PAD = SPACING.xl;
const CARD_W = Math.floor((SCREEN_W - H_PAD * 2 - CARD_GAP) / 2);

function LooksContent() {
  const { looks, loading, error, reload } = useLooks();
  const blocking = loading || !!error;

  return (
    <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
      <StatusBar style="dark" />
      <KScanHeader
        title="Looks"
        subtitle="OUTFIT COMPOSITIONS"
        onBack={() => router.back()}
        backLabel="Back"
      />

      {blocking ? (
        <View style={styles.centeredFill}>
          {loading ? (
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          ) : (
            <InlineNotice
              variant="error"
              title="Unable to load Looks"
              body={error || 'Something went wrong. Please try again.'}
              action={{ label: 'Retry', onPress: reload, accessibilityLabel: 'Retry loading looks' }}
            />
          )}
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <SectionHeader
            title="Your Looks"
            subtitle="Saved outfit compositions from Dressing Rooms"
          />

          {looks.length === 0 ? (
            <EmptyStateCard
              title="Curate Your First Look"
              subtitle="Open a Dressing Room, select one or more items, and create your first outfit composition."
            />
          ) : (
            <View style={styles.grid}>
              {looks.map((look) => (
                <SavedLookCard
                  key={look.id}
                  imageUrl={look.coverImageUrl || look.coverFallbackUrl}
                  title={look.title}
                  subtitle={look.dressingRoomTitle || 'Standalone Look'}
                  tags={look.description ? [look.description] : [`${look.itemCount ?? 0} items`]}
                  status="Look"
                  onPress={() => router.push(`/looks/${look.id}`)}
                  accessibilityLabel={`${look.title} look`}
                  style={{ width: CARD_W }}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}

      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
      />
    </LuxuryScreen>
  );
}

export default function LooksScreen() {
  const { isFeatureEnabled, isLoading } = useFeatureFreeze();
  if (isLoading) {
    return <FeatureFreezeFallback cta="closet" loading />;
  }
  if (!isFeatureEnabled('outfitRemixLooks')) {
    return <FeatureFreezeFallback cta="closet" />;
  }

  return <LooksContent />;
}

const styles = StyleSheet.create({
  centeredFill: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: CARD_GAP,
  },
});
