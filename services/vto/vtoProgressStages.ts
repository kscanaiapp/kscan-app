/**
 * Multi-stage progress model for a running try-on.
 *
 * WHY THIS IS NOT A PERCENTAGE. The provider reports no progress fraction, so
 * any number would be invented. A stalled "90%" is a worse experience than
 * honest phrasing -- see the original rotating-status comment in
 * VirtualTryOnSheet. What we DO have is a real three-step state machine
 * (preparing -> generating -> validating_result), and naming those steps is
 * both truthful and considerably less alarming across a 15-30s wait than one
 * undifferentiated spinner.
 *
 * TWO INPUTS, ONE RULE. The stage shown is the LATER of:
 *   1. the floor implied by the real store status  -- never lags reality, and
 *   2. a time-derived index                        -- so a long `generating`
 *                                                     phase still advances.
 * Time may only ever move the indicator FORWARD WITHIN the stage list. It can
 * never produce completion: `complete` is returned if and only if the store
 * says `success`, which the store sets only after the result is validated.
 * That is the invariant this module exists to make testable.
 *
 * Pure and dependency-free on purpose, so the honesty rule above is covered by
 * `node --test` rather than by reading a component.
 */

import type { VtoGenerationStatus } from '../../types/vto';

export interface VtoProgressStage {
  key: 'analyzing' | 'mapping' | 'rendering';
  label: string;
}

/** Ordered and stable: index is identity for the UI's step dots. */
export const VTO_PROGRESS_STAGES: readonly VtoProgressStage[] = Object.freeze([
  Object.freeze({ key: 'analyzing' as const, label: 'Analyzing garment' }),
  Object.freeze({ key: 'mapping' as const, label: 'Mapping the fit' }),
  Object.freeze({ key: 'rendering' as const, label: 'Rendering visualization' }),
]);

export const VTO_PROGRESS_LAST_INDEX = VTO_PROGRESS_STAGES.length - 1;

/**
 * Elapsed-time thresholds (ms from generation start) at which the time-derived
 * stage reaches each index. Tuned to the observed 15-30s envelope: the first
 * hand-off happens quickly, the long middle is the provider call, and the last
 * step is entered well before a typical finish so the indicator is not still
 * sitting on step 2 when the image lands.
 */
export const VTO_PROGRESS_STAGE_ELAPSED_MS: readonly number[] = Object.freeze([
  0,
  4_000,
  12_000,
]);

/**
 * The minimum stage each real status guarantees. `null` means "this status is
 * not a running generation at all", which is how callers detect that there is
 * no progress UI to show.
 */
function stageFloorForStatus(status: VtoGenerationStatus): number | null {
  switch (status) {
    case 'preparing':
      return 0;
    case 'generating':
      return 1;
    case 'validating_result':
      return 2;
    default:
      return null;
  }
}

function timeDerivedStage(elapsedMs: number): number {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  let index = 0;
  for (let i = 0; i < VTO_PROGRESS_STAGE_ELAPSED_MS.length; i += 1) {
    if (elapsed >= VTO_PROGRESS_STAGE_ELAPSED_MS[i]) index = i;
  }
  // Time is never allowed past the final stage -- it must not imply completion.
  return Math.min(index, VTO_PROGRESS_LAST_INDEX);
}

export type VtoProgressView =
  /** A generation is running; render the stepper at `index`. */
  | {
      running: true;
      complete: false;
      index: number;
      stage: VtoProgressStage;
      total: number;
    }
  /** The result exists AND was validated by the store. */
  | { running: false; complete: true }
  /** Nothing in flight (idle / ready / failed / cancelled). */
  | { running: false; complete: false };

/**
 * Resolves what the progress UI should show.
 *
 * `complete: true` is reachable ONLY from status `success`. No elapsed time,
 * however long, can produce it.
 */
export function resolveVtoProgress(input: {
  status: VtoGenerationStatus;
  elapsedMs: number;
}): VtoProgressView {
  if (input.status === 'success') {
    return { running: false, complete: true };
  }

  const floor = stageFloorForStatus(input.status);
  if (floor === null) {
    return { running: false, complete: false };
  }

  const index = Math.min(
    Math.max(floor, timeDerivedStage(input.elapsedMs)),
    VTO_PROGRESS_LAST_INDEX,
  );

  return {
    running: true,
    complete: false,
    index,
    stage: VTO_PROGRESS_STAGES[index],
    total: VTO_PROGRESS_STAGES.length,
  };
}

/** Copy for the collapsed pill, which has no room for a stepper. */
export const VTO_PILL_RENDERING_LABEL = 'Try-On Rendering…';
export const VTO_PILL_READY_LABEL = 'Try-On Ready';
