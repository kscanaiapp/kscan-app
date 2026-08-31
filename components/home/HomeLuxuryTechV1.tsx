import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useStylePicks } from '../../hooks/useStylePicks';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { useStyleChatSessions } from '../../hooks/useStyleChatSessions';
import {
  createStyleChatSessionLaunchGuard,
  launchStyleChatSession,
} from '../../services/style-chat/sessionLaunchGuard';
import { resolvePreferredName } from '../../services/userFirstName';
import type { StylePick } from '../../types/stylePicks';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  PrivacyFooter,
  StatusPill,
} from '../../components/luxury';
import { KScanIcon } from '../icons/kscan';
import { HomeStylistCard } from './HomeStylistCard';
import { TodayWithEliseSection } from './TodayWithEliseSection';
import { PersonalizeStylistModal } from '../stylist/PersonalizeStylistModal';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { PACKING_INTELLIGENCE_V1, SMART_WATCHLIST_V1, TEXTSCAN_UI_ENABLED } from '../../constants/featureFlags';
import { KPlusGate } from '../kplus/KPlusGate';


interface FeatureChipProps {
  icon: React.ReactNode;
  title: string;
  body: string;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  children?: React.ReactNode;
}

function FeatureChip({ icon, title, body, onPress, testID, accessibilityLabel, accessibilityHint, children }: FeatureChipProps) {
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
      {children}
    </Pressable>
  );
}

/**
 * Bright luxury Home dashboard (HomeLuxuryTechV1).
 *
 * Matches the home-page-v1 mockup direction without fake commerce:
 * - Hero with "See it. Scan it. Style it." and fashion placeholder
 * - Start Scan primary CTA
 * - Unified "Your Stylist / Ask Elise" section
 * - Feature grid with Recent Scans routing to the canonical library
 * - TextScan secondary entry
 * - Trust footer
 */
