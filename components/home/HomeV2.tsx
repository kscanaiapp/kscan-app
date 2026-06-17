import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useLibrary } from '../../hooks/useLibrary';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  PrivacyFooter,
  EmptyStateCard,
  SavedLookCard,
  StatusPill,
} from '../../components/luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { TEXTSCAN_UI_ENABLED } from '../../constants/featureFlags';

interface DestinationCardProps {
  title: string;
  body: string;
  icon: string;
  route: string;
  enabled: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

function DestinationCard({
  title,
  body,
  icon,
  route,
  enabled,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: DestinationCardProps) {
  const isDisabled = !enabled;

  return (
    <Pressable
      testID={testID}
      onPress={() => !isDisabled && router.push(route)}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.destCard,
        isDisabled && styles.destCardDisabled,
        pressed && !isDisabled && styles.destCardPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled }}
    >
      <View style={styles.destCardHeader}>
        <Text style={[styles.destIcon, isDisabled && styles.destMuted]}>{icon}</Text>
        {isDisabled ? (
          <StatusPill label="Coming Soon" variant="neutral" />
        ) : null}
      </View>
      <Text style={[styles.destTitle, isDisabled && styles.destMuted]}>{title}</Text>
      <Text style={[styles.destBody, isDisabled && styles.destMuted]}>{body}</Text>
    </Pressable>
  );
}

