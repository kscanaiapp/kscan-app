/**
 * React binding for the VTO request lifecycle.
 *
 * The store (services/vto/vtoRequestStore.ts) owns the state and the stale
 * result rule; this hook only subscribes to it and exposes the actions. That
 * split is deliberate: unmounting a screen must not be able to strand an
 * in-flight generation in a state nobody can clear, and a late result must be
 * rejectable after the component that started it is gone.
 *
 * SESSION-SCOPED PERSON PHOTO. The store's person photo outlives one sheet
 * instance on purpose: closing the sheet (navigation away, unmount, the
 * Close button) calls `leaveVtoSurface`, not a hard reset, so trying a
 * second product in the same session reuses the same photo instead of
 * asking the user to pick it again. On mount, if the store already holds a
 * photo attached to a DIFFERENT product than this sheet's, the hook reattaches
 * it to the current garment via `attachSessionPerson` -- same photo, fresh
 * generation state, so a stale result from a different product can never
 * render under this one.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';

import {
  attachSessionPerson,
  cancelVtoGeneration,
  getVtoSnapshot,
  leaveVtoSurface,
  resetVtoRequestState,
  retryVtoGeneration,
  setVtoPersonInput,
  startVtoGeneration,
  subscribeToVto,
  type VtoSnapshot,
} from '../services/vto/vtoRequestStore';
import {
  pickVtoPersonInput,
  type VtoPersonPickOutcome,
} from '../services/vto/vtoPersonInput';
import type { VtoGarmentInput, VtoOrigin, VtoPersonInput } from '../types/vto';

export interface UseVirtualTryOnArgs {
  garment: VtoGarmentInput;
  origin: VtoOrigin;
  /** Development only; the server ignores it unless that deployment opted in. */
  devScenario?: string;
}

export interface UseVirtualTryOnResult extends VtoSnapshot {
  isBusy: boolean;
  canGenerate: boolean;
  selectPerson: () => Promise<VtoPersonPickOutcome>;
  generate: () => void;
  retry: () => void;
  cancel: () => void;
  /** Closes the sheet's session; the person photo survives for reuse. */
  dismiss: () => void;
  /** Explicitly drops the session photo and its cache files. Distinct from
   *  `dismiss` -- this is the "start over with a different person" action,
   *  not "I'm done looking for now". */
  clearPerson: () => void;
  /**
   * Adopts a person input this hook did not pick.
   *
   * The one caller is the Live -> Photoreal handoff, which produces a clean
   * person frame through the SAME privacy sanitizer `selectPerson` uses
   * (services/vto/vtoPhotorealHandoff.ts) and then hands it here so the
   * generation runs down the ordinary governed path -- same store, same stale
   * result rule, same client, same Edge Function, same entitlement, quota,
   * reservation and idempotency. It exists so Live does not need a second
   * generative path, which is exactly what a bypass would be.
   *
   * Additive: `selectPerson` and every existing caller are unchanged.
   */
  adoptPerson: (person: VtoPersonInput) => void;
}

const BUSY_STATUSES = new Set(['preparing', 'generating', 'validating_result']);

export function useVirtualTryOn(args: UseVirtualTryOnArgs): UseVirtualTryOnResult {
  const snapshot = useSyncExternalStore(subscribeToVto, getVtoSnapshot, getVtoSnapshot);
  const argsRef = useRef(args);
  argsRef.current = args;

  // Reconcile BEFORE paint: if a prior sheet in this session left a person
  // photo attached to a different product, reattach it to this one here so
  // the first frame never shows a mismatched garment/result.
  useLayoutEffect(() => {
    const current = getVtoSnapshot();
    if (current.person && current.garment?.productRef !== argsRef.current.garment.productRef) {
      attachSessionPerson(argsRef.current.garment, argsRef.current.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.garment.productRef]);

  // Unmount closes the session's SURFACE, not the session: any in-flight
  // generation is torn down (the provider request may still finish; it just
  // has no authority to update anything), but the chosen photo is kept for
  // the next product this actor tries on.
  useEffect(() => {
    return () => {
      leaveVtoSurface();
    };
  }, []);

  const selectPerson = useCallback(async (): Promise<VtoPersonPickOutcome> => {
    const outcome = await pickVtoPersonInput();
    if (outcome.ok) {
      setVtoPersonInput(outcome.person, argsRef.current.garment, argsRef.current.origin);
    }
    return outcome;
  }, []);

  const generate = useCallback(() => {
    void startVtoGeneration({
      garment: argsRef.current.garment,
      origin: argsRef.current.origin,
      devScenario: argsRef.current.devScenario,
    });
  }, []);

  const retry = useCallback(() => {
    void retryVtoGeneration({
      garment: argsRef.current.garment,
      origin: argsRef.current.origin,
      devScenario: argsRef.current.devScenario,
    });
  }, []);

  const cancel = useCallback(() => {
    cancelVtoGeneration();
  }, []);

  const dismiss = useCallback(() => {
    leaveVtoSurface();
  }, []);

  const clearPerson = useCallback(() => {
    resetVtoRequestState();
  }, []);

  const adoptPerson = useCallback((person: VtoPersonInput) => {
    setVtoPersonInput(person, argsRef.current.garment, argsRef.current.origin);
  }, []);

  const isBusy = BUSY_STATUSES.has(snapshot.status);

  return {
    ...snapshot,
    isBusy,
    // A second tap while busy is not merely ignored by the UI -- the store
    // supersedes it -- but the affordance should not invite it either.
    canGenerate: !isBusy && snapshot.person !== null,
    selectPerson,
    generate,
    retry,
    cancel,
    dismiss,
    clearPerson,
    adoptPerson,
  };
}
