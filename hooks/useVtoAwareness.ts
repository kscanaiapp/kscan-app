/**
 * React bindings for VTO customer discovery.
 *
 * Every decision is made by the pure model in services/vto/vtoDiscovery.ts;
 * these hooks only gather its inputs from the authorities that already exist
 * (the build flag, the remote row, the canonical K+ summary, the running
 * try-on session, the K+ commerce state) and re-render when one changes.
 *
 * AWARENESS IS PRESENTATION. Nothing in this file can start a generation, open
 * a photo chooser or reach a camera -- there is no import here that could --
 * and none of it issues a provider or model request. The only network read is
 * the one memoized remote-config row every Try It On control already shares.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AppState, Dimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { VTO_UI_ENABLED } from '../constants/featureFlags';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useKPlusCommerceSnapshot } from './useKPlusCommerce';
import { useKPlusEntitlement } from './useKPlusEntitlement';
import { useVtoSessionStatus } from './useVtoSessionStatus';
import {
  acquireVtoAwarenessBlocker,
  dismissVtoCue,
  dismissVtoHomeCard,
  emitVtoAwarenessDismissed,
  emitVtoAwarenessImpression,
  emitVtoAwarenessTap,
  isVtoAwarenessBlocked,
  loadVtoAwareness,
  noteVtoCuePresented,
  readVtoAwareness,
  readVtoAwarenessSession,
  subscribeVtoAwareness,
} from '../services/vto/vtoAwareness';
import {
  advanceVtoCueEncounter,
  advanceVtoViewDwell,
  isVtoRectInWindow,
  resolveVtoActorKPlusState,
  resolveVtoFirstUseCue,
  resolveVtoHomeCard,
  resolveVtoSurfaceAvailability,
  VTO_MEANINGFUL_VIEW,
  VTO_VIEW_DWELL_IDLE,
  type VtoActorKPlusState,
  type VtoAwarenessRecord,
  type VtoAwarenessSession,
  type VtoCueCollisions,
  type VtoCueEncounter,
  type VtoHomeCardState,
  type VtoProductCta,
  type VtoSurfaceAvailability,
  type VtoViewDwell,
} from '../services/vto/vtoDiscovery';
import { getVtoRemoteConfig } from '../services/vto/vtoFeatureControl';
import { isKPlusEntitlementUnresolved } from '../types/entitlements';

/** A store operation or its confirmation is under way. */
const COMMERCE_BUSY = new Set<string>([
  'PURCHASING',
  'RESTORING',
  'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING',
  'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING',
]);

/** Any try-on status in which a photo is being chosen or a request is live. */
const VTO_SESSION_BUSY = new Set<string>([
  'selecting_input',
  'validating',
  'preparing',
  'generating',
  'validating_result',
]);

// ── Shared snapshots ─────────────────────────────────────────────────────────

interface VtoAwarenessSnapshot {
  awareness: VtoAwarenessRecord | null;
  session: VtoAwarenessSession;
}

/** The current account's history and session memory, kept current. */
function useVtoAwarenessSnapshot(): VtoAwarenessSnapshot {
  const { user, isAuthenticated } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const [, setRevision] = useState(0);

  useEffect(() => subscribeVtoAwareness(() => setRevision((revision) => revision + 1)), []);

  // Re-read whenever the account changes, so one account never renders from
  // another's history.
  useEffect(() => {
    if (!VTO_UI_ENABLED || !actorId) return;
    void loadVtoAwareness();
  }, [actorId]);

  return {
    awareness: actorId ? readVtoAwareness() : null,
    session: readVtoAwarenessSession(),
  };
}

