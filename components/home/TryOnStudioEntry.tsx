// Home's permanent Try-On Studio entry.
//
// Unlike HomeVtoDiscoveryCard (a dismissible first-use introduction that
// retires itself), this is an evergreen row: it stays after the introduction is
// dismissed and after the first try-on. It only opens the Studio screen. It
// never starts a generation, chooses a photo or opens a camera: Home has no
// garment, and the Studio itself only navigates to places where one is chosen.
//
// Whether it renders, and what its one line says, comes from
// services/vto/vtoStudio.ts via hooks/useVtoStudio.ts. It is hidden when the
// build has no VTO UI or nobody is signed in; in every other state it is
// present, so it never flashes in and out while availability is still loading.
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { router } from 'expo-router';

import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { useVtoActorKPlusState } from '../../hooks/useVtoAwareness';
import { useVtoStudio } from '../../hooks/useVtoStudio';
import { selectionTick } from '../../services/haptics';
import { emitVtoAwarenessImpression, emitVtoAwarenessTap } from '../../services/vto/vtoAwareness';
import { VTO_STUDIO_COPY as COPY } from '../../services/vto/vtoStudio';
import { KScanIcon } from '../icons/kscan';
import { KPlusMarkerBadge } from '../kplus/KPlusMarkerBadge';

export interface TryOnStudioEntryProps {
  style?: ViewStyle;
}

export function TryOnStudioEntry({ style }: TryOnStudioEntryProps) {
  const studio = useVtoStudio();
  const kplus = useVtoActorKPlusState();

  useEffect(() => {
    if (studio.visible) emitVtoAwarenessImpression({ surface: 'home', kplus });
  }, [studio.visible, kplus]);

  if (!studio.visible) return null;

  const subtitle =
    studio.state === 'UNAVAILABLE'
      ? COPY.entrySubtitleUnavailable
      : studio.state === 'RESOLVING'
        ? COPY.entrySubtitleResolving
        : COPY.entrySubtitleReady;

  return (
    <Pressable
      onPress={() => {
        selectionTick();
        emitVtoAwarenessTap({ surface: 'home', kplus });
        router.push('/try-on-studio');
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, style]}
      accessibilityRole="button"
      accessibilityLabel={`${COPY.entryTitle}. ${subtitle}`}
      accessibilityHint={COPY.entryA11yHint}
      testID="home-try-on-studio-entry"
    >
      <View style={styles.iconTile} accessible={false} importantForAccessibility="no" accessibilityElementsHidden>
        <KScanIcon name="try-on" size={22} variant="standard" />
      </View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{COPY.entryTitle}</Text>
          {/* Unknown K+ shows no marker: resolving is not Free. */}
          {studio.kplusMarker !== 'none' ? (
            <KPlusMarkerBadge state={studio.kplusMarker} testID="home-try-on-studio-kplus-badge" />
          ) : null}
        </View>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: 64,
    padding: SPACING.md,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    ...SHADOWS.editorialSmall,
  },
  rowPressed: { opacity: 0.85 },
  iconTile: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm },
  title: { ...LUXURY.typography.displayTitle, fontSize: 18, lineHeight: 24, color: LUXURY.colors.ink },
  subtitle: { ...LUXURY.typography.body, fontSize: 13, lineHeight: 18, color: LUXURY.colors.graphite },
});
