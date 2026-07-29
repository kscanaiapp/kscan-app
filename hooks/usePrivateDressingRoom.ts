/**
 * Route-level view model for the private Dressing Room workspace.
 *
 * A THIN wrapper. Every ordering rule lives in
 * services/privateDressingRoomCoordinator.ts (pure, tested without a renderer),
 * composition in services/privateDressingRoomComposer.ts (pure), and every
 * write in the two private stores. This file gathers React state and sequences
 * the four of them.
 *
 * ACTOR SAFETY mirrors hooks/useCloset.js: results are held in an
 * actorKey-stamped snapshot, and a completion captured before an actor
 * transition is discarded rather than rendered under the new actor. The
 * monotonic actor epoch is what makes a same-user sign-out / sign-back-in cycle
 * rejectable, since actorId and actorKey are identical across it.
 *
 * THE SCREEN NEVER CALLS PERSISTENCE. The actions below are the only mutation
 * surface, and the Closet stays authoritative for garments: this hook reads it
 * through the same projection boundary the Closet UI uses and never writes to it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { loadClosetTyped } from '../services/closetLibrary';
import { getClosetItemProjections } from '../services/closetItemProjection';
import type { ClosetItemProjection } from '../services/closetItemProjection';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  PRIVATE_DRESSING_ROOM_V1,
  PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE,
} from '../constants/featureFlags';
import {
  applySlotOverride,
  clearComparedLooks as clearComparedLooksStore,
  discardInteractionState,
  loadInteractionState,
  reconcileInteractionState,
  resetCorruptInteractionState,
  restoreBaseSlot,
  setComparedLooks as setComparedLooksStore,
  undoLastSwap as undoLastSwapStore,
} from '../services/privateDressingRoomInteractionStore';
import type { InteractionContext } from '../services/privateDressingRoomInteractionStore';
import {
  indexOverrides,
  projectEffectiveLooks,
  effectiveItemForSlot,
} from '../services/privateDressingRoomEffectiveLook';
import type { EffectiveLook } from '../services/privateDressingRoomEffectiveLook';
import { rankSlotCandidates, isCandidateStillEligible } from '../services/privateDressingRoomCandidates';
import type { SlotCandidateResult } from '../services/privateDressingRoomCandidates';
import {
  canCompare,
  defaultComparisonPair,
  projectComparison,
} from '../services/privateDressingRoomComparison';
import type { ComparisonProjection } from '../services/privateDressingRoomComparison';
import {
  contextChangeDiscardsWork,
  validatePreviewForApply,
} from '../services/privateDressingRoomCoordinator';
import type {
  PrivateSlotEditorStatus,
  PrivateSlotPreview,
} from '../services/privateDressingRoomCoordinator';
import type { PrivateDressingRoomInteractionState } from '../types/privateDressingRoomInteraction';
import type { PrivateSwapResultCode } from '../types/privateDressingRoomInteraction';
import type { PrivateDressingRoomSlot } from '../types/privateDressingRoomComposition';
import { getActorContext } from '../services/actorContext';
import {
  discardActiveSession,
  loadActiveSession,
  resetCorruptSession,
  startActiveSession,
  updateActiveSession,
} from '../services/privateDressingRoomSessionStore';
import type { PrivateSessionResult } from '../services/privateDressingRoomSessionStore';
import {
  discardCompositionSet,
  loadCompositionSet,
  reconcileCompositionSet,
  replaceCompositionSet,
  resetCorruptComposition,
  setActiveLook,
} from '../services/privateDressingRoomCompositionStore';
import { buildCompositionFingerprint } from '../services/privateDressingRoomCompositionSchema';
import { composePrivateOutfits } from '../services/privateDressingRoomComposer';
import {
  compositionStatusForComposerCode,
  isCompositionReady,
  resolveCompositionLooks,
  resolvePrivateWorkspaceView,
  resolveRouteAnchorIntent,
} from '../services/privateDressingRoomCoordinator';
import type {
  ClosetLoadStatus,
  PrivateCompositionStatus,
  PrivateWorkspaceErrorCode,
  PrivateWorkspaceView,
  ResolvedLook,
} from '../services/privateDressingRoomCoordinator';
import type { PrivateDressingRoomCompositionSet } from '../types/privateDressingRoomComposition';

/**
 * Lightweight active-session probe for entry points.
 *
 * Reads the private session domain and nothing else — no Closet load, no
 * projection work, no composition, and emphatically no collaborative room
 * state. It exists so the Stylist entry can say "Resume" instead of "Start"
 * without mounting the whole workspace, and it never mutates.
 */
export function usePrivateDressingRoomStatus(): { hasActiveSession: boolean } {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';
  const [state, setState] = useState<{ actorKey: string | null; active: boolean }>({
    actorKey: null,
    active: false,
  });

  const probe = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_V1 || actorLoading) return undefined;
    let live = true;
    const actorRequest = createActorRequest();
    void loadActiveSession(actorRequest).then((result) => {
      if (!live || !isActorRequestCurrent(actorRequest)) return;
      setState({ actorKey, active: result.ok && result.session !== null });
    });
    return () => {
      live = false;
    };
  }, [actorKey, actorLoading]);

  useFocusEffect(probe);

  return { hasActiveSession: state.actorKey === actorKey && state.active };
}

type ClosetSnapshot = {
  actorKey: string | null;
  status: ClosetLoadStatus;
  items: ClosetItemProjection[];
};

type SessionSnapshot = {
  actorKey: string | null;
  result: PrivateSessionResult | null;
};

type CompositionSnapshot = {
  actorKey: string | null;
  status: PrivateCompositionStatus;
  composition: PrivateDressingRoomCompositionSet | null;
  errorCode: PrivateWorkspaceErrorCode | null;
  recovered: boolean;
};

const IDLE_COMPOSITION: CompositionSnapshot = {
  actorKey: null,
  status: 'idle',
  composition: null,
  errorCode: null,
  recovered: false,
};

// ── Phase 3 interaction state ────────────────────────────────────────────────

type InteractionSnapshot = {
  actorKey: string | null;
  /**
   * EMPTY-BY-DEFAULT, NOT WRITTEN-ON-MOUNT.
   *
   * With no persisted manifest the hook behaves as `{overrides: [], history: [],
   * comparedLookIds: []}` in memory. Nothing is written merely because the route
   * mounted: the certified store creates the record on the first persisted
   * action (`createWhenMissing` on apply/compare), so viewing Phase 2 looks
   * costs no disk write and a read-only visit leaves no trace.
   */
  state: PrivateDressingRoomInteractionState | null;
  loading: boolean;
  corrupt: boolean;
  recovered: boolean;
  /** Overrides whose garment has left the Closet. */
  missing: { lookId: string; slot: PrivateDressingRoomSlot; closetItemId: string }[];
};

