/**
 * THE Closet intake fork (Closet Upgrade Build 1).
 *
 * One photo, two possible destinations, and exactly one place that decides which:
 *
 *   staging OFF -> services/closetLibrary.js   committed Closet item, today's behaviour
 *   staging ON  -> services/closetCandidateLibrary.js  candidate awaiting review
 *
 * WHY THIS IS A MODULE AND NOT AN `if` IN THE SCREEN. The audit found the intake
 * modal wired straight to the committed-Closet hook, so the entire candidate
 * pipeline was unreachable in the shipped app while every unit test passed — the
 * store was exercised directly and nothing asserted that a screen ever called it.
 * A pure function with both destinations INJECTED is the fix: the fork can be
 * executed in a test with two spies, so "flag on routes to candidates" and "flag
 * off never touches candidates" are behavioural facts rather than a reading of
 * the screen's source.
 *
 * THIS MODULE DOES NOT: normalize, resize, hash or persist media, mint records,
 * or talk to a network. It chooses a destination and shapes the arguments. Media
 * work belongs to the service behind whichever destination is chosen, and doing
 * any of it here would duplicate it across the two paths.
 *
 * THE LEGACY PATH IS NOT DEPRECATED. With staging off, `routeClosetIntake` is a
 * pass-through to exactly the call the screen made before this module existed.
 */

/**
 * Closet intake sources Build 1 accepts.
 *
 * `camera` and `gallery` are the candidate store's vocabulary and map onto the
 * contract entry paths `closet_camera` / `closet_gallery` inside
 * services/closetIdentificationV2.ts. Neither is a Recent Scan: a Closet intake
 * that described itself as a scan would be indistinguishable downstream from a
 * capture that is allowed to shop.
 */
export const CLOSET_INTAKE_SOURCES = Object.freeze(['camera', 'gallery']);

/**
 * Anything that is not explicitly a camera capture is treated as a gallery pick.
 *
 * Fail toward `gallery` deliberately: it is the weaker claim. Labelling a library
 * photo as a fresh camera capture would assert provenance we do not have.
 */
export function normalizeClosetIntakeSource(sourceType) {
  return sourceType === 'camera' ? 'camera' : 'gallery';
}

/** Which store a given staging capability routes to. Pure, for tests and callers. */
export function resolveClosetIntakeTarget(stagingActive) {
  return stagingActive === true ? 'candidate' : 'committed';
}

/**
 * Normalize a candidate-store result into the `{ ok, reason }` shape the intake
 * modal already understands.
 *
 * Every non-created outcome is surfaced as a REASON, never swallowed: a duplicate
 * and a storage-full rejection are different things to tell the user, and the
 * modal's copy switches on exactly this field.
 */
export function normalizeCandidateIntakeResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'candidate_persist_failed' };
  }
  if (result.kind === 'created') {
    return { ok: true, candidateId: result.candidate?.candidateId ?? null, kind: 'created' };
  }
  // A photo that resolved to an existing candidate or an already-committed item
  // is not an error the user must fix — the thing they wanted is already there.
  if (result.kind === 'deduped_candidate' || result.kind === 'duplicate_of_closet') {
    return {
      ok: true,
      candidateId: result.candidate?.candidateId ?? null,
      kind: result.kind,
      reason: result.code ?? null,
    };
  }
  if (result.kind === 'already_in_closet') {
    return { ok: true, kind: 'already_in_closet', reason: 'already_in_closet' };
  }
  return { ok: false, reason: result.code ?? 'candidate_persist_failed' };
}

/**
 * Route one intake.
 *
 * @param {object} input
 * @param {boolean} input.stagingActive     resolved capability, NOT a raw flag
 * @param {string}  input.sourceUri         picker-owned URI; never persisted as-is
 * @param {string}  input.sourceType        'camera' | 'gallery'
 * @param {object}  [input.draft]           optional user-entered title/category
 * @param {Function} input.committedIntake  (sourceUri, draft) => {ok, reason}
 * @param {Function} input.candidateIntake  (sourceUri, intake) => candidate result
 * @param {Function} [input.createBatchId]  batch id minter
 */
export async function routeClosetIntake(input) {
  const sourceUri = typeof input?.sourceUri === 'string' ? input.sourceUri.trim() : '';
  if (!sourceUri) return { ok: false, reason: 'candidate_media_unreadable' };

  const draft = input?.draft && typeof input.draft === 'object' ? input.draft : {};
  const sourceType = normalizeClosetIntakeSource(input?.sourceType);

  if (resolveClosetIntakeTarget(input?.stagingActive) === 'committed') {
    if (typeof input?.committedIntake !== 'function') {
      return { ok: false, reason: 'closet_intake_unavailable' };
    }
    const result = await input.committedIntake(sourceUri, draft);
    return result && typeof result === 'object' ? result : { ok: false, reason: 'closet_intake_failed' };
  }

  if (typeof input?.candidateIntake !== 'function') {
    return { ok: false, reason: 'closet_intake_unavailable' };
  }

  // Every intake gets a batch id, including a single photo. Build 2's review
  // surface addresses a batch, and a record minted without one would have to be
  // special-cased there forever.
  const batchId =
    typeof input?.createBatchId === 'function' ? input.createBatchId() : undefined;

  const result = await input.candidateIntake(sourceUri, {
    sourceType,
    ...(batchId ? { batchId } : {}),
    draft,
  });
  return normalizeCandidateIntakeResult(result);
}
