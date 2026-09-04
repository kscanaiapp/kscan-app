/**
 * Cross-runtime golden fixture contract — P3-B amendment Sections 8-9.
 *
 * "Where practical, use the same semantic fixture identity across: P3-A
 * NODE REFERENCE -> NATIVE REPLAY -> EMULATOR/NATIVE RUNTIME -> FUTURE
 * PHYSICAL DEVICE. The purpose is traceable evidence, not four unrelated
 * demonstrations." This module pairs a BodyFrame sequence (the existing
 * `@kscan-live-vto/evaluation` `NativeReplayFixture` format) with a Phase 3
 * mask/semantic scene (`@kscan-live-vto/realism`) under one fixture
 * identity, and defines the evidence-ledger shape Section 9 asks for.
 */

import {
  buildNativeReplayFixture,
  generateCenteredStandingSequence,
  type NativeReplayFixture,
} from '@kscan-live-vto/evaluation';
import {
  armCrossingSequence,
  longHairOverShoulderScene,
  stableForegroundSequence,
  type ForegroundMaskSequence,
  type SemanticScene,
} from '@kscan-live-vto/realism';

export interface CrossRuntimeGoldenFixture {
  fixtureId: string;
  description: string;
  bodyFrames: NativeReplayFixture;
  /** Present for scenarios with a temporal foreground mask stream (e.g.
   *  arm crossing); absent otherwise. Not required to share a frame count
   *  or timestamp base with `bodyFrames` -- the two streams are paired by
   *  scenario identity, not by frame alignment, matching how
   *  `RenderInput.bodyFrame` and `RenderInput.foregroundMask` are already
   *  independent inputs to the same render call in
   *  `@kscan-live-vto/static-renderer`. */
  maskSequence: ForegroundMaskSequence | null;
  /** Present for scenarios about a single-frame semantic occlusion case
   *  (e.g. hair-over-shoulder) rather than a temporal mask sequence. */
  semanticScene: SemanticScene | null;
}

export const REQUIRED_GOLDEN_SCENARIO_IDS = [
  'neutral',
  'arm-crossing',
  'tracking-loss',
  'recovery',
  'mirroring-logo',
  'semantic-foreground',
  'lighting-stress',
] as const;
export type RequiredGoldenScenarioId = (typeof REQUIRED_GOLDEN_SCENARIO_IDS)[number];

export function assertAllRequiredScenariosPresent(fixtures: readonly CrossRuntimeGoldenFixture[]): void {
  const present = new Set(fixtures.map((f) => f.fixtureId));
  const missing = REQUIRED_GOLDEN_SCENARIO_IDS.filter((id) => !present.has(id));
  if (missing.length > 0) {
    throw new RangeError(`Missing required cross-runtime golden scenario(s): ${missing.join(', ')}`);
  }
}

function bodyFrameFixture(id: RequiredGoldenScenarioId, seed: number, extra: Partial<Parameters<typeof generateCenteredStandingSequence>[0]> = {}) {
  return buildNativeReplayFixture(
    generateCenteredStandingSequence({ frameCount: 10, frameRateHz: 10, seed, ...extra }),
    { fixtureId: id, sourceDescription: `Synthetic centered-standing sequence, scenario "${id}"`, nominalFrameRateHz: 10, synthetic: true },
  );
}

/**
 * Concrete instances of the required scenario set, built entirely from
 * existing P3-A/Phase-1-2 fixture generators -- no new randomness, no new
 * geometry model. `arm-crossing` deliberately reuses the SAME neutral
 * BodyFrame sequence as `neutral`: crossing the arms is a foreground-mask
 * phenomenon at the shoulder/chest level, not something that changes the
 * torso pose landmarks this generator models, so pairing an unchanged
 * BodyFrame stream with `armCrossingSequence()`'s mask is the honest
 * representation, not a shortcut.
 */
export function buildRequiredGoldenFixtures(): readonly CrossRuntimeGoldenFixture[] {
  return [
    {
      fixtureId: 'neutral',
      description: 'Stable standing pose, stable foreground mask. The control case.',
      bodyFrames: bodyFrameFixture('neutral', 1),
      maskSequence: stableForegroundSequence(8),
      semanticScene: null,
    },
    {
      fixtureId: 'arm-crossing',
      description: 'Same neutral BodyFrame sequence, paired with a crossing-forearm mask sequence -- see header.',
      bodyFrames: bodyFrameFixture('arm-crossing', 2),
      maskSequence: armCrossingSequence(10),
      semanticScene: null,
    },
    {
      fixtureId: 'tracking-loss',
      description: 'BodyFrame sequence with a trackingLossWindow near the end -- entering loss.',
      bodyFrames: bodyFrameFixture('tracking-loss', 3, { trackingLossWindow: [6, 10] }),
      maskSequence: null,
      semanticScene: null,
    },
    {
      fixtureId: 'recovery',
      description: 'BodyFrame sequence with a trackingLossWindow at the start -- reacquiring after loss.',
      bodyFrames: bodyFrameFixture('recovery', 4, { trackingLossWindow: [0, 4] }),
      maskSequence: null,
      semanticScene: null,
    },
    {
      fixtureId: 'mirroring-logo',
      description:
        'Reference oracle is @kscan-live-vto/static-renderer\'s renderer.test.ts: '
        + '"person fixture puts the wearer\'s left shoulder at lower u" and the logoDistortion mirrored-flag tests. '
        + 'This entry pins the scenario identity; the actual assertions live with the Node reference renderer.',
      bodyFrames: bodyFrameFixture('mirroring-logo', 5),
      maskSequence: null,
      semanticScene: null,
    },
    {
      fixtureId: 'semantic-foreground',
      description: 'Hair-over-shoulder semantic occlusion case, from @kscan-live-vto/realism\'s adverse scene fixtures.',
      bodyFrames: bodyFrameFixture('semantic-foreground', 6),
      maskSequence: null,
      semanticScene: longHairOverShoulderScene(),
    },
    {
      fixtureId: 'lighting-stress',
      description:
        'Reference oracle is evidence/phase3-preview/case-7-dark-scene-light-garment-* and '
        + 'case-8-bright-scene-dark-garment-* (kscan-live-vto/tools/render-phase3-review.js). '
        + 'Lighting mismatch is a person/garment color-spec property, not a BodyFrame or mask property, '
        + 'so this entry carries no distinct mask/scene payload of its own.',
      bodyFrames: bodyFrameFixture('lighting-stress', 7),
      maskSequence: null,
      semanticScene: null,
    },
  ];
}

// ─── Evidence ledger — Section 9 ────────────────────────────────────────────

export interface CrossRuntimeEvidenceEntry {
  fixtureId: string;
  referenceResult: string;
  /** null until a native run has actually happened. */
  nativeResult: string | null;
  differenceNotes: string | null;
}

/** The only evidence-entry constructor this module offers, deliberately:
 *  every entry starts in the "not yet run" state, so an entry can never be
 *  silently created already claiming a native result that never happened. */
export function createPendingEvidenceEntry(fixtureId: string, referenceResult: string): CrossRuntimeEvidenceEntry {
  return {
    fixtureId,
    referenceResult,
    nativeResult: null,
    differenceNotes: 'NOT YET RUN — no native compilation path this session; see docs/vto-phase3b-native-build-handoff.md.',
  };
}
