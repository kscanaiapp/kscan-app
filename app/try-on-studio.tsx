// Try-On Studio: the permanent Virtual Try-On destination.
//
// A small explainer plus navigation. It reads one decision
// (services/vto/vtoStudio.ts via hooks/useVtoStudio.ts) and draws it. Every
// action goes somewhere a real garment is chosen -- the Scanner, the Closet,
// Elise -- or to the Dressing Rooms; none of them starts a generation, picks a
// photo or opens a camera, and this screen stores nothing. Live appears only
// when every Live control agrees; AI Photo is described as a visualization and
// never as a promise of fit or size.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { InlineNotice, KScanHeader, LuxuryScreen, PrimaryButton, SecondaryButton } from '../components/luxury';
import { KPlusMarkerBadge } from '../components/kplus/KPlusMarkerBadge';
import { LUXURY, SPACING } from '../constants/theme';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { currentActorScopeKey } from '../services/actorScope';
import { useVtoActorKPlusState } from '../hooks/useVtoAwareness';
import { useVtoStudio } from '../hooks/useVtoStudio';
import { selectionTick } from '../services/haptics';
import { goBackOrHome } from '../services/navigationExit';
import { emitVtoAwarenessTap } from '../services/vto/vtoAwareness';
import { VTO_STUDIO_COPY as COPY, type VtoStudioAction } from '../services/vto/vtoStudio';

/** One destination per action. All of these routes already exist. */
function goTo(action: VtoStudioAction): void {
  switch (action) {
    case 'scan':
      router.push('/scan');
      return;
    case 'closet':
      router.push({ pathname: '/library', params: { section: 'closet' } });
      return;
    case 'elise':
      router.push('/style-chat');
      return;
    case 'dressing_rooms':
      router.push('/dressing-rooms');
      return;
  }
}

function StudioContent() {
  const studio = useVtoStudio();
  const kplus = useVtoActorKPlusState();

  return (
    <LuxuryScreen>
      <KScanHeader title={COPY.screenTitle} subtitle={COPY.screenSubtitle} onBack={() => goBackOrHome(router)} />

      {!studio.visible ? (
        // Build without VTO UI, or signed out: nothing to show, and no way to
        // reach a generation from here either way.
        <InlineNotice title={COPY.unavailableTitle} body={COPY.unavailableBody} testID="try-on-studio-hidden" />
      ) : null}

      {studio.state === 'UNAVAILABLE' ? (
        <InlineNotice title={COPY.unavailableTitle} body={COPY.unavailableBody} testID="try-on-studio-unavailable" />
      ) : null}

      {studio.state === 'RESOLVING' ? (
        <InlineNotice title={COPY.screenTitle} body={COPY.resolvingBody} testID="try-on-studio-resolving" />
      ) : null}

      {studio.state === 'FIRST_USE' || studio.state === 'RETURNING' ? (
        <View style={styles.section} testID="try-on-studio-content">
          <View style={styles.titleRow}>
            <Text style={styles.sectionTitle} accessibilityRole="header">{COPY.photoTitle}</Text>
            {studio.kplusMarker !== 'none' ? (
              <KPlusMarkerBadge state={studio.kplusMarker} testID="try-on-studio-kplus-badge" />
            ) : null}
          </View>
          <Text style={styles.body}>{COPY.photoBody}</Text>
          {studio.photo === 'kplus_required' ? (
            <Text style={styles.note} testID="try-on-studio-kplus-note">{COPY.photoKPlusRequired}</Text>
          ) : null}

          {studio.live === 'offered' ? (
            <View style={styles.liveBlock} testID="try-on-studio-live">
              <Text style={styles.sectionTitle} accessibilityRole="header">{COPY.liveTitle}</Text>
              <Text style={styles.body}>{COPY.liveBody}</Text>
            </View>
          ) : null}

          <Text style={[styles.sectionTitle, styles.actionsTitle]} accessibilityRole="header">
            {COPY.actionsTitle}
          </Text>
          <View style={styles.actions}>
            {studio.actions.map((action, index) => {
              const Button = index === 0 ? PrimaryButton : SecondaryButton;
              return (
                <Button
                  key={action}
                  title={COPY.actions[action].label}
                  accessibilityHint={COPY.actions[action].hint}
                  testID={`try-on-studio-action-${action}`}
                  onPress={() => {
                    selectionTick();
                    emitVtoAwarenessTap({ surface: 'home', kplus });
                    goTo(action);
                  }}
                />
              );
            })}
          </View>
        </View>
      ) : null}
    </LuxuryScreen>
  );
}

export default function TryOnStudioScreen() {
  useAuthSession();
  // Keyed by the actor so an account switch remounts the screen and nothing
  // from the previous account's state survives.
  return <StudioContent key={currentActorScopeKey()} />;
}

const styles = StyleSheet.create({
  section: { padding: SPACING.xl, gap: SPACING.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  sectionTitle: { ...LUXURY.typography.displayTitle, fontSize: 20, lineHeight: 26, color: LUXURY.colors.ink },
  body: { ...LUXURY.typography.body, fontSize: 14, lineHeight: 21, color: LUXURY.colors.graphite },
  note: { ...LUXURY.typography.body, fontSize: 13, lineHeight: 19, color: LUXURY.colors.graphite },
  liveBlock: { gap: SPACING.xs, marginTop: SPACING.sm },
  actionsTitle: { marginTop: SPACING.lg },
  actions: { gap: SPACING.md },
});
