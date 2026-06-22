import React from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useLibrary } from '../../hooks/useLibrary';
import { useStylePicks } from '../../hooks/useStylePicks';
import type { StylePick } from '../../types/stylePicks';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  PrivacyFooter,
  SavedLookCard,
  StatusPill,
} from '../../components/luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { TEXTSCAN_UI_ENABLED } from '../../constants/featureFlags';


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

interface FeatureChipProps {
  icon: string;
  title: string;
  body: string;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

function FeatureChip({ icon, title, body, onPress, testID, accessibilityLabel, accessibilityHint }: FeatureChipProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={styles.chip}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      <Text style={styles.chipIcon}>{icon}</Text>
      <Text style={styles.chipTitle}>{title}</Text>
      <Text style={styles.chipBody}>{body}</Text>
    </Pressable>
  );
}

/**
 * Bright luxury Home dashboard (HomeLuxuryTechV1).
 *
 * Matches the home-page-v1 mockup direction without fake commerce:
 * - Hero with "Scan it. Find it. Love it." and fashion placeholder
 * - Start Scan primary CTA
 * - Real recent scans from useLibrary (or empty state)
 * - Style Picks editorial placeholder (no fake prices / retailers)
 * - Feature explanation row
 * - No bottom tab navigator
 */
