// K+ Packing Intelligence V1 — "Pack for a Trip".
//
// A distinct, discoverable K+ capability with its own route, entered from the
// home surface. Deliberately NOT a new bottom-navigation tab and NOT a hidden
// chat command.
//
// THE GATE IS THE SHARED ONE. KPlusGate renders every entitlement state and
// opens the one shared upgrade sheet; there is no Packing-specific paywall.
// The client check is UX only -- the server re-resolves has_active_k_plus() on
// every request and is the authority, so a client that lies gets nothing.
//
// K+ LOSS MID-TASK (build plan section 55): an expired entitlement stops new
// generation and refinement, but a plan already on screen stays on screen. The
// Closet is not deleted and the plan is not torn down because a subscription
// lapsed.

import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { LuxuryScreen, KScanHeader, PrimaryButton, SecondaryButton } from '../../components/luxury';
import { KPlusGate } from '../../components/kplus/KPlusGate';
import { PackingTripForm } from '../../components/packing/PackingTripForm';
import { PackingGeneralGuideView, PackingPlanView } from '../../components/packing/PackingPlanView';
import { usePackingPlan } from '../../hooks/usePackingPlan';
import { useCloset } from '../../hooks/useCloset';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { PACKING_INTELLIGENCE_V1 } from '../../constants/featureFlags';
import type { PackingTripDraft } from '../../types/packing';

/**
 * The visible stages correspond to real server-side work (Closet read, then
 * bounded reasoning). No percentages and no invented substeps: a fake progress
 * bar is a claim about internals we cannot make.
 */
const LOADING_STAGES = ['Reviewing your Closet', 'Building your looks', 'Preparing your plan'];

