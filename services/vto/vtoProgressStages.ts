/**
 * Multi-stage progress model for a running try-on.
 *
 * WHY THIS IS NOT A PERCENTAGE. The provider reports no progress fraction, so
 * any number would be invented. A stalled "90%" is a worse experience than
 * honest phrasing -- see the original rotating-status comment in
 * VirtualTryOnSheet. What we DO have is a real three-step state machine
 * (preparing -> generating -> validating_result), and naming those actual
 * states is both truthful and more useful than one undifferentiated spinner.
 *
 * Status alone selects the stage. Time may add only a "still working" note; it
 * cannot advance the stage or produce completion. `complete` is returned if
 * and only if the store says `success`, after result validation.
 *
 * Pure and dependency-free on purpose, so the honesty rule above is covered by
 * `node --test` rather than by reading a component.
 */

import type { VtoGenerationStatus } from '../../types/vto';

export interface VtoProgressStage {
  key: 'preparing' | 'creating' | 'finishing';
  label: string;
}

/** Ordered and stable: index is identity for the UI's step dots. */
export const VTO_PROGRESS_STAGES: readonly VtoProgressStage[] = Object.freeze([
  Object.freeze({ key: 'preparing' as const, label: 'Preparing your photo…' }),
  Object.freeze({ key: 'creating' as const, label: 'Creating your try-on…' }),
  Object.freeze({ key: 'finishing' as const, label: 'Finishing your result…' }),
]);

export const VTO_PROGRESS_LAST_INDEX = VTO_PROGRESS_STAGES.length - 1;

/**
 * Elapsed-time threshold (ms from generation start) for an additional honest
 * still-working message. It does not change the reported stage.
 */
export const VTO_PROGRESS_STILL_WORKING_MS = 15_000;

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

export type VtoProgressView =
  /** A generation is running; render the stepper at `index`. */
  | {
      running: true;
      complete: false;
      index: number;
      stage: VtoProgressStage;
      total: number;
      stillWorking: boolean;
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

  const index = Math.min(floor, VTO_PROGRESS_LAST_INDEX);
  const elapsed = Number.isFinite(input.elapsedMs) && input.elapsedMs > 0 ? input.elapsedMs : 0;

  return {
    running: true,
    complete: false,
    index,
    stage: VTO_PROGRESS_STAGES[index],
    total: VTO_PROGRESS_STAGES.length,
    stillWorking: elapsed >= VTO_PROGRESS_STILL_WORKING_MS,
  };
}

/** Copy for the collapsed pill, which has no room for a stepper. */
export const VTO_PILL_RENDERING_LABEL = 'Try-On Rendering…';
export const VTO_PILL_READY_LABEL = 'Try-On Ready';
export const VTO_PILL_RETURN_LABEL = 'Back to Try-On';
