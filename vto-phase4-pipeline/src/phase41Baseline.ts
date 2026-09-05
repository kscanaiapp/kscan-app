/**
 * Phase 4.1 Gate E real-corpus baseline — the EASY + MEDIUM slice, frozen.
 *
 * Phase 4.2 §21/§44 make the four original EASY failures MANDATORY forensic
 * cases, and §45 requires that previously-passing assets not regress. Both
 * need stable identifiers for items whose source URLs were deliberately
 * never committed (privacy carry-forward, §57).
 *
 * `sourceSha256` IS that stable identifier: it is the hash of the decoded
 * source bytes, recorded in `evidence/vto-phase4-gate-e/
 * real-cohort-results.jsonl`. It survives the run-local `productRef`
 * renumbering, and it lets a fresh corpus run positively re-identify the
 * same image without any URL ever being written down. A re-fetched image
 * whose bytes hash to one of these values IS the original case; one that
 * does not, is not — there is no fuzzy matching.
 *
 * These rows are HISTORY. They are never edited to reflect a better later
 * result; Phase 4.2 outcomes are recorded alongside them, not over them.
 */

export type BaselineOutcome =
  | 'LIVE2D_ELIGIBLE'
  | 'REJECTED:EXTRACTION_UNRELIABLE'
  | 'REJECTED:PRODUCT_FIDELITY_FAILED'
  | 'REJECTED:ANCHORS_INCOMPLETE';

export interface Phase41BaselineCase {
  /** Run-local id from the Phase 4.1 cohort. Retained only for cross-referencing that run's own evidence files. */
  baselineProductRef: string;
  /** THE stable identity. sha256 of the decoded source bytes. */
  sourceSha256: string;
  shotClass: 'EASY' | 'MEDIUM';
  outcome: BaselineOutcome;
  sourceWidth: number;
  sourceHeight: number;
  /** Phase 4.1 recorded ADEQUATE for all ten — i.e. resolution was never the limiter. */
  sourceAdequacy: 'ADEQUATE';
  visualStratum: string;
  /** True for the four §21/§44 mandatory forensic cases. */
  mandatoryForensicCase: boolean;
}

export const PHASE41_EASY_MEDIUM_BASELINE: readonly Phase41BaselineCase[] = [
  // ── The four MANDATORY EASY forensic cases (§21/§44). EASY was 0/4. ──
  {
    baselineProductRef: 'real-0067',
    sourceSha256: '6f1fa536448011e888fe18a94850df00a72c5529cb7c958d9197d518e2012a71',
    shotClass: 'EASY',
    outcome: 'REJECTED:EXTRACTION_UNRELIABLE',
    sourceWidth: 316,
    sourceHeight: 435,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'plain',
    mandatoryForensicCase: true,
  },
  {
    baselineProductRef: 'real-0129',
    sourceSha256: 'f06b1d050c2bcb5dcb7320c3986e124658cb1c16cd111f92897a20315c5eb39e',
    shotClass: 'EASY',
    outcome: 'REJECTED:EXTRACTION_UNRELIABLE',
    sourceWidth: 320,
    sourceHeight: 400,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'plain',
    mandatoryForensicCase: true,
  },
  {
    baselineProductRef: 'real-0120',
    sourceSha256: '2ef39092eb96f30e61cfdd7f7bb71dd55aa6eed7110018f337174b9d382c9718',
    shotClass: 'EASY',
    outcome: 'REJECTED:PRODUCT_FIDELITY_FAILED',
    sourceWidth: 659,
    sourceHeight: 659,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'softknit',
    mandatoryForensicCase: true,
  },
  {
    baselineProductRef: 'real-0171',
    sourceSha256: '0039e4c83022e488c5654614f8d53c63bd7278660fdb6c1820225960717a3862',
    shotClass: 'EASY',
    outcome: 'REJECTED:PRODUCT_FIDELITY_FAILED',
    sourceWidth: 659,
    sourceHeight: 659,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'plain',
    mandatoryForensicCase: true,
  },

  // ── MEDIUM failures (not mandatory, but part of the addressable slice). ──
  {
    baselineProductRef: 'real-0050',
    sourceSha256: '0b96960ae39c8ed7b0cf8b6c7ce084a3df5b91515fbe90508cc75614d82ae98a',
    shotClass: 'MEDIUM',
    outcome: 'REJECTED:ANCHORS_INCOMPLETE',
    sourceWidth: 659,
    sourceHeight: 659,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'patterned',
    mandatoryForensicCase: false,
  },
  {
    baselineProductRef: 'real-0148',
    sourceSha256: 'f268880610a86ba020ccf3753606ad9643d73dd20dae89d73740cc196842886c',
    shotClass: 'MEDIUM',
    outcome: 'REJECTED:ANCHORS_INCOMPLETE',
    sourceWidth: 502,
    sourceHeight: 659,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'plain',
    mandatoryForensicCase: false,
  },
  {
    baselineProductRef: 'real-0161',
    sourceSha256: '391a85174235ad48cc2dcdc946f355eb5a5add4767b1e0ddc4d373685d429300',
    shotClass: 'MEDIUM',
    outcome: 'REJECTED:PRODUCT_FIDELITY_FAILED',
    sourceWidth: 659,
    sourceHeight: 659,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'light',
    mandatoryForensicCase: false,
  },

  // ── The three PREVIOUSLY PASSING assets (§45). These must not regress. ──
  {
    baselineProductRef: 'real-0079',
    sourceSha256: 'd87fee19732b5b8b3a3d7bcf3995ba8ae5073d58f3d64825ad1735f6c392aff6',
    shotClass: 'MEDIUM',
    outcome: 'LIVE2D_ELIGIBLE',
    sourceWidth: 659,
    sourceHeight: 659,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'softknit',
    mandatoryForensicCase: false,
  },
  {
    baselineProductRef: 'real-0186',
    sourceSha256: 'c82956cd7be4d36dee736e17ef7a1a5675602fb6187b995694c44d248a183995',
    shotClass: 'MEDIUM',
    outcome: 'LIVE2D_ELIGIBLE',
    sourceWidth: 320,
    sourceHeight: 400,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'structured',
    mandatoryForensicCase: false,
  },
  {
    baselineProductRef: 'real-0210',
    sourceSha256: '962e486bade83700e58177b2f8e3242642f969ef84c10ac0d02f0ad687384b48',
    shotClass: 'MEDIUM',
    outcome: 'LIVE2D_ELIGIBLE',
    sourceWidth: 659,
    sourceHeight: 659,
    sourceAdequacy: 'ADEQUATE',
    visualStratum: 'structured',
    mandatoryForensicCase: false,
  },
];

/** The four §21/§44 mandatory forensic cases. */
export const MANDATORY_EASY_FORENSIC_CASES = PHASE41_EASY_MEDIUM_BASELINE.filter((c) => c.mandatoryForensicCase);

/** The three §45 previously-passing assets that must not regress. */
export const PREVIOUSLY_ELIGIBLE_CASES = PHASE41_EASY_MEDIUM_BASELINE.filter((c) => c.outcome === 'LIVE2D_ELIGIBLE');

export function baselineCaseBySha(sha256: string): Phase41BaselineCase | undefined {
  return PHASE41_EASY_MEDIUM_BASELINE.find((c) => c.sourceSha256 === sha256);
}
