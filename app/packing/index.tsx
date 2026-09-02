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
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
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
 * The visible stages correspond to real server-side work, IN THE ORDER THE
 * SERVER ACTUALLY DOES IT (packingHandler.ts): K+ gate, then the authoritative
 * Closet read, then weather enrichment, then the bounded model call, then
 * post-model ownership validation.
 *
 * The Closet comes BEFORE the forecast because that is the real sequence --
 * showing a weather step first would be a tidier story and a false one.
 *
 * EVERY LABEL IS AN ATTEMPT, NEVER AN OUTCOME. "Checking the forecast" can be
 * honestly said while the forecast is failing; "Found your forecast" could not.
 * The client cannot observe weather resolution mid-flight -- the server resolves
 * it internally and reports provenance only in the finished plan -- so the only
 * honest pivot is at completion, where an UNAVAILABLE provenance renders
 * "Weather unavailable" on the plan itself. Nothing here may claim success:
 * the plan renders only on a validated `ready` status.
 *
 * Durations are the real per-stage budgets (geocode 1.5s + forecast 2s; the
 * provider budget is far longer), so the sequence tracks reality rather than
 * racing ahead of it. The last stage HOLDS -- it never completes on a timer,
 * because only the response can end this.
 *
 * No percentage, no progress bar: a number here would be a claim about
 * internals the client cannot see.
 */
/**
 * When a restored plan was generated, in the traveller's terms. Derived from the
 * stored timestamp -- never guessed, and never rounded up into sounding fresher
 * than it is.
 */
function formatCachedAt(cachedAt: number): string {
  const ageMs = Date.now() - cachedAt;
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return 'in the last hour';
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const LOADING_STAGES: Array<{ label: (destination: string) => string; ms: number }> = [
  { label: () => 'Reviewing your Closet', ms: 1_800 },
  {
    label: (destination) =>
      destination ? `Checking the forecast for ${destination}` : 'Checking the forecast',
    ms: 2_600,
  },
  { label: () => 'Building your looks', ms: 6_000 },
  // Terminal stage: the ownership gate. Holds until the response lands.
  { label: () => 'Checking every piece is yours', ms: Number.POSITIVE_INFINITY },
];

export default function PackingScreen() {
  const packing = usePackingPlan();
  const { items: closetItems } = useCloset();
  const [editingTrip, setEditingTrip] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [refinement, setRefinement] = useState('');

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
  // The trip currently being generated for. Bounded before it reaches a label so
  // a long destination cannot deform the loading card.
  const destinationLabel = (packing.trip?.destination ?? '').trim().slice(0, 40);
  const currentStageLabel = (LOADING_STAGES[stageIndex] ?? LOADING_STAGES[0]).label(
    destinationLabel,
  );

  React.useEffect(() => {
    if (!busy) {
      setStageIndex(0);
      return;
    }
    // One timer per stage rather than one repeating interval, so each step lasts
    // as long as the work it names actually takes. The final stage has no timer
    // at all: it ends when the response does, never on a clock.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const advance = (index: number) => {
      const stage = LOADING_STAGES[index];
      if (!stage || !Number.isFinite(stage.ms)) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        setStageIndex(index + 1);
        advance(index + 1);
      }, stage.ms);
    };
    setStageIndex(0);
    advance(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [busy]);

  const handleRefine = useCallback(() => {
    const note = refinement.trim();
    if (!note) return;
    setRefinement('');
    void packing.refineWith(note);
  }, [refinement, packing]);

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
                <View
                  style={styles.loadingCard}
                  testID="packing-loading"
                  accessibilityRole="progressbar"
                  // Announced as it changes, so the stage is not sighted-only.
                  accessibilityLiveRegion="polite"
                  accessibilityLabel={`Building your packing plan. ${currentStageLabel}`}
                >
                  <ActivityIndicator color={LUXURY.colors.plum} />
                  <View style={styles.loadingStages}>
                    {LOADING_STAGES.map((stage, index) => {
                      const label = stage.label(destinationLabel);
                      const done = index < stageIndex;
                      const active = index === stageIndex;
                      return (
                        <Text
                          key={label}
                          style={[
                            styles.loadingStage,
                            done && styles.loadingStageDone,
                            active && styles.loadingStageActive,
                          ]}
                          // The list is one announcement (above); the rows are
                          // decorative detail and must not be read one by one.
                          accessibilityElementsHidden
                          importantForAccessibility="no-hide-descendants"
                        >
                          {`${done ? '✓' : active ? '›' : '·'}  ${label}`}
                        </Text>
                      );
                    })}
                  </View>
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
                  {packing.restoredFrom ? (
                    // UX-4. A restored plan says so, plainly, and says when it
                    // was made. It is never dressed up as a fresh result: the
                    // Closet may have changed since, and the traveller is the
                    // only one who can judge whether that matters.
                    <Text
                      style={styles.offlineBanner}
                      testID="packing-offline-banner"
                      accessibilityRole="text"
                    >
                      {`Showing your last plan, built ${formatCachedAt(packing.restoredFrom)}. Generate again for an up-to-date one.`}
                    </Text>
                  ) : null}
                  <PackingPlanView
                    plan={packing.plan}
                    message={packing.message}
                    resolveImage={resolveImage}
                    packedOff={packing.packedOff}
                    onToggleItemPacked={packing.toggleItemPacked}
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
                  {isActive ? (
                    // REFINE WITH ELISE. One Elise, one plan: the sentence goes
                    // to the same generation path everything else does, and the
                    // structured plan it returns is what the screen re-renders.
                    // Nothing here edits the visible plan directly.
                    <View style={styles.refineBlock} testID="packing-refine">
                      <Text style={styles.refineLabel}>REFINE WITH ELISE</Text>
                      <TextInput
                        value={refinement}
                        onChangeText={setRefinement}
                        placeholder="Don't bring the boots"
                        placeholderTextColor={LUXURY.colors.stone}
                        style={styles.refineInput}
                        maxLength={300}
                        editable={!busy}
                        onSubmitEditing={handleRefine}
                        returnKeyType="send"
                        accessibilityLabel="Tell Elise what to change about this plan"
                        testID="packing-refine-input"
                      />
                      <SecondaryButton
                        title="UPDATE MY PLAN"
                        onPress={handleRefine}
                        disabled={busy || !refinement.trim()}
                        style={styles.cta}
                        testID="packing-refine-submit"
                      />
                    </View>
                  ) : null}
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
  loadingStages: {
    flexShrink: 1,
    gap: SPACING.xs,
  },
  loadingStage: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.stone,
  },
  loadingStageDone: {
    color: LUXURY.colors.stone,
  },
  loadingStageActive: {
    color: LUXURY.colors.ink,
  },
  errorCard: {
    backgroundColor: LUXURY.colors.champagne,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
  },
  offlineBanner: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    backgroundColor: LUXURY.colors.champagne,
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.md,
  },
  linkLabel: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.md,
  },
  refineBlock: {
    marginTop: SPACING.xl,
  },
  refineLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom: SPACING.sm,
  },
  refineInput: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    minHeight: 48,
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