const IDLE_INTERACTION: InteractionSnapshot = {
  actorKey: null,
  state: null,
  loading: false,
  corrupt: false,
  recovered: false,
  missing: [],
};

type SlotEditorState = {
  status: PrivateSlotEditorStatus;
  lookId: string | null;
  slot: PrivateDressingRoomSlot | null;
  candidates: SlotCandidateResult | null;
  resultCode: PrivateSwapResultCode | null;
};

const CLOSED_EDITOR: SlotEditorState = {
  status: 'closed',
  lookId: null,
  slot: null,
  candidates: null,
  resultCode: null,
};

export type ContextChangeConfirmation = {
  kind: 'anchor' | 'occasion';
  anchorClosetItemId?: string | null;
  occasion?: string | null;
};

export function usePrivateDressingRoom(routeClosetItemId?: unknown): PrivateWorkspaceView & {
  busy: boolean;
  compositionStatus: PrivateCompositionStatus;
  compositionError: PrivateWorkspaceErrorCode | null;
  compositionRecovered: boolean;
  looks: ResolvedLook[];
  activeLookId: string | null;
  startSession: (input?: { anchorClosetItemId?: string | null; occasion?: string | null }) => Promise<void>;
  resumeSession: () => Promise<void>;
  /**
   * NOT EXPOSED: setAnchor, clearAnchor, setOccasion and clearOccasion.
   *
   * They change composition identity, so callers reach them only through
   * `requestContextChange`, which decides whether persisted work would be
   * discarded and asks first. Returning them here would make the confirmation
   * gate optional, which is exactly the bypass Phase 3.5 closes.
   */
  discardSession: () => Promise<void>;
  resetSession: () => Promise<void>;
  selectLook: (lookId: string) => Promise<void>;
  rebuildOutfits: () => Promise<void>;
  retry: () => void;
  resetComposition: () => Promise<void>;
  revalidate: () => void;
  interactionsEnabled: boolean;
  interactionLoading: boolean;
  interactionCorrupt: boolean;
  interactionRecovered: boolean;
  missingSwappedItems: { lookId: string; slot: PrivateDressingRoomSlot; closetItemId: string }[];
  effectiveLooks: EffectiveLook[];
  canUndo: boolean;
  hasEdits: boolean;
  slotEditor: SlotEditorState;
  preview: PrivateSlotPreview | null;
  comparison: ComparisonProjection | null;
  comparing: boolean;
  canCompareLooks: boolean;
  comparedLookIds: string[];
  pendingContextChange: ContextChangeConfirmation | null;
  openSlotEditor: (lookId: string, slot: PrivateDressingRoomSlot) => Promise<void>;
  closeSlotEditor: () => void;
  previewSlotCandidate: (candidateClosetItemId: string) => void;
  clearSlotPreview: () => void;
  applySlotCandidate: () => Promise<void>;
  restoreOriginalSlot: (lookId: string, slot: PrivateDressingRoomSlot) => Promise<void>;
  undoLastSwap: () => Promise<void>;
  resetCorruptInteraction: () => Promise<void>;
  openComparison: () => Promise<void>;
  setComparedLooks: (lookIds: string[]) => Promise<void>;
  closeComparison: () => Promise<void>;
  requestContextChange: (change: ContextChangeConfirmation) => Promise<void>;
  confirmContextChange: () => Promise<void>;
  cancelContextChange: () => void;
  refreshInteraction: (actorRequest: unknown) => Promise<void>;
} {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';

  const [closet, setCloset] = useState<ClosetSnapshot>({
    actorKey: null,
    status: 'loading',
    items: [],
  });
  const [session, setSession] = useState<SessionSnapshot>({ actorKey: null, result: null });
  const [composition, setComposition] = useState<CompositionSnapshot>(IDLE_COMPOSITION);
  const [busy, setBusy] = useState(false);
  const generationRef = useRef(0);
  const routeAppliedRef = useRef<string | null>(null);

  // Phase 3. All of it is inert while the nested flag is OFF.
  const [interaction, setInteraction] = useState<InteractionSnapshot>(IDLE_INTERACTION);
  const [slotEditor, setSlotEditor] = useState<SlotEditorState>(CLOSED_EDITOR);
  const [preview, setPreview] = useState<PrivateSlotPreview | null>(null);
  const [comparing, setComparing] = useState(false);
  const [pendingContextChange, setPendingContextChange] =
    useState<ContextChangeConfirmation | null>(null);
  const previewGenerationRef = useRef(0);

  /**
   * THE COMPOSITION-CHANGE INVARIANT.
   *
   * Every path that changes or REPLACES composition identity funnels through
   * here before the change lands, so old interaction memory can never survive
   * onto a composition it was not written against. Bypass is prevented at the
   * public API rather than by caller discipline: the raw session mutators are
   * not returned by this hook, and the three internal paths that can replace a
   * composition (`mutateContext`, `rebuildOutfits`, `resetComposition`) all call
   * this first.
   *
   * The preview generation is bumped as well as cleared, so a preview object
   * captured before the change fails `validatePreviewForApply` even if a
   * concurrent apply is already in flight.
   *
   * `discardPersisted` is best-effort cleanup only: identity validation already
   * makes the old record unusable, so a failed delete cannot resurrect it.
   */
  const invalidateInteractionForCompositionChange = useCallback(
    async (actorRequest: unknown, options: { discardPersisted: boolean }) => {
      previewGenerationRef.current += 1;
      setPendingContextChange(null);
      setSlotEditor(CLOSED_EDITOR);
      setPreview(null);
      setComparing(false);
      setInteraction({ ...IDLE_INTERACTION, actorKey });
      if (options.discardPersisted && PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) {
        await discardInteractionState(actorRequest);
      }
    },
    [actorKey],
  );

  /**
   * Compose from a known-good context and persist the result.
   *
   * Publishing happens ONLY after persistence succeeds, so the UI can never
   * show outfits that would vanish on the next launch.
   */
  const composeAndPersist = useCallback(
    async (
      actorRequest: unknown,
      sessionRecord: NonNullable<PrivateSessionResult['session']>,
      items: ClosetItemProjection[],
      closetOk: boolean,
      isCurrent: () => boolean,
    ): Promise<CompositionSnapshot> => {
      const fingerprint = buildCompositionFingerprint({
        actorId: sessionRecord.actorId,
        sessionId: sessionRecord.sessionId,
        status: sessionRecord.status,
        anchorClosetItemId: sessionRecord.anchorClosetItemId,
        occasion: sessionRecord.occasion,
      });

      const composed = composePrivateOutfits({
        session: {
          actorId: sessionRecord.actorId,
          sessionId: sessionRecord.sessionId,
          status: sessionRecord.status,
          anchorClosetItemId: sessionRecord.anchorClosetItemId,
          occasion: sessionRecord.occasion,
        },
        closet: { ok: closetOk, items },
        isActorCurrent: () => isActorRequestCurrent(actorRequest),
      });

      const mapped = compositionStatusForComposerCode(composed.code);
      if (composed.looks.length === 0) {
        return { actorKey, ...mapped, composition: null, recovered: false };
      }

      const saved = await replaceCompositionSet(actorRequest, {
        sessionId: sessionRecord.sessionId,
        inputFingerprint: fingerprint,
        looks: composed.looks,
      });
      if (!isCurrent()) return IDLE_COMPOSITION;
      if (!saved.ok) {
        return {
          actorKey,
          status: 'failed',
          composition: null,
          errorCode: 'PERSISTENCE_FAILED',
          recovered: false,
        };
      }
      return {
        actorKey,
        status: mapped.status,
        composition: saved.composition,
        errorCode: null,
        recovered: false,
      };
    },
    [actorKey],
  );

  /**
   * Load and reconcile interaction state for a resolved composition.
   *
   * SHORT-CIRCUITS WHEN THE NESTED FLAG IS OFF: no store read, no reconciliation,
   * no candidate work. That is the Phase 2 view-only guarantee, enforced here at
   * the single entry point rather than at every call site.
   *
   * An override is never shown before reconciliation has run, and a Closet load
   * failure is never converted into a missing-swapped-item state — with no
   * projections we simply cannot tell, so nothing is claimed.
   */
  const loadInteractionFor = useCallback(
    async (
      actorRequest: unknown,
      sessionRecord: NonNullable<PrivateSessionResult['session']>,
      compositionRecord: PrivateDressingRoomCompositionSet | null,
      items: ClosetItemProjection[],
      fingerprint: string,
      isCurrent: () => boolean,
      closetOk = true,
    ) => {
      if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE || !compositionRecord) {
        setInteraction({ ...IDLE_INTERACTION, actorKey });
        return;
      }
      setInteraction({ ...IDLE_INTERACTION, actorKey, loading: true });

      const context: InteractionContext = {
        sessionId: sessionRecord.sessionId,
        compositionId: compositionRecord.compositionId,
        inputFingerprint: fingerprint,
      };
      const loaded = await loadInteractionState(actorRequest, context);
      if (!isCurrent()) return;

      if (!loaded.ok) {
        // Corrupt EDITS do not cost the user their outfits: the Phase 2
        // composition stays exactly as it is and only Reset Edits is offered.
        setInteraction({
          ...IDLE_INTERACTION,
          actorKey,
          corrupt: true,
        });
        return;
      }

      const state = loaded.stale ? null : loaded.interaction;
      const reconciled = state
        ? reconcileInteractionState(
            state,
            items.map((item) => item.id),
            compositionRecord.looks.map((look) => look.lookId),
          )
        : { missingOverrides: [], unknownLookIds: [], comparedLookIdsValid: false };

      setInteraction({
        actorKey,
        state,
        loading: false,
        corrupt: false,
        recovered: loaded.recovered === 'backup',
        // Only meaningful when the Closet actually loaded.
        missing: closetOk ? reconciled.missingOverrides : [],
      });
    },
    [actorKey],
  );

  /**
   * Read Closet, session and composition for the CURRENT actor, composing when
   * a valid context has no current composition.
   *
   * One generation token covers all three reads, so a stale trio can never be
   * combined with a fresh one into a view that never existed.
   */
  const hydrate = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_V1 || actorLoading) return undefined;

    const generation = ++generationRef.current;
    let live = true;
    const actorRequest = createActorRequest();
    const isCurrent = () =>
      live && generationRef.current === generation && isActorRequestCurrent(actorRequest);

    setCloset({ actorKey, status: 'loading', items: [] });
    setSession({ actorKey, result: null });
    setComposition({ ...IDLE_COMPOSITION, actorKey, status: 'building' });

    void (async () => {
      // TYPED load: an empty Closet and a failed read are finally different
      // things, so the workspace never shows "your Closet is empty" for a fault.
      const closetResult = await loadClosetTyped(actorId, { actorRequest });
      if (!isCurrent()) return;
      const items = closetResult.ok ? getClosetItemProjections(closetResult.items) : [];
      const status: ClosetLoadStatus = closetResult.ok ? 'loaded' : 'failed';
      setCloset({ actorKey, status, items });

      const sessionResult = await loadActiveSession(actorRequest);
      if (!isCurrent()) return;
      setSession({ actorKey, result: sessionResult });

      const record = sessionResult.ok ? sessionResult.session : null;
      if (!record) {
        setComposition({ ...IDLE_COMPOSITION, actorKey });
        setInteraction({ ...IDLE_INTERACTION, actorKey });
        return;
      }

      const fingerprint = buildCompositionFingerprint({
        actorId: record.actorId,
        sessionId: record.sessionId,
        status: record.status,
        anchorClosetItemId: record.anchorClosetItemId,
        occasion: record.occasion,
      });

      const stored = await loadCompositionSet(actorRequest, fingerprint);
      if (!isCurrent()) return;

      if (!stored.ok) {
        setComposition({
          actorKey,
          status: 'corrupt',
          composition: null,
          errorCode: 'COMPOSITION_CORRUPT',
          recovered: false,
        });
        setInteraction({ ...IDLE_INTERACTION, actorKey });
        return;
      }

      const anchorMissing =
        !!record.anchorClosetItemId && !items.some((item) => item.id === record.anchorClosetItemId);

      // RESTORE WITHOUT RECOMPOSING. A valid stored composition is returned as
      // it was left; foregrounding must not silently produce different outfits.
      if (stored.composition) {
        const reconciled = reconcileCompositionSet(
          stored.composition,
          items.map((item) => item.id),
          record.anchorClosetItemId,
        );
        setComposition({
          actorKey,
          status: reconciled.staleLookIds.length > 0 || reconciled.anchorMissing ? 'stale' : 'ready',
          composition: stored.composition,
          errorCode:
            reconciled.staleLookIds.length > 0 || reconciled.anchorMissing
              ? 'COMPOSITION_STALE'
              : null,
          recovered: stored.recovered === 'backup',
        });
        await loadInteractionFor(
          actorRequest,
          record,
          stored.composition,
          items,
          fingerprint,
          isCurrent,
          closetResult.ok,
        );
        return;
      }

      if (!isCompositionReady({ session: record, anchorMissing })) {
        setComposition({
          actorKey,
          status: 'idle',
          composition: null,
          errorCode: anchorMissing ? 'ANCHOR_MISSING' : null,
          recovered: false,
        });
        setInteraction({ ...IDLE_INTERACTION, actorKey });
        return;
      }

      const next = await composeAndPersist(
        actorRequest,
        record,
        items,
        closetResult.ok,
        isCurrent,
      );
      if (!isCurrent()) return;
      setComposition(next);
      await loadInteractionFor(
        actorRequest,
        record,
        next.composition,
        items,
        fingerprint,
        isCurrent,
        closetResult.ok,
      );
    })();

    return () => {
      live = false;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [actorId, actorKey, actorLoading, composeAndPersist, loadInteractionFor]);

  // Route focus: the established route-scoped revalidation seam (useCloset.js).
  useFocusEffect(hydrate);

  /**
   * Returning to the foreground revalidates exactly as a focus does.
   *
   * Route-scoped, not global: the subscription is created by this screen and
   * removed with it, so a backgrounded app with the workspace closed subscribes
   * to nothing.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') hydrate();
    });
    return () => subscription?.remove?.();
  }, [hydrate]);

  /** An actor transition invalidates every snapshot and any pending work. */
  useEffect(() => {
    generationRef.current += 1;
    routeAppliedRef.current = null;
    setCloset({ actorKey: null, status: 'loading', items: [] });
    setSession({ actorKey: null, result: null });
    setComposition(IDLE_COMPOSITION);
    setInteraction(IDLE_INTERACTION);
    setPreview(null);
    setSlotEditor(CLOSED_EDITOR);
    setComparing(false);
    setPendingContextChange(null);
  }, [actorKey]);

  const view = useMemo(
    () =>
      resolvePrivateWorkspaceView({
        enabled: PRIVATE_DRESSING_ROOM_V1,
        actorLoading,
        closetStatus: closet.actorKey === actorKey ? closet.status : 'loading',
        closetItems: closet.actorKey === actorKey ? closet.items : [],
        session: session.actorKey === actorKey ? session.result : null,
        routeClosetItemId,
      }),
    [actorKey, actorLoading, closet, session, routeClosetItemId],
  );

  const current = composition.actorKey === actorKey ? composition : IDLE_COMPOSITION;

  const activeInteraction = interaction.actorKey === actorKey ? interaction : IDLE_INTERACTION;

  /** Whether the Closet actually loaded for THIS actor — never inferred. */
  const closetLoaded = closet.actorKey === actorKey && closet.status === 'loaded';

  /**
   * EFFECTIVE LOOKS = immutable Phase 2 base + validated overrides + the
   * ephemeral preview.
   *
   * The preview is layered LAST and only in memory, so a previewed garment is
   * visible without ever reaching persistence. The Phase 2 composition arrays
   * are never touched — projectEffectiveLooks builds new objects and arrays.
   */
  const effectiveLooks = useMemo<EffectiveLook[]>(() => {
    if (!current.composition) return [];
    const overrideEntries = activeInteraction.state?.overrides ?? [];
    const indexed = indexOverrides(overrideEntries);
    if (preview) {
      const existing = indexed.get(preview.lookId) ?? [];
      indexed.set(preview.lookId, [
        ...existing.filter((entry) => entry.slot !== preview.slot),
        {
          slot: preview.slot,
          closetItemId: preview.candidateClosetItemId,
          operationId: 'preview',
          appliedAt: new Date(0).toISOString(),
        },
      ]);
    }
    return projectEffectiveLooks(current.composition.looks, indexed);
  }, [current.composition, activeInteraction.state, preview]);

  /**
   * Presentation looks.
   *
   * With interactions OFF this is exactly the Phase 2 projection, unchanged.
   * With them ON the same resolver runs over the EFFECTIVE items, so one
   * rendering path serves both modes.
   */
  const looks = useMemo(
    () =>
      current.composition
        ? resolveCompositionLooks({
            looks: PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE
              ? effectiveLooks.map((look) => ({
                  lookId: look.lookId,
                  rank: look.rank,
                  completeness: look.completeness,
                  missingSlots: look.missingSlots,
                  labelCodes: look.labelCodes,
                  items: look.items.map((item) => ({
                    slot: item.slot,
                    closetItemId: item.closetItemId,
                  })),
                }))
              : current.composition.looks,
            closetItems: view.closetItems,
            activeLookId: current.composition.activeLookId,
            anchorClosetItemId: view.session?.anchorClosetItemId ?? null,
          })
        : [],
    [current.composition, effectiveLooks, view.closetItems, view.session],
  );

  const interactionContext = useMemo<InteractionContext | null>(() => {
    const record = view.session;
    if (!record || !current.composition) return null;
    return {
      sessionId: record.sessionId,
      compositionId: current.composition.compositionId,
      inputFingerprint: buildCompositionFingerprint({
        actorId: record.actorId,
        sessionId: record.sessionId,
        status: record.status,
        anchorClosetItemId: record.anchorClosetItemId,
        occasion: record.occasion,
      }),
    };
  }, [view.session, current.composition]);

  const comparedLookIds = activeInteraction.state?.comparedLookIds ?? [];

  const comparison = useMemo<ComparisonProjection | null>(() => {
    if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) return null;
    const pair =
      comparedLookIds.length === 2
        ? comparedLookIds
        : defaultComparisonPair(effectiveLooks, current.composition?.activeLookId ?? null) ?? [];
    return projectComparison({
      looks: effectiveLooks,
      comparedLookIds: pair,
      anchorClosetItemId: view.session?.anchorClosetItemId ?? null,
    });
  }, [effectiveLooks, comparedLookIds, current.composition, view.session]);

  /**
   * Mutate the session, then REPLACE the composition.
   *
   * Order matters and is the whole reason no cross-file transaction is needed:
   * the session lands first, which immediately makes the previous composition
   * stale by fingerprint; the old outfits are dropped from state before the new
   * ones are built; and the replacement is published only once persisted.
   */
  const mutateContext = useCallback(
    async (operation: (request: unknown) => Promise<PrivateSessionResult>) => {
      if (busy) return;
      setBusy(true);
      const actorRequest = createActorRequest();
      const isCurrent = () => isActorRequestCurrent(actorRequest);
      try {
        // GOVERNED: the session mutation below changes the fingerprint, so the
        // old interaction identity is dropped before it can be published under
        // a composition it was never written against.
        await invalidateInteractionForCompositionChange(actorRequest, { discardPersisted: true });
        if (!isCurrent()) return;

        const result = await operation(actorRequest);
        if (!isCurrent()) return;
        setSession({ actorKey, result });

        const record = result.ok ? result.session : null;
        if (!result.ok) {
          setComposition({
            actorKey,
            status: 'failed',
            composition: null,
            errorCode: 'PERSISTENCE_FAILED',
            recovered: false,
          });
          return;
        }
        if (!record) {
          setComposition({ ...IDLE_COMPOSITION, actorKey });
          return;
        }

        // The old composition is hidden the moment the context changes, before
        // any replacement exists.
        setComposition({ ...IDLE_COMPOSITION, actorKey, status: 'building' });
        // Best-effort cleanup. Fingerprint validation already makes a surviving
        // file unusable, so a failure here is not worth surfacing.
        await discardCompositionSet(actorRequest);
        if (!isCurrent()) return;

        const items = closet.actorKey === actorKey ? closet.items : [];
        const closetOk = closet.actorKey === actorKey && closet.status === 'loaded';
        const anchorMissing =
          !!record.anchorClosetItemId &&
          !items.some((item) => item.id === record.anchorClosetItemId);

        if (!isCompositionReady({ session: record, anchorMissing })) {
          setComposition({
            actorKey,
            status: 'idle',
            composition: null,
            errorCode: anchorMissing ? 'ANCHOR_MISSING' : null,
            recovered: false,
          });
          return;
        }

        const next = await composeAndPersist(actorRequest, record, items, closetOk, isCurrent);
        if (!isCurrent()) return;
        setComposition(next);
      } finally {
        setBusy(false);
      }
    },
    [actorKey, busy, closet, composeAndPersist, invalidateInteractionForCompositionChange],
  );

  const startSession = useCallback(
    (input: { anchorClosetItemId?: string | null; occasion?: string | null } = {}) =>
      mutateContext((request) => startActiveSession(request, input)),
    [mutateContext],
  );

  const resumeSession = useCallback(async () => {
    hydrate();
  }, [hydrate]);

  const setAnchor = useCallback(
    (closetItemId: string) =>
      mutateContext((request) => updateActiveSession(request, { anchorClosetItemId: closetItemId })),
    [mutateContext],
  );

  const clearAnchor = useCallback(
    () => mutateContext((request) => updateActiveSession(request, { anchorClosetItemId: null })),
    [mutateContext],
  );

  const setOccasion = useCallback(
    (occasion: string) => mutateContext((request) => updateActiveSession(request, { occasion })),
    [mutateContext],
  );

  const clearOccasion = useCallback(
    () => mutateContext((request) => updateActiveSession(request, { occasion: null })),
    [mutateContext],
  );

  const discardSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      const result = await discardActiveSession(actorRequest);
      if (!isActorRequestCurrent(actorRequest)) return;
      setSession({ actorKey, result });
      // The composition is already invalid by status fingerprint; cleanup is
      // best-effort and the discard stays authoritative if it fails.
      setComposition({ ...IDLE_COMPOSITION, actorKey });
      setInteraction({ ...IDLE_INTERACTION, actorKey });
      setPreview(null);
      setSlotEditor(CLOSED_EDITOR);
      setComparing(false);
      setPendingContextChange(null);
      await discardCompositionSet(actorRequest);
      if (PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) {
        await discardInteractionState(actorRequest);
      }
    } finally {
      setBusy(false);
    }
  }, [actorKey, busy]);

  const resetSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      const result = await resetCorruptSession(actorRequest);
      if (!isActorRequestCurrent(actorRequest)) return;
      setSession({ actorKey, result });
      setComposition({ ...IDLE_COMPOSITION, actorKey });
      setInteraction({ ...IDLE_INTERACTION, actorKey });
      setPreview(null);
      setSlotEditor(CLOSED_EDITOR);
      setComparing(false);
      setPendingContextChange(null);
      await discardCompositionSet(actorRequest);
      if (PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) {
        await discardInteractionState(actorRequest);
      }
    } finally {
      setBusy(false);
    }
  }, [actorKey, busy]);

  /** Persist which option is current. Never alters a look's contents. */
  const selectLook = useCallback(
    async (lookId: string) => {
      if (busy) return;
      const record = view.session;
      if (!record) return;
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const fingerprint = buildCompositionFingerprint({
          actorId: record.actorId,
          sessionId: record.sessionId,
          status: record.status,
          anchorClosetItemId: record.anchorClosetItemId,
          occasion: record.occasion,
        });
        const result = await setActiveLook(actorRequest, { lookId, expectedFingerprint: fingerprint });
        if (!isActorRequestCurrent(actorRequest)) return;
        if (result.stale) {
          setComposition({
            actorKey,
            status: 'stale',
            composition: null,
            errorCode: 'COMPOSITION_STALE',
            recovered: false,
          });
          return;
        }
        if (!result.ok) {
          setComposition((previous) => ({
            ...previous,
            errorCode: 'PERSISTENCE_FAILED',
          }));
          return;
        }
        setComposition({
          actorKey,
          status: current.status === 'partial' ? 'partial' : 'ready',
          composition: result.composition,
          errorCode: null,
          recovered: false,
        });
      } finally {
        setBusy(false);
      }
    },
    [actorKey, busy, current.status, view.session],
  );

  /**
   * User-initiated rebuild.
   *
   * Deterministic: the same inputs produce the same outfits, so this is offered
   * only when the current composition is stale, corrupt or absent — never as a
   * "shuffle" on a valid one.
   */
  const rebuildOutfits = useCallback(async () => {
    if (busy) return;
    const record = view.session;
    if (!record) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    const isCurrent = () => isActorRequestCurrent(actorRequest);
    const previous = current;
    try {
      // AUTOMATIC RECOVERY, NOT A USER-REQUESTED CONTEXT CHANGE. A rebuild is
      // only offered for a stale/corrupt/absent composition, so it must not show
      // a destructive confirmation — but the replacement carries new lookIds, so
      // the old interaction identity is invalidated exactly as a context change
      // would invalidate it.
      await invalidateInteractionForCompositionChange(actorRequest, { discardPersisted: true });
      if (!isCurrent()) return;

      setComposition({ ...IDLE_COMPOSITION, actorKey, status: 'building' });
      await discardCompositionSet(actorRequest);
      if (!isCurrent()) return;

      const items = closet.actorKey === actorKey ? closet.items : [];
      const closetOk = closet.actorKey === actorKey && closet.status === 'loaded';
      const next = await composeAndPersist(actorRequest, record, items, closetOk, isCurrent);
      if (!isCurrent()) return;
      // A failed rebuild restores the state the user was looking at rather than
      // leaving an empty workspace behind.
      const rebuildFailed = next.status === 'failed' && next.composition === null;
      setComposition(rebuildFailed ? { ...previous, errorCode: next.errorCode } : next);
    } finally {
      setBusy(false);
    }
  }, [
    actorKey,
    busy,
    closet,
    composeAndPersist,
    current,
    view.session,
    invalidateInteractionForCompositionChange,
  ]);

  /** Explicit reset of a corrupt composition. The SESSION is never touched. */
  const resetComposition = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      // The rebuilt composition gets a new identity, so edits recorded against
      // the corrupt one cannot follow it.
      await invalidateInteractionForCompositionChange(actorRequest, { discardPersisted: true });
      if (!isActorRequestCurrent(actorRequest)) return;
      await resetCorruptComposition(actorRequest);
      if (!isActorRequestCurrent(actorRequest)) return;
      setComposition({ ...IDLE_COMPOSITION, actorKey });
    } finally {
      setBusy(false);
    }
    hydrate();
  }, [actorKey, busy, hydrate, invalidateInteractionForCompositionChange]);

  /** Repeat the failed operation without altering session context. */
  const retry = useCallback(() => {
    hydrate();
  }, [hydrate]);

  // ── Phase 3 actions ────────────────────────────────────────────────────────

  /** Re-read interaction state after a mutation, so only PERSISTED state shows. */
  const refreshInteraction = useCallback(
    async (actorRequest: unknown) => {
      const record = view.session;
      if (!record || !current.composition || !interactionContext) return;
      await loadInteractionFor(
        actorRequest,
        record,
        current.composition,
        view.closetItems as ClosetItemProjection[],
        interactionContext.inputFingerprint,
        () => isActorRequestCurrent(actorRequest),
        closetLoaded,
      );
    },
    [view.session, view.closetItems, closetLoaded, current.composition, interactionContext, loadInteractionFor],
  );

  /**
   * Open the editor for one slot.
   *
   * Only ONE editor is ever active: opening another clears the previous preview
   * and replaces the editor outright.
   */
  const openSlotEditor = useCallback(
    async (lookId: string, slot: PrivateDressingRoomSlot) => {
      if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) return;
      setPreview(null);
      const look = effectiveLooks.find((entry) => entry.lookId === lookId) ?? null;
      if (!look || !interactionContext) {
        setSlotEditor({ ...CLOSED_EDITOR, status: 'failed', resultCode: 'INVALID_INPUT' });
        return;
      }
      setSlotEditor({ status: 'loading', lookId, slot, candidates: null, resultCode: null });

      const actorRequest = createActorRequest();
      const result = rankSlotCandidates({
        look,
        slot,
        closetItems: view.closetItems,
        closetOk: closetLoaded,
        anchorClosetItemId: view.session?.anchorClosetItemId ?? null,
        occasion: view.session?.occasion ?? null,
        isActorCurrent: () => isActorRequestCurrent(actorRequest),
      });
      // The actor may have changed while ranking; a stale candidate list must
      // never reach the screen.
      if (!isActorRequestCurrent(actorRequest)) {
        setSlotEditor(CLOSED_EDITOR);
        return;
      }
      setSlotEditor({
        status:
          result.code === 'READY'
            ? 'ready'
            : result.code === 'ANCHOR_LOCKED'
              ? 'anchor_locked'
              : result.code === 'NO_CANDIDATES'
                ? 'no_candidates'
                : 'failed',
        lookId,
        slot,
        candidates: result,
        resultCode: result.code === 'ANCHOR_LOCKED' ? 'ANCHOR_LOCKED' : null,
      });
    },
    [effectiveLooks, interactionContext, view.closetItems, closetLoaded, view.session],
  );

  const closeSlotEditor = useCallback(() => {
    setPreview(null);
    setSlotEditor(CLOSED_EDITOR);
  }, []);

  /** Preview is ephemeral: it changes the displayed slot and nothing else. */
  const previewSlotCandidate = useCallback(
    (candidateClosetItemId: string) => {
      if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) return;
      if (!slotEditor.lookId || !slotEditor.slot || !interactionContext) return;
      previewGenerationRef.current += 1;
      setPreview({
        generation: previewGenerationRef.current,
        lookId: slotEditor.lookId,
        slot: slotEditor.slot,
        candidateClosetItemId,
        sessionId: interactionContext.sessionId,
        compositionId: interactionContext.compositionId,
        inputFingerprint: interactionContext.inputFingerprint,
        actorEpoch: getActorContext().epoch,
      });
    },
    [slotEditor.lookId, slotEditor.slot, interactionContext],
  );

  const clearSlotPreview = useCallback(() => setPreview(null), []);

  /**
   * Apply the CURRENT preview.
   *
   * Takes no candidate argument by design: the route cannot hand an arbitrary id
   * to persistence. The preview identity is validated against live context, the
   * candidate's eligibility is re-proved against the Closet as it is right now,
   * and only the persisted result is published.
   */
  const applySlotCandidate = useCallback(async () => {
    if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) return;
    if (busy || !preview || !interactionContext) return;

    const actorRequest = createActorRequest();
    const validation = validatePreviewForApply(preview, {
      generation: previewGenerationRef.current,
      lookId: preview.lookId,
      slot: preview.slot,
      candidateClosetItemId: preview.candidateClosetItemId,
      sessionId: interactionContext.sessionId,
      compositionId: interactionContext.compositionId,
      inputFingerprint: interactionContext.inputFingerprint,
      actorEpoch: getActorContext().epoch,
    });
    if (!validation.ok) {
      setPreview(null);
      setSlotEditor((previous) => ({ ...previous, status: 'failed', resultCode: validation.reason }));
      return;
    }

    setBusy(true);
    setSlotEditor((previous) => ({ ...previous, status: 'applying' }));
    try {
      // The base look is read WITHOUT the preview layered on, so `before` is the
      // genuinely persisted item rather than the thing being previewed.
      const persistedLooks = projectEffectiveLooks(
        current.composition?.looks ?? [],
        indexOverrides(activeInteraction.state?.overrides ?? []),
      );
      const look = persistedLooks.find((entry) => entry.lookId === preview.lookId) ?? null;
      const currentItem = effectiveItemForSlot(look, preview.slot);
      const baseItem = current.composition?.looks
        .find((entry) => entry.lookId === preview.lookId)
        ?.items.find((entry) => entry.slot === preview.slot);

      const stillEligible = isCandidateStillEligible({
        look,
        slot: preview.slot,
        candidateClosetItemId: preview.candidateClosetItemId,
        closetItems: view.closetItems,
        anchorClosetItemId: view.session?.anchorClosetItemId ?? null,
      });
      if (!stillEligible) {
        setSlotEditor((previous) => ({
          ...previous,
          status: 'failed',
          resultCode: 'CANDIDATE_UNAVAILABLE',
        }));
        return;
      }

      const result = await applySlotOverride(actorRequest, interactionContext, {
        lookId: preview.lookId,
        slot: preview.slot,
        kind: currentItem ? 'replace' : 'fill',
        beforeClosetItemId: currentItem?.closetItemId ?? null,
        afterClosetItemId: preview.candidateClosetItemId,
        baseClosetItemId: baseItem?.closetItemId ?? null,
      });
      if (!isActorRequestCurrent(actorRequest)) return;

      if (!result.ok || result.stale) {
        setSlotEditor((previous) => ({
          ...previous,
          status: 'failed',
          resultCode: result.stale ? 'INTERACTION_STALE' : 'PERSIST_FAILED',
        }));
        return;
      }
      // Only the PERSISTED state is published.
      setPreview(null);
      const reconciled = reconcileInteractionState(
        result.interaction,
        view.closetItems.map((item) => item.id),
        (current.composition?.looks ?? []).map((look) => look.lookId),
      );
      setInteraction((previous) => ({
        ...previous,
        actorKey,
        state: result.interaction,
        corrupt: false,
        missing: closetLoaded ? reconciled.missingOverrides : [],
      }));
      setSlotEditor(CLOSED_EDITOR);
    } finally {
      setBusy(false);
    }
  }, [
    actorKey,
    busy,
    preview,
    interactionContext,
    current.composition,
    activeInteraction.state,
    view.closetItems,
    view.session,
    closetLoaded,
  ]);

  /** Return one slot to its generated item. A normal reversible operation. */
  const restoreOriginalSlot = useCallback(
    async (lookId: string, slot: PrivateDressingRoomSlot) => {
      if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) return;
      if (busy || !interactionContext || !current.composition) return;

      const baseItem = current.composition.looks
        .find((entry) => entry.lookId === lookId)
        ?.items.find((entry) => entry.slot === slot);
      const persistedLooks = projectEffectiveLooks(
        current.composition.looks,
        indexOverrides(activeInteraction.state?.overrides ?? []),
      );
      const currentItem = effectiveItemForSlot(
        persistedLooks.find((entry) => entry.lookId === lookId) ?? null,
        slot,
      );
      // With no generated item to go back to, the composition itself is stale
      // and the Phase 2 rebuild path owns the recovery.
      if (!baseItem || !currentItem) return;

      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await restoreBaseSlot(actorRequest, interactionContext, {
          lookId,
          slot,
          currentClosetItemId: currentItem.closetItemId,
          baseClosetItemId: baseItem.closetItemId,
        });
        if (!isActorRequestCurrent(actorRequest)) return;
        if (result.ok && !result.stale) {
          setPreview(null);
          const reconciled = reconcileInteractionState(
            result.interaction,
            view.closetItems.map((item) => item.id),
            (current.composition?.looks ?? []).map((look) => look.lookId),
          );
          setInteraction((previous) => ({
            ...previous,
            actorKey,
            state: result.interaction,
            missing: closetLoaded ? reconciled.missingOverrides : [],
          }));
          setSlotEditor(CLOSED_EDITOR);
        } else {
          setSlotEditor((previous) => ({
            ...previous,
            status: 'failed',
            resultCode: result.stale ? 'INTERACTION_STALE' : 'PERSIST_FAILED',
          }));
        }
      } finally {
        setBusy(false);
      }
    },
    [actorKey, busy, interactionContext, current.composition, activeInteraction.state, view.closetItems, closetLoaded],
  );

  /** Undo the newest persisted operation. Never a redo. */
  const undoLastSwap = useCallback(async () => {
    if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE) return;
    if (busy || !interactionContext || !current.composition) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      const result = await undoLastSwapStore(actorRequest, interactionContext, {
        availableClosetItemIds: view.closetItems.map((item) => item.id),
        // Reverting onto the generated item must DROP the override, not store
        // one that overrides nothing.
        resolveBaseClosetItemId: (lookId, slot) =>
          current.composition?.looks
            .find((entry) => entry.lookId === lookId)
            ?.items.find((entry) => entry.slot === slot)?.closetItemId ?? null,
      });
      if (!isActorRequestCurrent(actorRequest)) return;
      if (result.ok && !result.stale && result.resultCode === 'APPLIED') {
        setPreview(null);
        const reconciled = reconcileInteractionState(
          result.interaction,
          view.closetItems.map((item) => item.id),
          (current.composition?.looks ?? []).map((look) => look.lookId),
        );
        setInteraction((previous) => ({
          ...previous,
          actorKey,
          state: result.interaction,
          missing: closetLoaded ? reconciled.missingOverrides : [],
        }));
      } else {
        // A blocked undo leaves state exactly as it was — it does not skip to an
        // older operation.
        setSlotEditor((previous) => ({
          ...previous,
          resultCode: (result.resultCode as PrivateSwapResultCode) ?? 'PERSIST_FAILED',
        }));
      }
    } finally {
      setBusy(false);
    }
  }, [actorKey, busy, interactionContext, current.composition, view.closetItems, closetLoaded]);

  const resetCorruptInteraction = useCallback(async () => {
    if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE || busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      await resetCorruptInteractionState(actorRequest);
      if (!isActorRequestCurrent(actorRequest)) return;
      setPreview(null);
      setSlotEditor(CLOSED_EDITOR);
      setInteraction({ ...IDLE_INTERACTION, actorKey });
    } finally {
      setBusy(false);
    }
  }, [actorKey, busy]);

  // ── Comparison ─────────────────────────────────────────────────────────────

  const openComparison = useCallback(async () => {
    if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE || !interactionContext) return;
    const pair = defaultComparisonPair(
      effectiveLooks,
      current.composition?.activeLookId ?? null,
    );
    if (!pair) return;
    setComparing(true);
    const actorRequest = createActorRequest();
    const result = await setComparedLooksStore(actorRequest, interactionContext, pair);
    if (!isActorRequestCurrent(actorRequest)) return;
    if (result.ok && !result.stale) {
      setInteraction((previous) => ({ ...previous, actorKey, state: result.interaction }));
    }
  }, [actorKey, effectiveLooks, current.composition, interactionContext]);

  const setComparedLooks = useCallback(
    async (lookIds: string[]) => {
      if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE || !interactionContext) return;
      const actorRequest = createActorRequest();
      const result = await setComparedLooksStore(actorRequest, interactionContext, lookIds);
      if (!isActorRequestCurrent(actorRequest)) return;
      if (result.ok && !result.stale) {
        setInteraction((previous) => ({ ...previous, actorKey, state: result.interaction }));
      }
    },
    [actorKey, interactionContext],
  );

  const closeComparison = useCallback(async () => {
    setComparing(false);
    if (!PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE || !interactionContext) return;
    const actorRequest = createActorRequest();
    const result = await clearComparedLooksStore(actorRequest, interactionContext);
    if (!isActorRequestCurrent(actorRequest)) return;
    if (result.ok && !result.stale) {
      setInteraction((previous) => ({ ...previous, actorKey, state: result.interaction }));
    }
  }, [actorKey, interactionContext]);

  // ── Context change confirmation ────────────────────────────────────────────

  const hasPersistedEdits =
    (activeInteraction.state?.overrides.length ?? 0) > 0 ||
    (activeInteraction.state?.history.length ?? 0) > 0 ||
    comparedLookIds.length === 2;

  const cancelContextChange = useCallback(() => setPendingContextChange(null), []);

  /**
   * Commit a confirmed context change.
   *
   * DECLARED BEFORE its callers, and listed in their dependency arrays: a
   * `useCallback` that closes over a later `const` without declaring it captures
   * the first render's copy forever, which is exactly the stale-closure class of
   * bug this workspace cannot afford.
   *
   * Order matters: the editor and preview close FIRST, then the session mutation
   * lands (which invalidates the composition by fingerprint), then interaction
   * cleanup is attempted best-effort, and finally the replacement composition is
   * built with no overrides. Old effective looks are never shown beneath the new
   * context because the interaction state is dropped from memory up front.
   */
  const applyContextChange = useCallback(
    async (change: ContextChangeConfirmation) => {
      setPendingContextChange(null);
      setSlotEditor(CLOSED_EDITOR);
      setPreview(null);
      setComparing(false);
      setInteraction({ ...IDLE_INTERACTION, actorKey });

      // The PERSISTED record is discarded by the governed invalidation inside
      // `mutateContext`, which every branch below reaches. Clearing memory here
      // as well is what stops old effective looks from rendering for the frame
      // between this call and the session write.
      if (change.kind === 'anchor') {
        if (change.anchorClosetItemId) await setAnchor(change.anchorClosetItemId);
        else await clearAnchor();
      } else if (change.occasion) {
        await setOccasion(change.occasion);
      } else {
        await clearOccasion();
      }
    },
    [actorKey, setAnchor, clearAnchor, setOccasion, clearOccasion],
  );

  /**
   * Request an anchor or occasion change.
   *
   * Confirmation is required only when PERSISTED work would be discarded. An
   * unapplied preview alone does not warrant a warning: nothing was saved, so
   * nothing is lost.
   */
  const requestContextChange = useCallback(
    async (change: ContextChangeConfirmation) => {
      const needsConfirmation =
        PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE &&
        contextChangeDiscardsWork({
          hasOverrides: (activeInteraction.state?.overrides.length ?? 0) > 0,
          hasHistory: (activeInteraction.state?.history.length ?? 0) > 0,
          hasComparison: comparedLookIds.length === 2,
          hasPreview: false,
        });
      if (needsConfirmation) {
        setPendingContextChange(change);
        return;
      }
      await applyContextChange(change);
    },
    [activeInteraction.state, comparedLookIds, applyContextChange],
  );

  const confirmContextChange = useCallback(async () => {
    if (!pendingContextChange) return;
    await applyContextChange(pendingContextChange);
  }, [pendingContextChange, applyContextChange]);

  /**
   * Backgrounding clears an unapplied preview immediately.
   *
   * The user must not return to a phantom garment they never applied. Persisted
   * interaction state is untouched.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        setPreview(null);
        setSlotEditor(CLOSED_EDITOR);
      }
    });
    return () => subscription?.remove?.();
  }, []);

  /** Route exit clears ephemeral state; nothing persisted is affected. */
  useEffect(
    () => () => {
      setPreview(null);
      setSlotEditor(CLOSED_EDITOR);
    },
    [],
  );

  /**
   * Apply a route-supplied Closet item ONCE, and only after everything it is
   * validated against has loaded. `routeAppliedRef` is what stops a focus
   * revalidation from re-writing an anchor the user has since changed.
   */
  useEffect(() => {
    const intent = resolveRouteAnchorIntent(view, routeClosetItemId);
    if (!intent || routeAppliedRef.current === intent || busy) return;
    routeAppliedRef.current = intent;
    if (view.status === 'active') {
      // Same confirmation path as chip-driven anchor changes: persisted edits
      // must not be silently discarded by a deep-link.
      void requestContextChange({ kind: 'anchor', anchorClosetItemId: intent });
    } else {
      void startSession({ anchorClosetItemId: intent });
    }
  }, [view, routeClosetItemId, busy, requestContextChange, startSession]);

  return {
    ...view,
    busy,
    compositionStatus: current.status,
    compositionError: current.errorCode,
    compositionRecovered: current.recovered,
    looks,
    activeLookId: current.composition?.activeLookId ?? null,
    startSession,
    resumeSession,
    discardSession,
    resetSession,
    selectLook,
    rebuildOutfits,
    retry,
    resetComposition,
    revalidate: hydrate,

    // ── Phase 3 ──────────────────────────────────────────────────────────────
    interactionsEnabled: PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE,
    interactionLoading: activeInteraction.loading,
    interactionCorrupt: activeInteraction.corrupt,
    interactionRecovered: activeInteraction.recovered,
    missingSwappedItems: activeInteraction.missing,
    effectiveLooks,
    canUndo: (activeInteraction.state?.history.length ?? 0) > 0,
    hasEdits: hasPersistedEdits,
    slotEditor,
    preview,
    comparison,
    comparing,
    canCompareLooks: PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE && canCompare(effectiveLooks),
    comparedLookIds,
    pendingContextChange,
    openSlotEditor,
    closeSlotEditor,
    previewSlotCandidate,
    clearSlotPreview,
    applySlotCandidate,
    restoreOriginalSlot,
    undoLastSwap,
    resetCorruptInteraction,
    openComparison,
    setComparedLooks,
    closeComparison,
    requestContextChange,
    confirmContextChange,
    cancelContextChange,
    refreshInteraction,
  };
}
