import React from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Linking,
  ViewStyle,
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
import { KScanIcon } from '../icons/kscan';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { TEXTSCAN_UI_ENABLED, VOICESCAN_ENABLED } from '../../constants/featureFlags';
import { StylistGreetingCard } from './StylistGreetingCard';


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
  icon: React.ReactNode;
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
      <View
        style={styles.chipIconWrap}
        accessible={false}
        importantForAccessibility="no"
        accessibilityElementsHidden
      >
        {icon}
      </View>
      <Text style={styles.chipTitle}>{title}</Text>
      <Text style={styles.chipBody}>{body}</Text>
    </Pressable>
  );
}

/**
 * Inactive VoiceScan placeholder pill.
 *
 * VoiceScan is planned but inactive for the current launch. This pill is
 * intentionally visible so users know the feature is coming, but it is a
 * silent no-op: no navigation, no microphone request, no backend call, and
 * no local state mutation.
 */
interface VoiceScanPlaceholderPillProps {
  style?: ViewStyle;
}

function VoiceScanPlaceholderPill({ style }: VoiceScanPlaceholderPillProps) {
  const inactive = !VOICESCAN_ENABLED;
  return (
    <View
      testID="home-luxury-voicescan-coming-soon"
      style={[styles.voiceScanPill, inactive && styles.voiceScanPillInactive, style]}
      accessibilityRole="text"
      accessibilityLabel="Voice Scan. Coming Soon."
    >
      <Text style={[styles.voiceScanPillTitle, inactive && styles.voiceScanPillTextMuted]}>
        VOICE SCAN
      </Text>
      <Text style={[styles.voiceScanPillSubtitle, inactive && styles.voiceScanPillTextMuted]}>
        COMING SOON
      </Text>
    </View>
  );
}

/**
 * Bright luxury Home dashboard (HomeLuxuryTechV1).
 *
 * Matches the home-page-v1 mockup direction without fake commerce:
 * - Hero with "See it. Scan it. Style it." and fashion placeholder
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
  const styleChatEnabled = !featureFreezeLoading && isFeatureEnabled('styleChat');

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

      {/* Stylist greeting — replaces the static welcome with an animated card */}
      {styleChatEnabled && (
        <StylistGreetingCard
          actorKey={user?.id ?? 'guest'}
          testID="home-stylist-greeting-card"
        />
      )}

      {/* Hero Section */}
      <View style={styles.heroCard}>
        <View style={styles.heroText}>
          <Text style={styles.heroHeadline} accessibilityRole="header">
            See it.{'\n'}Scan it.{' '}
            <Text style={styles.heroHeadlineGold}>Style it.</Text>
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
            <View style={styles.recentScansHeading}>
              <View
                style={styles.recentScansIcon}
                accessible={false}
                importantForAccessibility="no"
                accessibilityElementsHidden
              >
                <KScanIcon name="recent-scans" size={22} variant="compact" />
              </View>
              <SectionHeader title="RECENT SCANS" style={styles.sectionHeaderTitle} />
            </View>
            {hasRecentScans && (
              <Pressable
                testID="home-luxury-view-all-scans"
                onPress={() => router.push('/library')}
                accessibilityRole="button"
                style={styles.sectionHeaderAction}
              >
                <Text
                  style={styles.viewAll}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  View all ›
                </Text>
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
        <SectionHeader title="STYLE PICKS FOR YOU" />

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
          icon={<KScanIcon name="style" size={28} variant="standard" />}
          title="AI STYLIST"
          body="Smart style insights just for you."
          onPress={() => router.push('/style-chat')}
          testID="home-luxury-feature-stylechat"
          accessibilityLabel="Open AI Stylist"
          accessibilityHint="Navigate to StyleChat"
        />
        <FeatureChip
          icon={<KScanIcon name="visual-search" size={28} variant="standard" />}
          title="VISUAL SEARCH"
          body="Scan anything. Find it instantly."
          onPress={() => router.push('/scan')}
          testID="home-luxury-feature-scan"
          accessibilityLabel="Open Visual Search"
          accessibilityHint="Navigate to the scan camera"
        />
        <FeatureChip
          icon={<KScanIcon name="save-organize" size={28} variant="standard" />}
          title="SAVE & ORGANIZE"
          body="Save your favorites to your closet."
          onPress={() => router.push('/library')}
          testID="home-luxury-feature-library"
          accessibilityLabel="Open Closet"
          accessibilityHint="Navigate to your saved looks and closet"
        />
        <FeatureChip
          icon={<KScanIcon name="dressing-rooms" size={28} variant="standard" />}
          title="DRESSING ROOMS"
          body="Compare, save, and decide."
          onPress={() => router.push('/dressing-rooms')}
          testID="home-luxury-feature-dressing-rooms"
          accessibilityLabel="Open Dressing Rooms"
          accessibilityHint="Navigate to dressing rooms to compare outfits"
        />
      </View>

      {/* Secondary entries: TextScan if enabled, VoiceScan placeholder */}
      <View style={styles.secondaryActionsRow}>
        {textScanEnabled && (
          <SecondaryButton
            testID="home-luxury-textscan"
            title="TextScan"
            icon={<KScanIcon name="textscan" size={20} variant="compact" />}
            onPress={() => router.push('/text-scan')}
            accessibilityLabel="Open TextScan"
            accessibilityHint="Describe a look with text instead of the camera"
            style={styles.secondaryActionButton}
          />
        )}
        <VoiceScanPlaceholderPill style={textScanEnabled ? styles.secondaryActionHalf : styles.secondaryActionFull} />
      </View>

      {/* Trust footer */}
      <PrivacyFooter
        onPrivacyPress={() => router.push('/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
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
  greeting: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 16,
    color: LUXURY.colors.ink,
    marginTop: -SPACING.md,
    marginBottom: SPACING.lg,
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
    gap: SPACING.sm,
  },
  recentScansHeading: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  recentScansIcon: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionHeaderTitle: {
    flex: 1,
    minWidth: 0,
    marginBottom: 0,
    paddingTop: 0,
  },
  sectionHeaderAction: {
    flexShrink: 0,
    minHeight: 44,
    justifyContent: 'center',
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
  chipIconWrap: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
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
  secondaryActionsRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: SPACING.xl,
  },
  secondaryActionButton: {
    flex: 1,
    alignSelf: 'stretch',
    minWidth: undefined,
  },
  secondaryActionHalf: {
    flex: 1,
  },
  secondaryActionFull: {
    flex: 1,
  },
  voiceScanPill: {
    alignSelf: 'stretch',
    minHeight: 44,
    borderRadius: LUXURY.buttons.secondary.borderRadius,
    backgroundColor: LUXURY.buttons.secondary.backgroundColor,
    borderWidth: LUXURY.buttons.secondary.borderWidth,
    borderColor: LUXURY.buttons.secondary.borderColor,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  voiceScanPillInactive: {
    opacity: 0.5,
    borderColor: LUXURY.colors.border,
  },
  voiceScanPillTitle: {
    ...LUXURY.typography.cta,
    fontSize: LUXURY.buttons.secondary.fontSize,
    letterSpacing: LUXURY.buttons.secondary.letterSpacing,
    fontWeight: LUXURY.buttons.secondary.fontWeight,
    color: LUXURY.buttons.secondary.color,
    textAlign: 'center',
  },
  voiceScanPillSubtitle: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 0.5,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  voiceScanPillTextMuted: {
    color: LUXURY.colors.stone,
  },
});
