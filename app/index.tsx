import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';

export default function Home() {
  const { isAuthenticated, signOut } = useAuthSession();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const [signingOut, setSigningOut] = useState(false);
  const dressingRoomsEnabled = !featureFreezeLoading && isFeatureEnabled('dressingRooms');

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
    <View testID="router-home-screen" style={styles.container}>
      <StatusBar style="dark" />
      {isAuthenticated ? (
        <Pressable
          testID="home-logout-button"
          style={({ pressed }) => [
            styles.logoutButton,
            pressed ? styles.utilityPressed : null,
            signingOut ? styles.utilityDisabled : null,
          ]}
          onPress={handleSignOut}
          disabled={signingOut}
        >
          <Text style={styles.logoutText}>{signingOut ? 'LOGGING OUT' : 'LOG OUT'}</Text>
        </Pressable>
      ) : null}

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>SCAN-TO-CLOSET BETA</Text>
        <Text style={styles.title}>K SCAN AI</Text>
        <Text style={styles.subtitle}>See it. Say it. Get it. Shop in seconds.</Text>
      </View>

      <View style={styles.scanCard}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardKicker}>STYLE-PARSE ENGINE</Text>
          <View style={styles.statusPill}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>READY</Text>
          </View>
        </View>

        <Text style={styles.cardTitle}>Build your closet from the camera.</Text>
        <Text style={styles.cardBody}>
          Scan garments, review attributes, save the look, and keep your library commerce-ready.
        </Text>

        <Pressable
          testID="start-scan-button"
          style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
          onPress={() => router.push('/scan')}
        >
          <Text style={styles.buttonText}>START SCAN</Text>
        </Pressable>

        <Pressable
          testID="privacy-button"
          style={({ pressed }) => [styles.secondaryButton, pressed ? styles.secondaryPressed : null]}
          onPress={() => router.push('/privacy')}
        >
          <Text style={styles.secondaryButtonText}>PRIVACY CONTROL</Text>
        </Pressable>
      </View>

      {dressingRoomsEnabled ? (
        <View style={styles.roomsCard}>
          <Text style={styles.roomsLabel}>DRESSING ROOM</Text>
          <Text style={styles.roomsTitle}>Saved scans, room boards, and share flow.</Text>
          <Text style={styles.roomsBody}>
            Review saved scans, organize looks, and share room boards.
          </Text>

          <Pressable
            testID="open-dressing-room-button"
            style={({ pressed }) => [
              styles.roomsButton,
              pressed ? styles.roomsButtonPressed : null,
            ]}
            onPress={() => router.push('/dressing-rooms')}
          >
            <Text style={styles.roomsButtonText}>OPEN DRESSING ROOM</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.recentCard}>
        <Text style={styles.recentLabel}>CURRENT FOCUS</Text>
        <Text style={styles.recentTitle}>Scan-to-Closet</Text>
        <Text style={styles.recentBody}>Camera, AI tags, manual edits, and saved library flow.</Text>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: COLORS.canvasWarm,
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  logoutButton: {
    position: 'absolute',
    top: 58,
    right: 24,
    zIndex: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderSubtle,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
  },
  utilityPressed: {
    borderColor: COLORS.goldMuted,
    backgroundColor: COLORS.surfaceRaised,
  },
  utilityDisabled: {
    opacity: 0.58,
  },
  logoutText: {
    color: COLORS.editorialTextSecondary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  hero: {
    marginBottom: SPACING.xl,
  },
  eyebrow: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    marginBottom: SPACING.sm,
  },
  title: { 
    color: COLORS.editorialTextPrimary,
    fontSize: 34, 
    fontWeight: '900',
    letterSpacing: 2.4,
  },
  subtitle: { 
    color: COLORS.editorialTextSecondary,
    marginTop: 10,
    fontSize: 15,
    lineHeight: 22,
  },
  scanCard: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    ...SHADOWS.editorialRaised,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    marginBottom: SPACING.lg,
  },
  cardKicker: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
    flex: 1,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.success,
  },
  statusText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 28,
    color: COLORS.editorialTextPrimary,
  },
  cardBody: {
    marginTop: SPACING.sm,
    fontSize: 14,
    lineHeight: 22,
    color: COLORS.editorialTextSecondary,
  },
  button: {
    marginTop: SPACING.xl,
    borderRadius: 999,
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    backgroundColor: COLORS.gold,
  },
  buttonPressed: {
    backgroundColor: COLORS.goldPressed,
  },
  buttonText: {
    color: COLORS.textInverse,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  secondaryButton: {
    marginTop: SPACING.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderSubtle,
    borderRadius: 999,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    backgroundColor: COLORS.surfaceCard,
  },
  secondaryPressed: {
    backgroundColor: COLORS.surfaceRaised,
  },
  secondaryButtonText: {
    color: COLORS.editorialTextSecondary,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  recentCard: {
    marginTop: SPACING.lg,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  roomsCard: {
    marginTop: SPACING.lg,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  roomsLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 2.2,
    marginBottom: SPACING.xs,
  },
  roomsTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.editorialTextPrimary,
    lineHeight: 22,
  },
  roomsBody: {
    marginTop: SPACING.xs,
    fontSize: 13,
    lineHeight: 20,
    color: COLORS.editorialTextSecondary,
  },
  roomsButton: {
    marginTop: SPACING.md,
    minHeight: 44,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  roomsButtonPressed: {
    backgroundColor: COLORS.surfaceRaised,
  },
  roomsButtonText: {
    color: COLORS.editorialTextPrimary,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  recentLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    marginBottom: SPACING.xs,
  },
  recentTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.editorialTextPrimary,
  },
  recentBody: {
    marginTop: SPACING.xs,
    fontSize: 13,
    lineHeight: 19,
    color: COLORS.editorialTextSecondary,
  },
});
