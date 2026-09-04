/**
 * Frame-source contract — P3-B amendment Section 9, and the reconciliation
 * with Phase 1-2's existing (differently-named) emulator-validation-lane
 * vocabulary.
 *
 * "Support at least two frame-source modes: CAMERA, NATIVE_REPLAY. Optional:
 * EMULATOR_VIRTUAL_CAMERA." This is the PRODUCTION vocabulary a real runtime
 * exposes. It is deliberately coarser than the vocabulary already in
 * `native/ios/LiveVTOPerceptionProvider.swift` /
 * `native/android/.../LiveVTOPerceptionProvider.kt`
 * (`EMULATOR_CAMERA | SIMULATOR_CAMERA | NATIVE_REPLAY_FIXTURE`), which
 * exists specifically to keep emulator-lane evidence from being mislabeled
 * as device evidence -- a VALIDATION-LANE concern, not a runtime one. Both
 * vocabularies are kept, reconciled by `RUNTIME_FRAME_SOURCE_BY_VALIDATION_LANE`
 * below, rather than one silently replacing the other.
 */

export const FRAME_SOURCES = ['CAMERA', 'NATIVE_REPLAY', 'EMULATOR_VIRTUAL_CAMERA'] as const;
export type FrameSource = (typeof FRAME_SOURCES)[number];

/**
 * Phase 1-2's finer-grained, validation-lane-scoped vocabulary
 * (`native/ios/LiveVTOPerceptionProvider.swift`'s `FrameSource` enum). Kept
 * here, unmodified in meaning, so evidence already using these labels stays
 * classifiable against the newer production vocabulary above.
 */
export const VALIDATION_LANE_FRAME_SOURCES = [
  'EMULATOR_CAMERA',
  'SIMULATOR_CAMERA',
  'NATIVE_REPLAY_FIXTURE',
] as const;
export type ValidationLaneFrameSource = (typeof VALIDATION_LANE_FRAME_SOURCES)[number];

/**
 * The reconciliation. An emulator- or simulator-provided camera passthrough
 * is still, from the runtime's own perspective, "a camera" -- the
 * emulator/simulator distinction matters for how a HUMAN interprets the
 * resulting evidence (never as physical-device proof, per
 * docs/vto-phase3-native-blockers.md and Section 32/6 of the original P3-B
 * authorization), not for how the runtime itself behaves. `NATIVE_REPLAY`
 * is a direct rename of `NATIVE_REPLAY_FIXTURE` -- same mechanism, shorter
 * production name.
 */
export const RUNTIME_FRAME_SOURCE_BY_VALIDATION_LANE: Readonly<Record<ValidationLaneFrameSource, FrameSource>> = {
  EMULATOR_CAMERA: 'CAMERA',
  SIMULATOR_CAMERA: 'CAMERA',
  NATIVE_REPLAY_FIXTURE: 'NATIVE_REPLAY',
};

export function toRuntimeFrameSource(validationLane: ValidationLaneFrameSource): FrameSource {
  return RUNTIME_FRAME_SOURCE_BY_VALIDATION_LANE[validationLane];
}

/**
 * Perception provenance -- P3-B amendment Sections 10, 18 ("MASK
 * PROVENANCE... may not be omitted"). Identical vocabulary and identical
 * meaning to `@kscan-live-vto/realism`'s `ForegroundMaskProvenance`
 * (REAL_MODEL/NATIVE_REPLAY/PRECOMPUTED), generalized here to describe an
 * entire perception source (a BodyFrame stream, not only a mask stream) so
 * one report field can cover both. Deliberately not re-exported FROM
 * `realism` and re-declared identically here rather than the reverse,
 * because `native-runtime-contract` depending on `realism` for this one
 * type would be a real dependency for a trivial reason; the two are kept in
 * agreement by a contract test (`__tests__/frameSource.test.ts`) that
 * imports both and asserts the value sets are identical, so drift between
 * them fails loudly rather than silently.
 *
 * A fourth value, NONE, exists ONLY for this generalized perception-level
 * type (there is no mask/no BodyFrame at all -- e.g. session not started) --
 * `ForegroundMaskProvenance` has no NONE because a mask value always
 * describes a frame that exists, even an empty one.
 */
export const PERCEPTION_PROVENANCES = ['REAL_MODEL', 'NATIVE_REPLAY', 'PRECOMPUTED', 'NONE'] as const;
export type PerceptionProvenance = (typeof PERCEPTION_PROVENANCES)[number];

/**
 * REAL_MODEL provenance may be reported only once a real perception model
 * has actually compiled, loaded, processed input, and produced output --
 * never from a replay, and never from source code existing. See amendment
 * Section 10: "Do not report 'REAL_MODEL VALIDATED' until the actual
 * native model: compiles; loads; processes input; produces output. Replay
 * is not real-model validation." This function is the single place that
 * rule is checked mechanically rather than left to reviewer discipline.
 */
export interface PerceptionExecutionEvidence {
  compiled: boolean;
  loaded: boolean;
  processedRealInput: boolean;
  producedOutput: boolean;
}

export function assertRealModelProvenanceIsEarned(evidence: PerceptionExecutionEvidence): void {
  const missing: string[] = [];
  if (!evidence.compiled) missing.push('compiled');
  if (!evidence.loaded) missing.push('loaded');
  if (!evidence.processedRealInput) missing.push('processedRealInput');
  if (!evidence.producedOutput) missing.push('producedOutput');
  if (missing.length > 0) {
    throw new RangeError(
      `REAL_MODEL provenance may not be reported: missing evidence for ${missing.join(', ')}. `
      + 'Use NATIVE_REPLAY or PRECOMPUTED until a real model has actually run.',
    );
  }
}