/** Whether awareness may be shown at all. See resolveVtoSurfaceAvailability. */
export function useVtoSurfaceAvailability(): VtoSurfaceAvailability {
  const { isAuthenticated } = useAuthSession();
  const [remote, setRemote] = useState<{ enabled: boolean; awarenessEnabled: boolean } | null>(null);

  useEffect(() => {
    if (!VTO_UI_ENABLED || !isAuthenticated) {
      setRemote(null);
      return undefined;
    }
    let cancelled = false;
    void getVtoRemoteConfig().then((config) => {
      if (cancelled) return;
      setRemote({ enabled: config.enabled === true, awarenessEnabled: config.awarenessEnabled === true });
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  return resolveVtoSurfaceAvailability({
    uiEnabled: VTO_UI_ENABLED,
    authenticated: isAuthenticated,
    remote,
  });
}

/** The bounded K+ dimension awareness telemetry carries. */
export function useVtoActorKPlusState(): VtoActorKPlusState {
  const { state, displaySource } = useKPlusEntitlement();
  return resolveVtoActorKPlusState({ state, displaySource });
}

// ── Home discovery card ──────────────────────────────────────────────────────

export interface UseVtoHomeCardResult {
  visible: boolean;
  state: VtoHomeCardState;
  kplus: VtoActorKPlusState;
  /** Reports the primary tap. Navigation stays with the caller. */
  notePrimaryTap: () => void;
  dismiss: () => void;
}

export function useVtoHomeCard(): UseVtoHomeCardResult {
  const surface = useVtoSurfaceAvailability();
  const { awareness, session } = useVtoAwarenessSnapshot();
  const kplus = useVtoActorKPlusState();
  const decision = resolveVtoHomeCard({ surface, awareness, session });

  useEffect(() => {
    if (decision.visible) emitVtoAwarenessImpression({ surface: 'home', kplus });
  }, [decision.visible, kplus]);

  const notePrimaryTap = useCallback(() => {
    emitVtoAwarenessTap({ surface: 'home', kplus });
  }, [kplus]);

  const dismiss = useCallback(() => {
    emitVtoAwarenessDismissed({ surface: 'home', kplus });
    dismissVtoHomeCard();
  }, [kplus]);

  return { visible: decision.visible, state: decision.state, kplus, notePrimaryTap, dismiss };
}

// ── First-use cue ────────────────────────────────────────────────────────────

/** The one native call the cue needs from its target. */
export interface VtoMeasurable {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}

export interface UseVtoFirstUseCueArgs {
  /** What the product control this cue points at currently does. */
  cta: VtoProductCta;
  /** The Try It On control. Measured, never modified. */
  targetRef: RefObject<VtoMeasurable | null>;
}

export interface UseVtoFirstUseCueResult {
  visible: boolean;
  kplus: VtoActorKPlusState;
  /** Reports "Try it on" from the cue and retires it. Opening the control stays
   *  with the caller. */
  notePrimaryTap: () => void;
  dismiss: () => void;
}

/**
 * Decides whether THIS product control shows the first-use cue.
 *
 * The control is only measured while the cue could still be shown to this
 * account in this session; for everyone else no timer runs at all. A view that
 * completes at the wrong moment is spent, not queued: nothing is shown when the
 * collision clears, and the cue is considered again only after the control has
 * left the window and been viewed afresh.
 */
export function useVtoFirstUseCue({ cta, targetRef }: UseVtoFirstUseCueArgs): UseVtoFirstUseCueResult {
  const surface = useVtoSurfaceAvailability();
  const { awareness, session } = useVtoAwarenessSnapshot();
  const { state: kplusState, displaySource } = useKPlusEntitlement();
  const commerce = useKPlusCommerceSnapshot();
  const vtoSession = useVtoSessionStatus();
  const kplus = resolveVtoActorKPlusState({ state: kplusState, displaySource });
  const [encounter, setEncounter] = useState<VtoCueEncounter>('watching');
  // Mirrored in a ref so a measurement callback moves the encounter exactly
  // once, outside React's state updater.
  const encounterRef = useRef<VtoCueEncounter>('watching');
  const moveEncounter = useCallback((event: Parameters<typeof advanceVtoCueEncounter>[1]) => {
    const next = advanceVtoCueEncounter(encounterRef.current, event);
    if (next === encounterRef.current) return;
    encounterRef.current = next;
    setEncounter(next);
  }, []);

  const focusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      return () => {
        focusedRef.current = false;
      };
    }, []),
  );

  // Read at measurement time, so a decision is never made on a stale render.
  const liveRef = useRef({ surface, awareness, session, cta, kplusState, commerce, vtoSession, kplus });
  liveRef.current = { surface, awareness, session, cta, kplusState, commerce, vtoSession, kplus };

  const collisionsNow = useCallback((): VtoCueCollisions => {
    const live = liveRef.current;
    return {
      kplusResolving: isKPlusEntitlementUnresolved(live.kplusState),
      modalPresenting: isVtoAwarenessBlocked(),
      vtoRequestActive: VTO_SESSION_BUSY.has(live.vtoSession.status),
      purchaseInFlight: COMMERCE_BUSY.has(live.commerce.status),
      surfaceUnstable: !focusedRef.current,
      appInactive: AppState.currentState !== 'active',
    };
  }, []);

  // Could the cue still be shown to this account, ignoring the moment? When
  // not -- dismissed, used, retired, already shown this session -- nothing is
  // measured.
  const stillPossible = resolveVtoFirstUseCue({
    surface,
    cta,
    awareness,
    session,
    meaningfullyViewed: true,
    collisions: {
      kplusResolving: false,
      modalPresenting: false,
      vtoRequestActive: false,
      purchaseInFlight: false,
      surfaceUnstable: false,
      appInactive: false,
    },
  }).show;

  const watching = stillPossible && encounter !== 'presented';

  useEffect(() => {
    if (!watching) return undefined;
    let dwell: VtoViewDwell = VTO_VIEW_DWELL_IDLE;
    let active = true;

    const sample = () => {
      const target = targetRef.current;
      if (!active || !target || typeof target.measureInWindow !== 'function') return;
      target.measureInWindow((x, y, width, height) => {
        if (!active) return;
        const inWindow = isVtoRectInWindow({ x, y, width, height }, Dimensions.get('window'));
        if (!inWindow) {
          dwell = VTO_VIEW_DWELL_IDLE;
          moveEncounter({ type: 'left_window' });
          return;
        }
        const collisions = collisionsNow();
        const advanced = advanceVtoViewDwell(dwell, {
          inWindow,
          stable: !collisions.surfaceUnstable && !collisions.appInactive,
          nowMs: Date.now(),
        });
        dwell = advanced.dwell;
        if (!advanced.meaningfullyViewed || encounterRef.current !== 'watching') return;

        const live = liveRef.current;
        const decision = resolveVtoFirstUseCue({
          surface: live.surface,
          cta: live.cta,
          awareness: live.awareness,
          // Re-read rather than taken from the render: another product card
          // may have claimed the session's one presentation a moment ago.
          session: readVtoAwarenessSession(),
          meaningfullyViewed: true,
          collisions,
        });
        if (decision.show) {
          noteVtoCuePresented();
          emitVtoAwarenessImpression({ surface: 'coachmark', kplus: live.kplus });
        }
        moveEncounter({ type: 'viewed', decision });
      });
    };

    const timer = setInterval(sample, VTO_MEANINGFUL_VIEW.sampleMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [watching, targetRef, collisionsNow, moveEncounter]);

  // Acting on the cue answers it: whichever way the tap goes next (the try-on
  // sheet, or the K+ sheet for a Free actor), the cue has done its job and is
  // not shown again.
  const notePrimaryTap = useCallback(() => {
    emitVtoAwarenessTap({ surface: 'coachmark', kplus });
    dismissVtoCue();
  }, [kplus]);

  const dismiss = useCallback(() => {
    emitVtoAwarenessDismissed({ surface: 'coachmark', kplus });
    dismissVtoCue();
  }, [kplus]);

  const visible =
    encounter === 'presented'
    && surface === 'available'
    && cta !== 'none'
    && !!awareness
    && !awareness.cueDismissed
    && !awareness.initiated
    && !awareness.completed;

  return { visible, kplus, notePrimaryTap, dismiss };
}

// ── Blockers ─────────────────────────────────────────────────────────────────

/**
 * Declares a modal or sheet as presenting for as long as `active` is true, so
 * the first-use cue never appears while it is up.
 */
export function useVtoAwarenessBlocker(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    return acquireVtoAwarenessBlocker();
  }, [active]);
}
