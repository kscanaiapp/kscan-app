import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import {
  EmptyStateCard,
  KScanHeader,
  LuxuryScreen,
  PrimaryButton,
  SectionHeader,
} from '../../../components/luxury';
import { PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE } from '../../../constants/featureFlags';
import { LUXURY, SPACING } from '../../../constants/theme';
import { useAuthSession } from '../../../contexts/AuthSessionContext';
import { createActorRequest, isActorRequestCurrent } from '../../../services/actorContext';
import {
  EXTERNAL_COMMERCE_STATUS,
  MISSING_PIECE_HANDOFF_STATUS,
} from '../../../services/privateSavedLookHandoff';
import { loadSavedLookReturnContext } from '../../../services/privateSavedLookReturnContext';
import { PRIVATE_SLOT_LABELS } from '../../../types/privateDressingRoomComposition';
import type { SavedLookReturnContextV1 } from '../../../types/privateSavedLookHandoff';

export default function PrivateSavedLookHandoffScreen() {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const [context, setContext] = useState<SavedLookReturnContextV1 | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE || actorLoading || !actorId) return undefined;
    let live = true;
    const actorRequest = createActorRequest();
    setLoading(true);
    void loadSavedLookReturnContext(actorRequest)
      .then((next) => {
        if (!live || !isActorRequestCurrent(actorRequest)) return;
        setContext(next);
        setLoading(false);
      })
      .catch(() => {
        if (!live || !isActorRequestCurrent(actorRequest)) return;
        setContext(null);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [actorId, actorLoading]);

  useFocusEffect(load);

  const returnToLook = useCallback(() => {
    if (!context) return;
    router.replace({
      pathname: '/stylist/saved-looks/[id]',
      params: { id: context.savedLookId },
    });
  }, [context]);

  if (!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE) {
    return (
      <LuxuryScreen safeArea scrollable testID="private-saved-look-handoff-disabled">
        <StatusBar style="dark" />
        <KScanHeader title="Missing Piece" onBack={() => router.replace('/stylist')} />
        <EmptyStateCard title="Not available" subtitle="Saved Looks is not available in this build." />
      </LuxuryScreen>
    );
  }

  if (!actorLoading && !actorId) {
    return (
      <LuxuryScreen safeArea scrollable testID="private-saved-look-handoff-signed-out">
        <StatusBar style="dark" />
        <KScanHeader title="Missing Piece" onBack={() => router.replace('/stylist')} />
        <EmptyStateCard title="Sign in to continue" subtitle="The return context is private to your account." />
      </LuxuryScreen>
    );
  }

  return (
    <LuxuryScreen safeArea scrollable testID="private-saved-look-handoff">
      <StatusBar style="dark" />
      <KScanHeader title="Missing Piece" onBack={returnToLook} />
      {loading ? (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          <Text style={styles.muted}>Preparing structured handoff...</Text>
        </View>
      ) : null}
      {!loading && !context ? (
        <EmptyStateCard title="Return context unavailable" subtitle="Open a Saved Look and choose a piece first." />
      ) : null}
      {context ? (
        <>
          <SectionHeader
            title={MISSING_PIECE_HANDOFF_STATUS}
            subtitle={EXTERNAL_COMMERCE_STATUS}
          />
          <View style={styles.card}>
            <Text style={styles.eyebrow}>SELECTED SLOT</Text>
            <Text style={styles.title}>{PRIVATE_SLOT_LABELS[context.slotKey]}</Text>
            <Text style={styles.muted}>
              The fashion-only query was validated locally. No retailer endpoint or product result is claimed in Phase 5.
            </Text>
          </View>
          <PrimaryButton
            title="Return to Saved Look"
            onPress={returnToLook}
            accessibilityLabel={`Return to the Saved Look and ${PRIVATE_SLOT_LABELS[context.slotKey]} slot`}
            testID="return-to-saved-look-button"
          />
        </>
      ) : null}
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.sm },
  card: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: 18,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
    gap: SPACING.sm,
  },
  eyebrow: { color: LUXURY.colors.plum, fontSize: 11, fontWeight: '700', letterSpacing: 1.6 },
  title: { color: LUXURY.colors.ink, fontSize: 22, fontWeight: '700' },
  muted: { color: LUXURY.colors.stone, fontSize: 13, lineHeight: 19 },
});
