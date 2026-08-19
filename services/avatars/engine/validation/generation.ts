/**
 * Speech generation and motion epoch are both monotonic non-negative integer
 * counters, but they are different authorities and are never collapsed:
 * `speechGeneration` says which utterance a frame belongs to, `motionEpoch`
 * says which visual lifetime it belongs to. A visual reset therefore bumps only
 * the epoch and can be repeated freely without retiring the next real utterance.
 */
export function isValidGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function isValidMotionEpoch(value: unknown): value is number {
  return isValidGeneration(value);
}