export default function HomeLuxuryTechV1() {
  const { isAuthenticated, user, loading: authLoading } = useAuthSession();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { scans, loading: scansLoading } = useLibrary();
  const { picks, status: stylePicksStatus, isLoading: stylePicksLoading, error: stylePicksError } = useStylePicks();

  const textScanEnabled =
    TEXTSCAN_UI_ENABLED && !featureFreezeLoading && isFeatureEnabled('textScan');
  const scanEnabled = !featureFreezeLoading && isFeatureEnabled('scan');

  const meta = user?.user_metadata as Record<string, string | undefined> | undefined;
  const profileName =
    (meta?.full_name ?? meta?.name ?? meta?.display_name ?? '').trim() || null;

  const recentScans = scans.slice(0, 4);
  const hasRecentScans = recentScans.length > 0;
  const showRecentSection = scansLoading || hasRecentScans;

  const showStylePicks = stylePicksStatus !== 'backend_not_connected' || picks.length > 0;
  const hasStylePicks = picks.length > 0;

  return (
    <LuxuryScreen
      testID="home-luxury-tech-v1-screen"
      backgroundColor={LUXURY.colors.ivory}
      scrollable
      safeArea
      accessibilityLabel="K Scan Home"
    >
      <StatusBar style="dark" />

      <KScanHeader
        showBrandMark
        brandLabel="K Scan AI"
        brandMarkStyle={styles.homeBrandMark}
        subtitle="AI STYLIST • VISUAL SHOPPING"
        rightAction={
          isAuthenticated ? (
            <Pressable
              testID="home-luxury-profile-button"
              onPress={() => router.push('/privacy')}
              style={styles.avatarButton}
              accessibilityRole="button"
              accessibilityLabel="Open profile and privacy settings"
            >
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarText}>
                  {profileName ? profileName.charAt(0).toUpperCase() : '✦'}
                </Text>
              </View>
            </Pressable>
          ) : undefined
        }
      />

      {/* Hero Section */}
      <View style={styles.heroCard}>
        <View style={styles.heroText}>
          <Text style={styles.heroHeadline} accessibilityRole="header">
            Scan it.{'\n'}Find it.{' '}
            <Text style={styles.heroHeadlineGold}>Love it.</Text>
          </Text>
          <Text style={styles.heroBody}>
            Instantly discover style inspiration and shop what you love.
          </Text>
          <PrimaryButton
            testID="home-luxury-start-scan"
            title="✧ START SCAN"
            onPress={() => router.push('/scan')}
            accessibilityLabel="Start a scan"
            accessibilityHint="Opens the scan landing"
            style={styles.heroButton}
          />
        </View>
        <View style={styles.heroImage}>
          <Image
            source={require('../../assets/images/home-hero-v1.png')}
            style={styles.heroImageActual}
            resizeMode="cover"
            accessibilityLabel="K Scan home hero image"
          />
        </View>
      </View>

      {/* Recent Scans */}
      {showRecentSection && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <SectionHeader title="RECENT SCANS" />
            {hasRecentScans && (
              <Pressable
                testID="home-luxury-view-all-scans"
                onPress={() => router.push('/library')}
                accessibilityRole="button"
              >
                <Text style={styles.viewAll}>View all ›</Text>
              </Pressable>
            )}
          </View>

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
                  testID={`home-luxury-recent-scan-${scan.id}`}
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

      {/* Style Picks — hook-driven with backend-safe placeholder states */}
      <View style={styles.section} testID="home-luxury-style-picks-section">
        <View style={styles.sectionHeaderRow}>
          <SectionHeader title="STYLE PICKS FOR YOU" />
          <Text style={styles.stylePicksSub}>Personalized by K Scan AI ✦</Text>
        </View>

        {stylePicksLoading ? (
          <View style={styles.stylePicksPlaceholder}>
            <ActivityIndicator size="small" color={LUXURY.colors.plum} />
            <Text style={styles.stylePicksPlaceholderBody}>
              Loading your style picks…
            </Text>
          </View>
        ) : stylePicksError ? (
          <View style={styles.stylePicksPlaceholder}>
            <Text style={styles.stylePicksPlaceholderTitle}>
              We couldn't load your style picks.
            </Text>
            <Text style={styles.stylePicksPlaceholderBody}>
              Please try again.
            </Text>
          </View>
        ) : hasStylePicks ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.recentScrollContent}
          >
            {picks.map((pick: StylePick) => (
              <View
                key={pick.id}
                style={styles.stylePickCard}
                testID={`home-luxury-style-pick-${pick.id}`}
              >
                <Text style={styles.stylePickTitle}>{pick.title}</Text>
                {pick.subtitle ? (
                  <Text style={styles.stylePickSubtitle}>{pick.subtitle}</Text>
                ) : null}
              </View>
            ))}
          </ScrollView>
        ) : (
          <View style={styles.stylePicksPlaceholder}>
            <Text style={styles.stylePicksPlaceholderTitle}>
              Style inspiration coming soon
            </Text>
            <Text style={styles.stylePicksPlaceholderBody}>
              {stylePicksStatus === 'backend_not_connected'
                ? 'Scan fashion inspiration to begin. Your personalized picks will appear here after recommendations are connected.'
                : 'Your saved ideas and AI-curated picks will appear here.'}
            </Text>
          </View>
        )}
      </View>

      {/* Feature explanation row */}
      {/* Static product education content — no backend integration required. */}
      <View style={styles.featuresRow}>
        <FeatureChip
          icon="✦"
          title="AI STYLIST"
          body="Smart style insights just for you."
          onPress={() => router.push('/style-chat')}
          testID="home-luxury-feature-stylechat"
          accessibilityLabel="Open AI Stylist"
          accessibilityHint="Navigate to StyleChat"
        />
        <FeatureChip
          icon="◈"
          title="VISUAL SEARCH"
          body="Scan anything. Find it instantly."
          onPress={() => router.push('/scan')}
          testID="home-luxury-feature-scan"
          accessibilityLabel="Open Visual Search"
          accessibilityHint="Navigate to the scan camera"
        />
        <FeatureChip
          icon="◇"
          title="SAVE & ORGANIZE"
          body="Save your favorites to your closet."
          onPress={() => router.push('/library')}
          testID="home-luxury-feature-library"
          accessibilityLabel="Open Closet"
          accessibilityHint="Navigate to your saved looks and closet"
        />
        <FeatureChip
          icon="◉"
          title="DRESSING ROOMS"
          body="Compare, save, and decide."
          onPress={() => router.push('/dressing-rooms')}
          testID="home-luxury-feature-dressing-rooms"
          accessibilityLabel="Open Dressing Rooms"
          accessibilityHint="Navigate to dressing rooms to compare outfits"
        />
      </View>

      {/* Secondary entry: TextScan if enabled */}
      {textScanEnabled && (
        <SecondaryButton
          testID="home-luxury-textscan"
          title="✧ TextScan"
          onPress={() => router.push('/text-scan')}
          accessibilityLabel="Open TextScan"
          accessibilityHint="Describe a look with text instead of the camera"
          style={styles.textScanButton}
        />
      )}

      {/* Trust footer */}
      <PrivacyFooter
        onPrivacyPress={() => router.push('/privacy')}
        trustCopy="Private by design. K Scan is not designed for facial recognition or identifying people."
        privacyTestID="home-luxury-privacy-button"
      />
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  avatarButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: LUXURY.colors.inverse,
    fontSize: 14,
    fontWeight: '600',
  },
  homeBrandMark: {
    textTransform: 'none',
    letterSpacing: 2,
  },
  heroCard: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.xl,
    marginBottom: SPACING.xxl,
    ...SHADOWS.editorialRaised,
    flexDirection: 'row',
    gap: SPACING.lg,
    alignItems: 'center',
  },
  heroText: {
    flex: 1,
    gap: SPACING.md,
  },
  heroHeadline: {
    ...LUXURY.typography.displayHeadline,
    fontSize: 28,
    lineHeight: 34,
    color: LUXURY.colors.ink,
  },
  heroHeadlineGold: {
    color: LUXURY.colors.goldBrushed,
  },
  heroBody: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 22,
    color: LUXURY.colors.graphite,
  },
  heroButton: {
    alignSelf: 'flex-start',
    minWidth: undefined,
    paddingHorizontal: SPACING.xl,
  },
  heroImage: {
    width: 140,
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: RADIUS.lg,
  },
  heroImageActual: {
    width: '100%',
    height: '100%',
  },
  section: {
    marginBottom: SPACING.xxl,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  viewAll: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.plum,
  },
  recentPlaceholder: {
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentScrollContent: {
    paddingRight: SPACING.lg,
  },
  stylePicksSub: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
  },
  stylePicksPlaceholder: {
    backgroundColor: LUXURY.colors.cream,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.xl,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  stylePicksPlaceholderTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 15,
    color: LUXURY.colors.ink,
    textAlign: 'center',
  },
  stylePicksPlaceholderBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
  stylePickCard: {
    width: 160,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    marginRight: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  stylePickTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  stylePickSubtitle: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  featuresRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
    marginBottom: SPACING.xxl,
  },
  chip: {
    flex: 1,
    minWidth: 140,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    alignItems: 'center',
    gap: SPACING.xs,
    ...SHADOWS.editorialSmall,
  },
  chipIcon: {
    fontSize: 20,
    color: LUXURY.colors.goldBrushed,
  },
  chipTitle: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 10,
    letterSpacing: 1.4,
    color: LUXURY.colors.ink,
    textAlign: 'center',
  },
  chipBody: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 16,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
  textScanButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
    marginBottom: SPACING.xl,
  },
});
