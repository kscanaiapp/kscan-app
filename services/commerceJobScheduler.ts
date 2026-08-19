/**
 * Pure per-item commerce hydration scheduling decisions (v127 Android, P1-C).
 *
 * Extracted out of hooks/useKScan.js so the exact race conditions that caused
 * item-switch data loss can be exercised with real Map/object values under
 * `node --test`, rather than asserted against source text. The hook is a
 * React hook (useState/useEffect/useRef) and cannot be executed under this
 * project's plain Node test runner; every decision that matters for
 * correctness here has no React dependency at all, so it belongs in its own
 * module rather than inline in the hook.
 *
 * None of this touches React state directly — callers own the Map, the refs,
 * and the setState calls; these functions only decide whether to act.
 */

export type CommerceJob = {
  controller: { abort: () => void } | null;
  evidence: unknown;
  scanGeneration: number;
  active: boolean;
  status: string;
};

/** The Map key for an item's job slot. Falls back to the evidence object
 * itself when no stable id exists, so a job still exists to single-flight
 * against. */
export function commerceJobKey(evidence: { itemId?: string | null } | null | undefined): unknown {
  return evidence?.itemId || evidence;
}

/**
 * Should this dispatch actually start a new commerce request?
 *
 *   - Automatic (non-retry) dispatch is single-shot per evidence object: once
 *     a job exists for it — active OR already settled — dispatching again
 *     must be refused. Without the "or settled" half, an effect re-firing
 *     after the job completes (e.g. `status` toggling away and back with
 *     `commerceEvidence` unchanged) would issue a duplicate network call for
 *     an already-hydrated item.
 *   - An explicit retry may supersede a settled attempt for this item, but
 *     must never race a live one.
 */
export function shouldDispatchCommerceHydration(
  existingJob: CommerceJob | undefined,
  evidence: unknown,
  isRetry: boolean,
): boolean {
  if (!existingJob || existingJob.evidence !== evidence) return true;
  if (!isRetry) return false;
  return !existingJob.active;
}

/**
 * May a settling job's result still be applied?
 *
 * A late answer belongs to this job as long as (a) no NEW SCAN superseded it
 * — a whole-scan supersession bumps the generation and clears every job at
 * once — and (b) this is still the job stored for the item; a newer dispatch
 * for the SAME item (e.g. a retry) replaces the map entry, and the superseded
 * job's own late completion must not apply.
 *
 * Deliberately NOT gated on "is this item currently selected" — item A must
 * be able to update/persist its own data while item B is displayed. Use
 * `isCommerceJobVisible` separately to decide whether to also touch the
 * user-visible commerceStatus/analysis.
 */
export function isCommerceJobCurrent(
  jobs: Map<unknown, CommerceJob>,
  itemKey: unknown,
  job: CommerceJob,
  currentScanGeneration: number,
): boolean {
  if (currentScanGeneration !== job.scanGeneration) return false;
  return jobs.get(itemKey) === job;
}

/** Is this job's item the one currently displayed? */
export function isCommerceJobVisible(
  evidenceItemId: string | null | undefined,
  selectedScanItemId: string | null | undefined,
): boolean {
  return Boolean(evidenceItemId) && evidenceItemId === selectedScanItemId;
}
