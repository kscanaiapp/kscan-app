import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  PrivacyFooter,
} from '../components/luxury';
import { COLORS, LUXURY, RADIUS, SHADOWS, SPACING } from '../constants/theme';
import { TEXTSCAN_UI_ENABLED } from '../constants/featureFlags';

export default function Home() {
  const { isAuthenticated, signOut, user, loading } = useAuthSession();
  const [signingOut, setSigningOut] = useState(false);
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const textScanEnabled =
    TEXTSCAN_UI_ENABLED && !featureFreezeLoading && isFeatureEnabled('textScan');

  const meta = user?.user_metadata as Record<string, string | undefined> | undefined;
  const profileName =
    (meta?.full_name ?? meta?.name ?? meta?.display_name ?? '').trim() || null;

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
      router.replace('/auth');
    }
  };

  return (
    <LuxuryScreen
      testID="router-home-screen"
      backgroundColor={LUXURY.colors.ivory}
      scrollable
      safeArea
      accessibilityLabel="K Scan Home"
    >
      <StatusBar style="dark" />

      <KScanHeader
        showBrandMark
        subtitle="PRIVATE FASHION INTELLIGENCE"
        rightAction={
          isAuthenticated ? (
            <Pressable
              testID="home-logout-button"
              onPress={handleSignOut}
              disabled={signingOut}
              style={({ pressed }) => [
                styles.logoutButton,
                pressed && styles.logoutButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={signingOut ? 'Logging out' : 'Log out'}
              accessibilityState={{ disabled: signingOut, busy: signingOut }}
            >
              <Text style={[styles.logoutText, signingOut && styles.logoutTextDisabled]}>
                {signingOut ? '…' : 'Log Out'}
              </Text>
            </Pressable>
          ) : undefined
        }
      />

      {/* Hero greeting */}
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>See it. Scan it.{'\n'}Style it.</Text>
        {!loading ? (
          <Text
            style={styles.greeting}
            accessibilityLabel={`Welcome, ${profileName ?? 'K Scanner'}`}
          >
            {`Welcome, ${profileName ?? 'K Scanner'}`}
          </Text>
        ) : null}
      </View>

      {/* Scan Now hero CTA */}
      <View style={styles.scanHero}>
        <Text style={styles.scanHeroLabel}>START YOUR STYLE JOURNEY</Text>
        <Text style={styles.scanHeroBody}>
          Point your camera at any fashion item to discover matches, style notes,
          and where to shop.
        </Text>
        <PrimaryButton
          testID="start-scan-button"
          title="Scan Now"
          onPress={() => router.push('/scan')}
          accessibilityLabel="Start a scan"
          accessibilityHint="Opens the camera to scan a fashion item"
          style={styles.scanButton}
        />
        {textScanEnabled && (
          <SecondaryButton
            testID="home-textscan-entry-button"
            title="✧ TextScan"
            onPress={() => router.push('/text-scan')}
            accessibilityLabel="Open TextScan"
            accessibilityHint="Describe a fashion item with text instead of the camera"
            style={styles.textScanHomeButton}
          />
        )}
      </View>

      {/* Feature cards */}
      <SectionHeader title="Your Style Space" />

      <View style={styles.featureGrid}>
        <Pressable
          testID="open-library-button"
          onPress={() => router.push('/library')}
          style={({ pressed }) => [styles.featureCard, pressed && styles.featureCardPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open Style Library"
        >
          <View style={styles.featureCardHeader}>
            <Text style={styles.featureIcon}>◈</Text>
            <Text style={styles.betaPill}>SAVED</Text>
          </View>
          <Text style={styles.featureTitle}>Style Library</Text>
          <Text style={styles.featureBody}>
            Saved scans and inspiration in one place.
          </Text>
        </Pressable>

        <Pressable
          testID="open-dressing-room-button"
          onPress={() => router.push('/dressing-rooms')}
          style={({ pressed }) => [styles.featureCard, pressed && styles.featureCardPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open Dressing Rooms"
        >
          <View style={styles.featureCardHeader}>
            <Text style={styles.featureIcon}>◇</Text>
            <View style={styles.betaBadge}>
              <Text style={styles.betaBadgeText}>BETA</Text>
            </View>
          </View>
          <Text style={styles.featureTitle}>Dressing Rooms</Text>
          <Text style={styles.featureBody}>
            Build and share style boards with friends.
          </Text>
        </Pressable>
      </View>

      {/* StyleChat card */}
      <Pressable
        testID="style-chat-entry-card"
        onPress={() => router.push('/style-chat')}
        style={({ pressed }) => [styles.styleChatCard, pressed && styles.styleChatCardPressed]}
        accessibilityRole="button"
        accessibilityLabel="Ask StyleChat"
      >
        <View style={styles.styleChatRow}>
          <View style={styles.styleChatText}>
            <Text style={styles.styleChatLabel}>ASK STYLECHAT</Text>
            <Text style={styles.styleChatBody}>
              Style a scan, compare looks, or choose from a Dressing Room.
            </Text>
          </View>
          <View style={styles.styleChatSparkle}>
            <Text style={styles.sparkleText}>✦</Text>
          </View>
        </View>
      </Pressable>

      {/* Trust footer */}
      <PrivacyFooter
        onPrivacyPress={() => router.push('/privacy')}
        trustCopy="Private by design. Your data stays under your control."
        privacyTestID="privacy-button"
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
  greeting: {
    ...LUXURY.typography.body,
    marginTop: SPACING.sm,
    color: LUXURY.colors.graphite,
  },
  logoutButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  logoutButtonPressed: {
    opacity: 0.6,
  },
  logoutText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textTransform: 'none',
    letterSpacing: 0.5,
  },
  logoutTextDisabled: {
    opacity: 0.5,
  },

  scanHero: {
    backgroundColor: LUXURY.colors.cream,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.xl,
    marginBottom: SPACING.xxl,
    ...SHADOWS.editorialRaised,
  },
  scanHeroLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom: SPACING.sm,
  },
  scanHeroBody: {
    ...LUXURY.typography.body,
    marginBottom: SPACING.xl,
  },
  scanButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
  },
  textScanHomeButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
    marginTop: SPACING.md,
    height: 48,
  },

  featureGrid: {
    flexDirection: 'row',
    gap: SPACING.lg,
    marginBottom: SPACING.lg,
  },
  featureCard: {
    flex: 1,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    minHeight: 160,
    ...SHADOWS.editorialSmall,
  },
  featureCardPressed: {
    backgroundColor: LUXURY.colors.champagne,
    borderColor: LUXURY.colors.goldLight,
  },
  featureCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  featureIcon: {
    fontSize: 24,
    color: LUXURY.colors.goldBrushed,
  },
  betaPill: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.2,
    color: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.plumMuted,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    overflow: 'hidden',
  },
  betaBadge: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  betaBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: LUXURY.colors.goldText,
  },
  featureTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 16,
    marginBottom: SPACING.xs,
  },
  featureBody: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
  },

  styleChatCard: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  styleChatCardPressed: {
    backgroundColor: LUXURY.colors.champagne,
    borderColor: LUXURY.colors.goldLight,
  },
  styleChatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  styleChatText: {
    flex: 1,
    marginRight: SPACING.md,
  },
  styleChatLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom: SPACING.xs,
  },
  styleChatBody: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 22,
  },
  styleChatSparkle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: LUXURY.colors.plumMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sparkleText: {
    fontSize: 20,
    color: LUXURY.colors.plum,
  },
});
