// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source of truth:
//   tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json
// Regenerate with:
//   node scripts/generate-scanner-candidate-artifact.js
// Verify with:
//   node scripts/generate-scanner-candidate-artifact.js --check
//
// The Build 4 scanner accuracy candidate, in the form the Edge Function can
// consume. Instruction text is embedded as data because an Edge Function must
// not read the filesystem at request time; it is GENERATED from the evaluation
// artifact so the measured instructions and the shipped instructions cannot
// drift apart.
//
// This module is inert on its own. It describes a candidate; it does not select
// one. Selection is owned by scannerVersionResolver.ts, and the production
// default is the certified control.

/** The certified control. The production default, and the rollback target. */
export const CERTIFIED_CONTROL_VERSION = 'certified-v140' as const;

/** The Build 4 Phase 2A candidate. Dormant unless trusted configuration names it. */
export const PHASE2A_CANDIDATE_VERSION = 'phase2a-v1.0.0' as const;

export type ScannerVersion =
  | typeof CERTIFIED_CONTROL_VERSION
  | typeof PHASE2A_CANDIDATE_VERSION;

/** Every version this build can serve. */
export const SUPPORTED_SCANNER_VERSIONS: readonly ScannerVersion[] = Object.freeze([
  CERTIFIED_CONTROL_VERSION,
  PHASE2A_CANDIDATE_VERSION,
]);

/**
 * The candidate instruction lines, verbatim from the canonical artifact.
 * Joined with a single newline — the same join the evaluation harness uses.
 */
const PHASE2A_INSTRUCTION_LINES: readonly string[] = Object.freeze([
  "",
  "",
  "K SCAN AI PHASE 2A CANDIDATE INSTRUCTIONS (phase2a-v1.0.0)",
  "",
  "Everything above still applies. The rules below refine how you fill the same",
  "fields. They add no fields, remove no fields, and change no field name or",
  "response shape.",
  "",
  "1. FASHION VOCABULARY, NOT OBJECT VOCABULARY",
  "",
  "Name the garment, footwear or accessory the way a fashion professional would.",
  "Prefer the specific fashion term over a generic object term whenever the image",
  "supports it: \"trench coat\" over \"coat\"; \"chelsea boot\" over \"shoe\";",
  "\"crewneck sweatshirt\" over \"shirt\"; \"tote bag\" over \"bag\".",
  "Never answer with a generic object word such as \"clothing\", \"garment\",",
  "\"item\", \"apparel\", \"accessory\", \"object\", \"thing\" or \"product\" when a",
  "specific fashion term is actually visible.",
  "",
  "2. ITEM_TYPE AND SUBTYPE MUST AGREE",
  "",
  "subtype must be a narrower kind of item_type, and item_type must be the family",
  "that subtype belongs to.",
  "Never return a subtype from a different family than item_type. A subtype of",
  "\"sneaker\" under item_type \"dress\", or \"bootcut jeans\" under item_type",
  "\"footwear\", is a contradiction, and a contradiction is worse than a broader",
  "answer.",
  "If the specific subtype is not clearly visible, set subtype to null and keep the",
  "correct item_type. Do not invent a matching pair to make the two fields agree.",
  "",
  "3. EVIDENCE BEFORE SPECIFICITY",
  "",
  "Every value you return must be something you can point at in this image.",
  "- subtype: return it only when construction, cut or silhouette detail actually",
  "  distinguishes it from its siblings.",
  "- material_estimate: return it only when weave, sheen, drape, grain or texture is",
  "  visible enough to tell the material apart. Do not infer material from the",
  "  garment type, from the colour, or from what such an item is usually made of.",
  "- pattern: return it only when you can see the pattern on the item. \"solid\" is",
  "  a pattern claim as well: use it only when you can actually see an unpatterned",
  "  surface, not when the item is too small, too dark or too blurred to tell.",
  "- primary_color and secondary_colors: report the colours of the item under the",
  "  lighting shown. Do not correct for lighting you cannot measure.",
  "",
  "4. BRAND",
  "",
  "Return a brand only from visual evidence on the item itself: readable brand",
  "text, a legible logo, or an unmistakable trademarked design element.",
  "- Put readable brand text in visible_brand_text.",
  "- Set logo_detected to true only when a brand logo is actually visible.",
  "- Put the brand name in brand_guess only when visible_brand_text or",
  "  logo_detected supports it.",
  "When the evidence does support a brand, name it. Do not withhold a brand you can",
  "actually see.",
  "When it does not, set brand_guess to null. Never return an empty string, a",
  "placeholder, \"unknown\", \"unbranded\", \"generic\", or a retailer, marketplace or",
  "model name in place of a brand.",
  "Do not infer a brand from garment style, from a premium look, from photo styling,",
  "or from a price impression.",
  "",
  "5. CONSERVATIVE CERTAINTY",
  "",
  "confidence_score must reflect the weakest link in the identification, not the",
  "strongest. Lower it when the item is partially obscured, distant, blurred,",
  "colour-cast, or seen from a single angle.",
  "A broader answer carrying honest confidence is better than a specific answer",
  "carrying borrowed confidence.",
  "",
  "6. HOW TO SAY YOU DO NOT KNOW",
  "",
  "Use the representations the response shape already defines. Do not invent new",
  "ones.",
  "- item_type: use the string \"unknown\" when you cannot tell the family.",
  "- subtype, material_estimate, pattern, primary_color, silhouette, fit, length,",
  "  sleeve_length, neckline_or_lapel, closure, brand_guess, visible_brand_text,",
  "  scan_quality_note: use null.",
  "- secondary_colors, distinctive_features, style_tags, occasion_tags, pockets:",
  "  use [].",
  "Never use an empty string, \"n/a\", \"none\", \"N/A\", \"-\", \"TBD\" or any other",
  "placeholder in place of a value you do not have.",
  "",
  "7. STRICT STRUCTURED OUTPUT",
  "",
  "Return exactly one JSON object matching the shape given above. No markdown, no",
  "code fences, no commentary, no text before or after the object, and no extra",
  "top-level keys.",
]);

