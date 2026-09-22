/**
 * Multi-stage progress model for a running try-on.
 *
 * WHY THIS IS NOT A PERCENTAGE. The provider reports no progress fraction, so
 * any number would be invented. A stalled "90%" is a worse experience than
 * honest phrasing. What we DO have is a real three-step state machine in the
 * store (preparing -> generating -> validating_result), and naming those steps
 * is both truthful and considerably less alarming across a long wait than one
 * undifferentiated spinner.
 *
 * ONE RULE: THE STAGE IS THE STORE'S STATUS. Build 35 decision-loop polish
 * (brief §17: "only use stages that correspond reasonably to actual client
 * state") removed the elapsed-time advancement this module used to have. The
 * old labels ("Mapping the fit", "Rendering visualization") were reached on a
 * timer while the provider call was still running, so at 12s the customer read
 * that K Scan was finishing -- and that it was modelling fit, which it never
 * does. Now:
 *
 *   preparing          -> "Preparing your photo"   (the payload is being built)
 *   generating         -> "Creating your try-on"   (the request is out)
 *   validating_result  -> "Finishing your result"  (the image is being checked)
 *
 * A long `generating` phase is acknowledged with `stillWorking` copy instead of
 * a stage the work has not reached. `complete` is still returned if and only
 * if the store says `success`, which it sets only after validation -- no
 * elapsed time can produce it.
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
 * Elapsed time (ms from generation start) after which a still-running
 * generation is acknowledged as taking a while. Copy only: it never moves the
 * stage and never implies completion.
 */
export const VTO_PROGRESS_STILL_WORKING_MS = 15_000;

/**
 * The stage each real status IS. `null` means "this status is
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
      /** The wait has passed VTO_PROGRESS_STILL_WORKING_MS. Reassurance
       *  copy only -- the stage above is unchanged by it. */
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
