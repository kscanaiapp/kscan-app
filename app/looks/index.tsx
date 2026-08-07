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
import { goBackOrHome } from '../../services/navigationExit';
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
import { AI_STYLIST_UI_ENABLED } from '../../constants/featureFlags';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { usePrivateSavedLooksSummary } from '../../hooks/usePrivateSavedLooksSummary';
import { useLooks } from '../../hooks/useStyleObjects';
import type { Look } from '../../types/styleObjects';

const OCCASION_LABELS: Record<string, string> = {
  casual: 'Casual',
  work: 'Work',
  date: 'Date',
  event: 'Event',
  travel: 'Travel',
  other: 'Other',
};

function lookSubtitle(look: Look): string {
  if (look.source === 'ai') return 'Styled by Elise from your closet';
  if (look.source === 'manual') return 'Built from your closet';
  return look.dressingRoomTitle || 'Standalone Look';
}

function lookTags(look: Look): string[] {
  const tags: string[] = [];
  if (look.occasion && OCCASION_LABELS[look.occasion]) tags.push(OCCASION_LABELS[look.occasion]);
  if (tags.length === 0 && look.description) tags.push(look.description);
  if (tags.length === 0) tags.push(`${look.itemCount ?? 0} items`);
  return tags;
}

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_GAP = SPACING.md;
const H_PAD = SPACING.xl;
const CARD_W = Math.floor((SCREEN_W - H_PAD * 2 - CARD_GAP) / 2);

function LooksContent() {
  const { looks, loading, error, reload } = useLooks();
  const { isFeatureEnabled } = useFeatureFreeze();
  const dressingRoomLooks = usePrivateSavedLooksSummary();
  const blocking = loading || !!error;
  const builderEnabled = AI_STYLIST_UI_ENABLED && isFeatureEnabled('aiStylist');

  /**
   * BUG-14: Looks saved in the private Dressing Room are a different, device-local
   * entity from the cloud Looks listed here — so a user who saved one, saw the
   * Saved Look confirmation, then opened MY LOOKS was told they had none. The
   * Look was never lost; this screen simply could not see it. The two lists stay
   * separate (different shapes, different detail screens), but this one now says
   * the other exists and how to reach it.
   */
  const savedLookCount = dressingRoomLooks.count ?? 0;
  const showDressingRoomLooks =
    dressingRoomLooks.available && (savedLookCount > 0 || dressingRoomLooks.unreadable);
  const dressingRoomLooksNotice = showDressingRoomLooks ? (
    <InlineNotice
      variant="info"
      title="Saved in your Dressing Room"
      body={
        dressingRoomLooks.unreadable
          ? "We couldn't check your Dressing Room Saved Looks just now. They are kept on this device and are unchanged."
          : savedLookCount === 1
            ? 'You have 1 Look saved on this device from your Dressing Room.'
            : `You have ${savedLookCount} Looks saved on this device from your Dressing Room.`
      }
      action={{
        label: 'Open Saved Looks',
        onPress: () => router.push('/stylist/saved-looks'),
        accessibilityLabel: 'Open your Dressing Room Saved Looks',
      }}
      testID="looks-dressing-room-entry"
    />
  ) : null;

  return (
    <LuxuryScreen safeArea={false} scrollable={false} backgroundColor={LUXURY.colors.ivory}>
      <StatusBar style="dark" />
      <KScanHeader
        title="Looks"
        subtitle="OUTFIT COMPOSITIONS"
        onBack={() => goBackOrHome(router)}
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
            subtitle={builderEnabled ? 'Outfits built from what you own' : 'Saved outfit compositions from Dressing Rooms'}
            actionLabel={builderEnabled ? 'Create' : undefined}
            onAction={builderEnabled ? () => router.push('/looks/create') : undefined}
            actionAccessibilityLabel="Create a Look"
          />

          {dressingRoomLooksNotice}

          {looks.length === 0 ? (
            builderEnabled ? (
              <EmptyStateCard
                title="Build outfits from the pieces you already own."
                subtitle="Pick two to six closet items and save your first Look."
                action={{
                  label: 'CREATE A LOOK',
                  onPress: () => router.push('/looks/create'),
                  accessibilityLabel: 'Create a Look',
                  testID: 'create-look-button',
                }}
              />
            ) : (
              <EmptyStateCard
                title="Curate Your First Look"
                subtitle="Open a Dressing Room, select one or more items, and create your first outfit composition."
              />
            )
          ) : (
            <View style={styles.grid}>
              {looks.map((look) => (
                <SavedLookCard
                  key={look.id}
                  imageUrl={look.coverImageUrl || look.coverFallbackUrl}
                  title={look.title}
                  subtitle={lookSubtitle(look)}
                  tags={lookTags(look)}
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
