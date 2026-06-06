import { useState } from 'react';
import { SafeAreaView, ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';

export default function Home() {
  const { isAuthenticated, signOut, user, loading } = useAuthSession();
  const [signingOut, setSigningOut] = useState(false);

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
    <SafeAreaView testID="router-home-screen" style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 1–3. Brand, tagline, greeting */}
        <View style={styles.hero}>
          <Text style={styles.title}>K SCAN AI</Text>
          <Text style={styles.tagline}>See it. Scan it.{'\n'}Style it.</Text>
          {!loading ? (
            <Text
              style={styles.greeting}
              accessibilityLabel={`Welcome, ${profileName ?? 'K Scanner'}`}
            >
              {`Welcome, ${profileName ?? 'K Scanner'}`}
            </Text>
          ) : null}
        </View>

        {/* 4. SCAN NOW — full-width gold CTA */}
        <Pressable
          testID="start-scan-button"
          style={({ pressed }) => [styles.scanNowCard, pressed ? styles.scanNowPressed : null]}
          onPress={() => router.push('/scan')}
          accessibilityLabel="Scan Now"
          accessibilityRole="button"
        >
          <Text style={styles.scanNowText}>SCAN NOW</Text>
        </Pressable>

        {/* 5. Resume placeholder — hidden for Beta 4.2 */}

        {/* 6. Dressing Rooms */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardLabel}>DRESSING ROOMS</Text>
            <View style={styles.betaBadge}>
              <Text style={styles.betaBadgeText}>BETA</Text>
            </View>
          </View>
          <Text style={styles.cardBody}>Build and share style boards.</Text>
          <Pressable
            testID="open-dressing-room-button"
            style={({ pressed }) => [styles.cardButton, pressed ? styles.cardButtonPressed : null]}
            onPress={() => router.push('/dressing-rooms')}
          >
            <Text style={styles.cardButtonText}>OPEN ROOMS</Text>
          </Pressable>
        </View>

        {/* 7. Style Library */}
        <View style={[styles.card, styles.cardMuted]}>
          <Text style={styles.cardLabel}>STYLE LIBRARY</Text>
          <Text style={styles.cardBody}>Saved scans and inspiration.</Text>
          <Pressable
            testID="open-library-button"
            style={({ pressed }) => [styles.cardButton, pressed ? styles.cardButtonPressed : null]}
            onPress={() => router.push('/library')}
          >
            <Text style={styles.cardButtonText}>OPEN LIBRARY</Text>
          </Pressable>
        </View>

        {/* 8. Privacy / Log Out */}
        <View style={styles.footerLinks}>
          <Pressable
            testID="privacy-button"
            style={({ pressed }) => [styles.footerLink, pressed ? styles.footerLinkPressed : null]}
            onPress={() => router.push('/privacy')}
          >
            <Text style={styles.footerLinkText}>Privacy</Text>
          </Pressable>
          {isAuthenticated ? (
            <Pressable
              testID="home-logout-button"
              style={({ pressed }) => [styles.footerLink, pressed ? styles.footerLinkPressed : null]}
              onPress={handleSignOut}
              disabled={signingOut}
            >
              <Text style={[styles.footerLinkText, signingOut ? styles.footerLinkDisabled : null]}>
                {signingOut ? 'Logging Out…' : 'Log Out'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.canvasWarm,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: SPACING.xl,
    paddingTop: 56,
    paddingBottom: 60,
  },

  // ── Hero ──────────────────────────────────────────────────────────────────
  hero: {
    marginBottom: SPACING.xl,
  },
  title: {
    color: COLORS.editorialTextPrimary,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 2.4,
  },
  tagline: {
    color: COLORS.editorialTextSecondary,
    marginTop: 10,
    fontSize: 22,
    fontWeight: '300',
    lineHeight: 30,
    letterSpacing: 0.2,
  },
  greeting: {
    fontSize: 15,
    fontWeight: '400',
    color: COLORS.editorialTextMuted,
    marginTop: 12,
  },

  // ── SCAN NOW ──────────────────────────────────────────────────────────────
  scanNowCard: {
    borderRadius: RADIUS.lg,
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    backgroundColor: COLORS.gold,
    ...SHADOWS.editorialRaised,
    marginBottom: SPACING.lg,
  },
  scanNowPressed: {
    backgroundColor: COLORS.goldPressed,
  },
  scanNowText: {
    color: COLORS.textInverse,
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 3,
    textTransform: 'uppercase',
  },

  // ── Cards ─────────────────────────────────────────────────────────────────
  card: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  cardMuted: {
    backgroundColor: COLORS.surfaceRaised,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  cardLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 2.2,
  },
  betaBadge: {
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.goldMuted,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  betaBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: COLORS.goldPressed,
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 21,
    color: COLORS.editorialTextSecondary,
    marginBottom: SPACING.md,
  },
  cardButton: {
    minHeight: 44,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  cardButtonPressed: {
    backgroundColor: COLORS.borderSubtle,
  },
  cardButtonText: {
    color: COLORS.editorialTextPrimary,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footerLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: SPACING.xl,
    paddingTop: SPACING.lg,
  },
  footerLink: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerLinkPressed: {
    opacity: 0.6,
  },
  footerLinkText: {
    color: COLORS.editorialTextMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  footerLinkDisabled: {
    opacity: 0.5,
  },
});