export default function PackingScreen() {
  const packing = usePackingPlan();
  const { items: closetItems } = useCloset();
  const [editingTrip, setEditingTrip] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);

  // The plan carries identity; the DEVICE carries the picture. Matching on the
  // local Closet id means no Closet image ever has to leave the phone for a
  // card to render.
  const imageByClientId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of closetItems ?? []) {
      const uri = item.thumbnailUri ?? item.imageUri;
      if (item.id && uri) map.set(item.id, uri);
    }
    return map;
  }, [closetItems]);

  const resolveImage = useCallback(
    (clientId: string | null) => (clientId ? imageByClientId.get(clientId) ?? null : null),
    [imageByClientId],
  );

  const busy = packing.status === 'generating';

  React.useEffect(() => {
    if (!busy) {
      setStageIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setStageIndex((current) => Math.min(current + 1, LOADING_STAGES.length - 1));
    }, 3_000);
    return () => clearInterval(timer);
  }, [busy]);

  const handleSubmit = useCallback(
    (draft: PackingTripDraft) => {
      setEditingTrip(false);
      void packing.generate(draft);
    },
    [packing],
  );

  if (!PACKING_INTELLIGENCE_V1) {
    // Flag off is not a degraded mode: the route simply is not this feature yet.
    return (
      <LuxuryScreen testID="packing-screen">
        <KScanHeader title="PACK FOR A TRIP" onBack={() => router.back()} />
        <Text style={styles.body}>Packing plans are not available in this build yet.</Text>
      </LuxuryScreen>
    );
  }

  const showForm = editingTrip || (!packing.plan && !packing.generalGuide && !busy);

  return (
    <LuxuryScreen testID="packing-screen">
      <KScanHeader title="PACK FOR A TRIP" onBack={() => router.back()} />

      <KPlusGate source="packing">
        {({ isActive, openUpgrade }) => {
          if (!isActive && !packing.plan) {
            return (
              <View testID="packing-kplus-gate">
                <Text style={styles.gateHeadline}>K Scan AI already knows your wardrobe.</Text>
                <Text style={styles.body}>
                  Packing Intelligence turns your Closet into a trip plan — real pieces you own,
                  built into looks for where you are going.
                </Text>
                <PrimaryButton
                  title="UNLOCK WITH K+"
                  onPress={openUpgrade}
                  style={styles.cta}
                  testID="packing-unlock"
                />
              </View>
            );
          }

          return (
            <View>
              {showForm ? (
                <PackingTripForm initial={packing.trip} busy={busy} onSubmit={handleSubmit} />
              ) : null}

              {busy ? (
                <View style={styles.loadingCard} testID="packing-loading">
                  <ActivityIndicator color={LUXURY.colors.plum} />
                  <Text style={styles.loadingLabel}>{LOADING_STAGES[stageIndex]}</Text>
                </View>
              ) : null}

              {packing.status === 'failed' ? (
                <View style={styles.errorCard} testID="packing-error">
                  <Text style={styles.body}>{packing.message}</Text>
                  {packing.retryable ? (
                    <SecondaryButton
                      title="TRY AGAIN"
                      onPress={() => void packing.regenerate()}
                      style={styles.cta}
                      testID="packing-retry"
                    />
                  ) : null}
                  <Pressable onPress={() => setEditingTrip(true)} accessibilityRole="button">
                    <Text style={styles.linkLabel}>EDIT TRIP</Text>
                  </Pressable>
                </View>
              ) : null}

              {packing.plan && !showForm ? (
                <View>
                  <PackingPlanView
                    plan={packing.plan}
                    message={packing.message}
                    resolveImage={resolveImage}
                    // An expired entitlement stops new work; it does not strip
                    // the plan already on screen.
                    onRemoveItem={
                      isActive && !busy ? (itemId) => void packing.removeItem(itemId) : undefined
                    }
                    busy={busy}
                  />
                  <View style={styles.actionRow}>
                    <SecondaryButton
                      title="EDIT TRIP"
                      onPress={() => setEditingTrip(true)}
                      style={styles.actionButton}
                      testID="packing-edit-trip"
                    />
                    {isActive ? (
                      <SecondaryButton
                        title={packing.packLight ? 'PACK NORMALLY' : 'PACK LIGHT'}
                        onPress={() => void packing.togglePackLight(!packing.packLight)}
                        disabled={busy}
                        style={styles.actionButton}
                        testID="packing-toggle-light"
                      />
                    ) : null}
                  </View>
                  {!isActive ? (
                    <Text style={styles.body} testID="packing-entitlement-lapsed">
                      Your K+ access has ended. This plan stays here, but new plans and changes need
                      K+.
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {packing.generalGuide && !showForm ? (
                <View>
                  <PackingGeneralGuideView guide={packing.generalGuide} message={packing.message} />
                  <View style={styles.actionRow}>
                    <SecondaryButton
                      title="EDIT TRIP"
                      onPress={() => setEditingTrip(true)}
                      style={styles.actionButton}
                      testID="packing-edit-trip"
                    />
                    <SecondaryButton
                      title="OPEN MY CLOSET"
                      onPress={() =>
                        router.push({ pathname: '/library', params: { section: 'closet' } })
                      }
                      style={styles.actionButton}
                      testID="packing-open-closet"
                    />
                  </View>
                </View>
              ) : null}
            </View>
          );
        }}
      </KPlusGate>
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  gateHeadline: {
    ...LUXURY.typography.displayHeadline,
    marginBottom: SPACING.md,
  },
  body: {
    ...LUXURY.typography.body,
    marginTop: SPACING.sm,
  },
  cta: {
    marginTop: SPACING.lg,
  },
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    backgroundColor: LUXURY.colors.champagne,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
  },
  loadingLabel: {
    ...LUXURY.typography.body,
  },
  errorCard: {
    backgroundColor: LUXURY.colors.champagne,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
  },
  linkLabel: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.md,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
    marginTop: SPACING.xl,
  },
  actionButton: {
    flexGrow: 1,
    flexBasis: 150,
  },
});
