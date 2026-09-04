/**
 * Golden-sequence fixture manifest — Section 17.
 *
 * "Do not use customer images." This schema describes a *recorded test
 * sequence's metadata*, never its pixel content — the actual video/image
 * bytes live outside the repository (or under fixtures/, gitignored, once
 * real consented captures exist — see docs/fixture-consent-log.md). No
 * real human footage exists in this session (no camera, no consenting
 * subjects available in a cloud sandbox); `fixtures/sequences/` currently
 * holds only this manifest schema and category placeholders so the
 * runner and its tests can be built and proven against synthetic
 * BodyFrame series today, and pointed at real recordings later without a
 * schema change.
 */

/** Exactly Section 17's required coverage list. */
export const GOLDEN_SEQUENCE_CATEGORIES = [
  'centered-subject',
  'too-close',
  'too-far',
  'partial-body',
  'arm-crossing',
  'arms-raised',
  'arms-beside-torso',
  'torso-rotation',
  'closer-farther-movement',
  'tracking-loss',
  'tracking-reacquisition',
  'bright-light',
  'low-light',
  'backlight',
  'cluttered-background',
  'clean-background',
  'varied-skin-tones',
  'varied-body-shapes',
  'varied-current-clothing',
  'logo-pattern-garment',
] as const;
export type GoldenSequenceCategory = (typeof GOLDEN_SEQUENCE_CATEGORIES)[number];

export interface FixtureConsentRef {
  fixtureId: string;
  /** Points at a row in docs/fixture-consent-log.md — never inline consent text here. */
  consentLogFixtureId: string;
}

export interface GoldenSequenceManifest {
  sequenceId: string;
  category: GoldenSequenceCategory;
  description: string;
  /** Frames-per-second the sequence was recorded/synthesized at. */
  nominalFrameRateHz: number;
  frameCount: number;
  /** Absent for synthetic fixtures (Section 31's consent requirement only applies to real human footage). */
  consent: FixtureConsentRef | null;
  /** True for procedurally-generated BodyFrame series (this session's default); false once a real device recording backs this sequence. */
  synthetic: boolean;
}

export function isCoverageComplete(manifests: readonly GoldenSequenceManifest[]): {
  complete: boolean;
  missing: GoldenSequenceCategory[];
} {
  const present = new Set(manifests.map((m) => m.category));
  const missing = GOLDEN_SEQUENCE_CATEGORIES.filter((c) => !present.has(c));
  return { complete: missing.length === 0, missing };
}
