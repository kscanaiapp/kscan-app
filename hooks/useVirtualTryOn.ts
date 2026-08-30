/**
 * React binding for the VTO request lifecycle.
 *
 * The store (services/vto/vtoRequestStore.ts) owns the state and the stale
 * result rule; this hook only subscribes to it and exposes the actions. That
 * split is deliberate: unmounting a screen must not be able to strand an
 * in-flight generation in a state nobody can clear, and a late result must be
 * rejectable after the component that started it is gone.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSyncExternalStore } from 'react';

import {
  cancelVtoGeneration,
  dismissVto,
  getVtoSnapshot,
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
import type { VtoGarmentInput, VtoOrigin } from '../types/vto';

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
  dismiss: () => void;
}

const BUSY_STATUSES = new Set(['preparing', 'generating', 'validating_result']);

export function useVirtualTryOn(args: UseVirtualTryOnArgs): UseVirtualTryOnResult {
  const snapshot = useSyncExternalStore(subscribeToVto, getVtoSnapshot, getVtoSnapshot);
  const argsRef = useRef(args);
  argsRef.current = args;

  // Unmount tears the operation down rather than leaving a generation running
  // against a screen that no longer exists. The provider request may still
  // finish; it simply has no authority to update anything.
  useEffect(() => {
    return () => {
      dismissVto();
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
    dismissVto();
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
  };
}
