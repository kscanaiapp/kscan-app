'use strict';

/**
 * Canonical evidence-framing banner and claim clause. Every report or doc
 * this lane produces must carry these verbatim (mission spec, top-level
 * instructions) -- centralized here so no report can silently drift from the
 * exact required wording.
 */

const EVIDENCE_FRAMING_BANNER = `EVIDENCE FRAMING:
INSTRUMENT VALIDATION

NO SYNTHETIC-RESPONSE METRIC CHARACTERIZES
PRODUCTION ELISE OR WARDROBE CONCIERGE QUALITY.

NO SYNTHETIC METRIC IS USER-SATISFACTION EVIDENCE.

NO GROUNDING/SAFETY METRIC IS A SAFETY-ASSURANCE CLAIM.`;

const CLAIM_CLAUSE =
  'Synthetic response results validate the evaluation instrument only. They are not measurements of production Elise behavior, production Wardrobe Concierge behavior, user satisfaction, recommendation quality, or safety assurance.';

const OWNER_CAPTURED_LABEL_RULE =
  'Owner-captured metrics (when present) must be labeled "OWNER-CAPTURED ENGINEERING EVIDENCE" and never generalized beyond the specific transcripts reviewed. No figure from this lane belongs in marketing, App Store copy, investor material, press, or competitive claims.';

module.exports = { EVIDENCE_FRAMING_BANNER, CLAIM_CLAUSE, OWNER_CAPTURED_LABEL_RULE };
