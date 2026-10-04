// Home's Try It On introduction.
//
// A small, dismissible card that tells a customer Virtual Try-On exists and
// sends them into the ordinary Scanner journey to find something to try on.
// It is education, not an entry point: Home has no product, so there is
// nothing here to try on, and the card never opens the try-on sheet, a photo
// chooser or a camera. The first place a try-on can begin is an eligible
// item's own Try It On control.
//
// Whether it renders at all is decided by services/vto/vtoDiscovery.ts
// (resolveVtoHomeCard) from this account's own history: it is shown until it
// is dismissed or until the customer opens a try-on, and never again after.
import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { router } from 'expo-router';

import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { useVtoHomeCard } from '../../hooks/useVtoAwareness';
import { selectionTick } from '../../services/haptics';
import { VTO_DISCOVERY_COPY as COPY } from '../../services/vto/vtoDiscovery';
import { KScanIcon } from '../icons/kscan';
import { KPlusMarkerBadge } from '../kplus/KPlusMarkerBadge';

export interface HomeVtoDiscoveryCardProps {
  style?: ViewStyle;
}

export function HomeVtoDiscoveryCard({ style }: HomeVtoDiscoveryCardProps) {
  const { visible, kplus, notePrimaryTap, dismiss } = useVtoHomeCard();

  const handleScan = useCallback(() => {
    selectionTick();
    notePrimaryTap();
    router.push('/scan');
  }, [notePrimaryTap]);

  const handleDismiss = useCallback(() => {
    selectionTick();
    dismiss();
  }, [dismiss]);

  if (!visible) return null;

  return (
    <View style={[styles.card, style]} testID="home-vto-discovery-card">
      <View style={styles.headerRow}>
        <View
          style={styles.iconTile}
          accessible={false}
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          <KScanIcon name="try-on" size={24} variant="standard" />
        </View>
        <View style={styles.copy}>
          <View style={styles.titleRow}>
            <Text style={styles.title} accessibilityRole="header">
              {COPY.title}
            </Text>
            {/* RESOLVING != FREE: no marker until the K+ answer is known. */}
            {kplus !== 'resolving' ? (
              <KPlusMarkerBadge
                state={kplus === 'free' ? 'locked' : 'included'}
                testID="home-vto-discovery-kplus-badge"
              />
            ) : null}
          </View>
          <Text style={styles.body}>{COPY.homeBody}</Text>
        </View>
        <Pressable
          onPress={handleDismiss}
          style={({ pressed }) => [styles.dismiss, pressed && styles.dismissPressed]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={COPY.homeDismissA11y}
          testID="home-vto-discovery-dismiss"
        >
          <View style={styles.dismissCircle}>
            <Text style={styles.dismissGlyph}>×</Text>
          </View>
        </Pressable>
      </View>
      <Pressable
        onPress={handleScan}
        style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
        accessibilityRole="button"
        accessibilityLabel={COPY.homePrimaryA11y}
        accessibilityHint={COPY.homePrimaryHint}
        testID="home-vto-discovery-scan"
      >
        <Text style={styles.primaryText}>{COPY.homePrimary}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.lg,
    gap: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
  },
  iconTile: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    flex: 1,
    gap: SPACING.xs,
  },
  titleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    lineHeight: 26,
    color: LUXURY.colors.ink,
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 13.5,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  dismiss: {
    minWidth: 44,
    minHeight: 44,
    marginTop: -SPACING.sm,
    marginRight: -SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissPressed: {
    opacity: 0.6,
  },
  dismissCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissGlyph: {
    fontSize: 17,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  primary: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plumDeep,
  },
  primaryPressed: {
    backgroundColor: LUXURY.colors.plum,
  },
  primaryText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.pearl,
    textAlign: 'center',
  },
});