function formatDateLabel(iso: string): string {
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

export default function HomeV2() {
  const { isAuthenticated, user, loading: authLoading } = useAuthSession();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { scans, loading: scansLoading } = useLibrary();

  const textScanEnabled =
    TEXTSCAN_UI_ENABLED && !featureFreezeLoading && isFeatureEnabled('textScan');
  const scanEnabled = !featureFreezeLoading && isFeatureEnabled('scan');
  const styleChatEnabled = !featureFreezeLoading && isFeatureEnabled('styleChat');
  const dressingRoomsEnabled = !featureFreezeLoading && isFeatureEnabled('dressingRooms');
  const libraryEnabled = !featureFreezeLoading && isFeatureEnabled('closet');
  const privacyEnabled = !featureFreezeLoading && isFeatureEnabled('privacy');

  const meta = user?.user_metadata as Record<string, string | undefined> | undefined;
  const profileName =
    (meta?.full_name ?? meta?.name ?? meta?.display_name ?? '').trim() || null;

  const greeting = profileName
    ? `Welcome back, ${profileName} ✨`
    : 'Welcome to K Scan AI';

  const recentScans = scans.slice(0, 3);
  const hasRecentScans = recentScans.length > 0;
  const showRecentSection = scansLoading || hasRecentScans;

  return (
    <LuxuryScreen
      testID="home-v2-screen"
      backgroundColor={LUXURY.colors.ivory}
      scrollable
      safeArea
      accessibilityLabel="K Scan Home"
    >
      <StatusBar style="dark" />

      <KScanHeader
        showBrandMark
        subtitle="PRIVATE FASHION INTELLIGENCE"
      />

      {/* Hero / Welcome */}
      <View style={styles.hero}>
        <Text style={styles.heroTitle} accessibilityLabel={greeting}>
          {greeting}
        </Text>
        <Text style={styles.heroBody}>
          Find, save, and style fashion inspiration. Start with a scan, upload, or
          style question.
        </Text>
      </View>

      {/* Primary Actions */}
      <View style={styles.primaryActions}>
        <PrimaryButton
          testID="home-v2-start-scan"
          title="Start a Scan"
          onPress={() => router.push('/scan')}
          accessibilityLabel="Start a scan"
          accessibilityHint="Opens the scan landing"
          style={styles.primaryActionButton}
        />
        {textScanEnabled && (
          <SecondaryButton
            testID="home-v2-textscan"
            title="✧ TextScan"
            onPress={() => router.push('/text-scan')}
            accessibilityLabel="Describe a look"
            accessibilityHint="Opens TextScan to describe fashion inspiration"
            style={styles.secondaryActionButton}
          />
        )}
      </View>

      {/* Continue / Recent */}
      {showRecentSection && (
        <View style={styles.recentSection}>
          <SectionHeader title="Continue" />
          {scansLoading ? (
            <View style={styles.recentPlaceholder}>
              <ActivityIndicator size="small" color={LUXURY.colors.plum} />
            </View>
          ) : hasRecentScans ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.recentScrollContent}
            >
              {recentScans.map((scan) => (
                <SavedLookCard
                  key={scan.id}
                  testID={`home-v2-recent-scan-${scan.id}`}
                  imageUrl={scan.thumbnailUri}
                  title={scan.attributes?.category || 'Scan'}
                  subtitle={scan.result}
                  tags={[
                    scan.attributes?.color_palette,
                    scan.attributes?.silhouette,
                  ].filter(Boolean) as string[]}
                  date={formatDateLabel(scan.createdAt)}
                  status="Scan"
                  onPress={() => router.push('/library')}
                  accessibilityLabel={`Recent scan: ${scan.attributes?.category || 'Scan'}`}
                  style={{ width: 160, marginRight: SPACING.md }}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      )}

      {/* Core Destinations */}
      <SectionHeader title="Explore" />
      <View style={styles.destinationsGrid}>
        <DestinationCard
          title="Scan"
          body="Capture fashion inspiration in the moment."
          icon="◈"
          route="/scan"
          enabled={scanEnabled}
          testID="home-v2-scan-card"
          accessibilityLabel="Start a scan"
          accessibilityHint="Opens the scan landing"
        />
        <DestinationCard
          title="StyleChat"
          body="Ask about looks, outfits, and style direction."
          icon="✦"
          route="/style-chat"
          enabled={styleChatEnabled}
          testID="home-v2-stylechat-card"
          accessibilityLabel="Open StyleChat"
          accessibilityHint="Ask about fashion, outfits, and styling"
        />
      </View>
      <View style={styles.destinationsGrid}>
        <DestinationCard
          title="Dressing Rooms"
          body="Organize looks you are deciding between."
          icon="◇"
          route="/dressing-rooms"
          enabled={dressingRoomsEnabled}
          testID="home-v2-dressing-rooms-card"
          accessibilityLabel="Open Dressing Rooms"
          accessibilityHint="Organize looks you are deciding between"
        />
        <DestinationCard
          title="Library"
          body="Revisit saved scans, uploads, and style ideas."
          icon="◈"
          route="/library"
          enabled={libraryEnabled}
          testID="home-v2-library-card"
          accessibilityLabel="Open Library"
          accessibilityHint="View saved scans, uploads, and style ideas"
        />
      </View>
      <View style={styles.destinationsGrid}>
        <DestinationCard
          title="Privacy & Trust"
          body="Manage account, privacy, and trust settings."
          icon="◉"
          route="/privacy"
          enabled={privacyEnabled}
          testID="home-v2-privacy-card"
          accessibilityLabel="Open Privacy"
          accessibilityHint="Manage account and privacy settings"
        />
      </View>

      {/* Trust / Privacy Footer */}
      <PrivacyFooter
        onPrivacyPress={() => router.push('/privacy')}
        trustCopy="Private by design. K Scan is not designed for facial recognition or identifying people."
        privacyTestID="home-v2-privacy-button"
      />
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginBottom: SPACING.xl,
  },
  heroTitle: {
    ...LUXURY.typography.displayHeadline,
    color: LUXURY.colors.ink,
  },
  heroBody: {
    ...LUXURY.typography.body,
    marginTop: SPACING.sm,
    color: LUXURY.colors.graphite,
  },
  primaryActions: {
    gap: SPACING.md,
    marginBottom: SPACING.xxl,
  },
  primaryActionButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
  },
  secondaryActionButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
    height: 48,
  },
  recentSection: {
    marginBottom: SPACING.xxl,
  },
  recentPlaceholder: {
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentScrollContent: {
    paddingRight: SPACING.lg,
  },
  destinationsGrid: {
    flexDirection: 'row',
    gap: SPACING.lg,
    marginBottom: SPACING.lg,
  },
  destCard: {
    flex: 1,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    minHeight: 160,
    ...SHADOWS.editorialSmall,
  },
  destCardPressed: {
    backgroundColor: LUXURY.colors.champagne,
    borderColor: LUXURY.colors.goldLight,
  },
  destCardDisabled: {
    opacity: 0.55,
  },
  destCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  destIcon: {
    fontSize: 24,
    color: LUXURY.colors.goldBrushed,
  },
  destMuted: {
    color: LUXURY.colors.stone,
  },
  destTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 16,
    marginBottom: SPACING.xs,
  },
  destBody: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
  },
});