export default function HomeLuxuryTechV1() {
  const { isAuthenticated, user, loading: authLoading } = useAuthSession();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { picks, isLoading: stylePicksLoading, error: stylePicksError } = useStylePicks();
  const { identity, isLoading: identityLoading, error: identityError, updateIdentity, resetIdentity } = useStylistIdentity();
  const { createSession, getLatestSessionId } = useStyleChatSessions();

  const [personalizeVisible, setPersonalizeVisible] = useState(false);
  const [textScanNavigating, setTextScanNavigating] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [sessionLaunchError, setSessionLaunchError] = useState<string | null>(null);
  const textScanNavigationInFlightRef = useRef(false);
  const screenActiveRef = useRef(false);
  const actorIdRef = useRef(user?.id ?? null);
  actorIdRef.current = user?.id ?? null;
  const sessionLaunchGuardRef = useRef<ReturnType<
    typeof createStyleChatSessionLaunchGuard
  > | null>(null);
  if (!sessionLaunchGuardRef.current) {
    sessionLaunchGuardRef.current = createStyleChatSessionLaunchGuard();
  }

  const textScanEnabled =
    TEXTSCAN_UI_ENABLED && !featureFreezeLoading && isFeatureEnabled('textScan');
  const scanEnabled = !featureFreezeLoading && isFeatureEnabled('scan');
  const styleChatEnabled = !featureFreezeLoading && isFeatureEnabled('styleChat');
  const packingEnabled = PACKING_INTELLIGENCE_V1;
  const watchlistEnabled = SMART_WATCHLIST_V1;

  const preferredName = resolvePreferredName(user);

  const hasStylePicks = picks.length > 0;
  // Nothing to show: not loading, no error, and no real picks. Render the
  // section only when there is genuinely something to render — a spinner, an
  // error, or real data — never an empty placeholder card.
  const showStylePicks = stylePicksLoading || Boolean(stylePicksError) || hasStylePicks;

  const handleOpenStyleChat = useCallback(() => {
    router.push('/style-chat');
  }, []);

  const handleStartConversation = useCallback(async () => {
    const guard = sessionLaunchGuardRef.current;
    if (!guard) return;
    const launchActorId = actorIdRef.current;
    if (!launchActorId) {
      setSessionLaunchError('Sign in to start a styling conversation.');
      return;
    }
    setSessionLaunchError(null);
    setIsCreatingSession(true);
    const result = await launchStyleChatSession({
      guard,
      createSession,
      // Home's stylist CTA continues the user's conversation; only a user with
      // no conversation at all gets a new one. Creating unconditionally here
      // stranded every prior conversation behind a fresh empty session, which
      // read as the history having been lost. Explicitly starting another
      // conversation remains available on the conversations list.
      resolveExistingSessionId: getLatestSessionId,
      navigate: (sessionId) => router.push(`/style-chat/${sessionId}`),
      isCurrent: () => screenActiveRef.current && actorIdRef.current === launchActorId,
    });
    if (result.status === 'ignored') return;
    if (result.status === 'failed') {
      console.error('Start conversation failed', result.error);
      if (screenActiveRef.current) {
        setSessionLaunchError("We couldn't start a conversation. Please try again.");
      }
    }
    if (screenActiveRef.current) setIsCreatingSession(false);
  }, [createSession, getLatestSessionId]);

  const handlePersonalize = useCallback(() => {
    setPersonalizeVisible(true);
  }, []);

  const handleClosePersonalize = useCallback(() => {
    setPersonalizeVisible(false);
  }, []);

  const handleSaveIdentity = useCallback(
    async (next: { displayName?: string; avatarId?: string }) => {
      const didSave = await updateIdentity(next);
      if (didSave) setPersonalizeVisible(false);
      return didSave;
    },
    [updateIdentity],
  );

  const handleResetIdentity = useCallback(async () => {
    const didReset = await resetIdentity();
    if (didReset) setPersonalizeVisible(false);
    return didReset;
  }, [resetIdentity]);

  useFocusEffect(
    useCallback(() => {
      screenActiveRef.current = true;
      textScanNavigationInFlightRef.current = false;
      setTextScanNavigating(false);
      sessionLaunchGuardRef.current?.resetOnFocus();
      setIsCreatingSession(false);
      return () => {
        screenActiveRef.current = false;
      };
    }, []),
  );

  const handleOpenTextScan = useCallback(() => {
    if (textScanNavigationInFlightRef.current) return;
    textScanNavigationInFlightRef.current = true;
    setTextScanNavigating(true);
    try {
      router.push('/text-scan');
    } catch (error) {
      textScanNavigationInFlightRef.current = false;
      setTextScanNavigating(false);
      throw error;
    }
  }, []);

  return (
    <LuxuryScreen
      testID="home-luxury-tech-v1-screen"
      backgroundColor={LUXURY.colors.ivory}
      scrollable
      safeArea
      accessibilityLabel="K Scan AI Home"
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
                  {preferredName ? preferredName.charAt(0).toUpperCase() : '✦'}
                </Text>
              </View>
            </Pressable>
          ) : undefined
        }
      />

      {/* Greeting */}
      {isAuthenticated && (
        <Text
          style={styles.greeting}
          accessibilityLabel={`Welcome, ${preferredName ?? 'K Scanner'}`}
        >
          {`Welcome, ${preferredName ?? 'K Scanner'}`}
        </Text>
      )}

      {/* Hero Section */}
      <View style={styles.heroCard}>
        <View style={styles.heroText}>
          <Text style={styles.heroHeadline} accessibilityRole="header">
            See it.{ '\n'}Scan it.{' '}
            <Text style={styles.heroHeadlineGold}>Style it.</Text>
          </Text>
          <Text style={styles.heroBody}>
            Instantly discover style inspiration and shop what you love.
          </Text>
          <PrimaryButton
            testID="home-luxury-start-scan"
            title="START SCAN"
            icon={
              <KScanIcon
                name="visual-search"
                size={20}
                variant="compact"
                color={LUXURY.colors.inverse}
                accentColor={LUXURY.colors.goldChampagne}
              />
            }
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
            accessibilityLabel="K Scan AI home hero image"
          />
        </View>
      </View>

      {/* Your Stylist */}
      {styleChatEnabled && (
        <HomeStylistCard
          identity={identity}
          onStartConversation={handleStartConversation}
          onOpenConversations={handleOpenStyleChat}
          onPersonalize={handlePersonalize}
          disabled={isCreatingSession}
          startError={sessionLaunchError}
        />
      )}

      {/*
        Today with Elise (Build 5). ADDITIVE: it sits below the existing Elise
        introduction and above the first existing recommendation section, so it
        is the first actionable recommendation on Home without displacing the
        Scan hero, the stylist card, or anything below it. Renders nothing at
        all while EXPO_PUBLIC_TODAY_WITH_ELISE_V1 is off.
      */}
      <TodayWithEliseSection />

      {/*
        Style Picks — hook-driven with real loading/error/data states. Renders
        nothing at all when there are no real picks and nothing is loading or
        erroring, rather than an empty placeholder card.
      */}
      {showStylePicks && (
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
          ) : (
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
          )}
        </View>
      )}

      {/* Feature explanation row */}
      {/* Static product education content — no backend integration required. */}
      <View style={styles.featuresRow}>
        <FeatureChip
          icon={<KScanIcon name="recent-scans" size={24} variant="standard" />}
          title="RECENT SCANS"
          body="Open your scan history."
          onPress={() => router.push({ pathname: '/library', params: { section: 'recent' } })}
          testID="home-luxury-feature-recent-scans"
          accessibilityLabel="Recent Scans"
          accessibilityHint="Navigate to your scan history"
        />
        <FeatureChip
          icon={<KScanIcon name="visual-search" size={24} variant="standard" />}
          title="VISUAL SEARCH"
          body="Scan anything. Find it instantly."
          onPress={() => router.push('/scan')}
          testID="home-luxury-feature-scan"
          accessibilityLabel="Open Visual Search"
          accessibilityHint="Navigate to the scan camera"
        />
        <FeatureChip
          icon={<KScanIcon name="save-organize" size={24} variant="standard" />}
          title="CLOSET"
          body="Save your favorites to your closet."
          onPress={() => router.push({ pathname: '/library', params: { section: 'closet' } })}
          testID="home-luxury-feature-library"
          accessibilityLabel="Open Closet"
          accessibilityHint="Navigate to your saved looks and closet"
        />
        <FeatureChip
          icon={<KScanIcon name="dressing-rooms" size={24} variant="standard" />}
          title="DRESSING ROOMS"
          body="Compare, save, and decide."
          onPress={() => router.push('/dressing-rooms')}
          testID="home-luxury-feature-dressing-rooms"
          accessibilityLabel="Open Dressing Rooms"
          accessibilityHint="Navigate to dressing rooms to compare outfits"
        />
        {/* K+ Packing Intelligence. The chip is shown to everyone when the
            feature is built in: the K+ gate lives on the screen itself, and
            hiding the entry entirely would make a premium capability
            undiscoverable to the people it is for. */}
        {packingEnabled && (
          <FeatureChip
            icon={<KScanIcon name="style" size={24} variant="standard" />}
            title="PACK FOR A TRIP"
            body="Packed from what you already own."
            onPress={() => router.push('/packing')}
            testID="home-luxury-feature-packing"
            accessibilityLabel="Pack for a trip"
            accessibilityHint="Build a packing plan from the clothes in your Closet"
          />
        )}
      </View>

      {/* Secondary entries: TextScan when enabled, Smart Watchlist (K+) */}
      <View style={styles.secondaryActionsRow}>
        {textScanEnabled && (
          <SecondaryButton
            testID="home-luxury-textscan"
            title="TEXTSCAN"
            icon={<KScanIcon name="textscan" size={24} variant="standard" />}
            onPress={handleOpenTextScan}
            loading={textScanNavigating}
            disabled={textScanNavigating}
            accessibilityLabel="Open TextScan"
            accessibilityHint="Describe a look with text instead of the camera"
            style={styles.secondaryActionButton}
          />
        )}
        {/* INT-KPLUS-005: availability first, entitlement second. K+ says the
            user is ALLOWED to use Watchlist; SMART_WATCHLIST_V1 says it EXISTS
            in this build/environment. Gating on entitlement alone rendered a
            live tile pointing at a screen whose server seam is not deployed. */}
        {watchlistEnabled && (
          <KPlusGate source="watchlist">
            {({ isActive, openUpgrade }) => (
              <SecondaryButton
                testID="home-luxury-watchlist"
                title="WATCHLIST"
                icon={<KScanIcon name="watchlist" size={24} variant="standard" />}
                onPress={() => (isActive ? router.push('/watchlist') : openUpgrade())}
                accessibilityLabel="Open Smart Watchlist"
                accessibilityHint="Track prices on listings you're not ready to buy yet"
                style={styles.secondaryActionButton}
              />
            )}
          </KPlusGate>
        )}
      </View>

      {/* Trust footer */}
      <PrivacyFooter
        onPrivacyPress={() => router.push('/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
        trustCopy="Private by design. K Scan AI is not designed for facial recognition or identifying people."
        privacyTestID="home-luxury-privacy-button"
      />

      <PersonalizeStylistModal
        visible={personalizeVisible}
        identity={identity}
        onClose={handleClosePersonalize}
        onSave={handleSaveIdentity}
        onRestoreDefault={handleResetIdentity}
        isSaving={identityLoading}
        error={identityError}
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
});