/** The deterministic candidate instruction text. */
export const PHASE2A_INSTRUCTION_TEXT: string = PHASE2A_INSTRUCTION_LINES.join('\n');

/** SHA-256 of PHASE2A_INSTRUCTION_TEXT, certified by Build 4 Phase 2B. */
export const PHASE2A_INSTRUCTION_SHA256 = '93b67ad9de443dbb59b3d7aa502e4bb126fad7d8b8ed8e23560bb4802629e384' as const;

/** SHA-256 of the canonical candidate descriptor, certified by Build 4 Phase 2B. */
export const PHASE2A_ARTIFACT_SHA256 = '6cc51fbaecaca28b270f4df853dd8004b7360b7d67044f8f74f667ebd8de3a33' as const;

export const PHASE2A_OVERLAY_ID = 'phase2a-fashion-specificity-v1' as const;

/**
 * Apply the candidate instructions to a certified prompt.
 *
 * APPEND ONLY. The certified prompt reaches the provider first, verbatim, in its
 * certified order; the candidate delta is exactly the text appended after it.
 * The certified prompt is never rewritten, reordered or truncated.
 *
 * Returns the input UNCHANGED for the certified control, so the control path is
 * not merely equivalent to today's behaviour — it is the same string.
 */
export function applyScannerCandidateInstructions(
  certifiedPrompt: string,
  version: ScannerVersion,
): string {
  if (version !== PHASE2A_CANDIDATE_VERSION) return certifiedPrompt;
  return `${certifiedPrompt}${PHASE2A_INSTRUCTION_TEXT}`;
}

/**
 * Sanitized artifact identity for telemetry.
 *
 * Ids and digests only. The instruction TEXT is deliberately absent: a digest is
 * enough to prove which artifact ran, and emitting the prose would turn every
 * log line into a second copy of it.
 */
export function scannerArtifactIdentity(version: ScannerVersion): {
  scannerVersion: ScannerVersion;
  scannerArtifactSha256: string | null;
  scannerInstructionSha256: string | null;
} {
  const isCandidate = version === PHASE2A_CANDIDATE_VERSION;
  return {
    scannerVersion: version,
    scannerArtifactSha256: isCandidate ? PHASE2A_ARTIFACT_SHA256 : null,
    scannerInstructionSha256: isCandidate ? PHASE2A_INSTRUCTION_SHA256 : null,
  };
}
