// K+ Packing Intelligence V1 — absence-claim safety for model prose (PK-001).
//
// THE HOLE THIS CLOSES. Packing shows the model a bounded shortlist (14 items)
// drawn from a Closet census of up to 200, and the prompt calls that shortlist
// "the only garments that exist for this task". A model reasoning over 14 items
// it has been told are everything will write, entirely naturally:
//
//   "You don't own a rain jacket, so I planned around showers."
//
// Every structured surface of a plan was already grounded -- gaps are derived
// from the census before the model output is even read, and `scarcitySignal` is
// a counted fact -- but three FREE-TEXT channels were not:
//
//   - `assumptions[]`        (the prompt actively asks the model to write these)
//   - `packedItems[].reason`
//   - `outfits[].reason`
//
// Those go straight to the traveller. The result was a screen that could render
// "Your only outer layer" on a rain jacket and, four inches below, an
// assumption saying the traveller owns no rain jacket. Both halves of the same
// plan, disagreeing about the traveller's own property.
//
// NOT A SECOND GUARD. This delegates to enforceClosetAbsenceProseSafety in
// eliseOwnershipProseSafety.ts -- the project's ONE absence-claim authority,
// hardened across CON-ABSENCE-005/006 for adverb interposition, curly
// apostrophes and role-vs-garment subjects. This module only does the part that
// is genuinely Packing's: turning Packing's own census into the evidence shape
// that guard already reads. Nothing here re-implements a pattern.
//
// THE OWNERSHIP HALF IS DELIBERATELY NOT APPLIED. enforceOwnershipProseSafety
// builds its vocabulary from the candidates it is handed. For Concierge that is
// effectively the retrieved set; for Packing it would be the 14-item shortlist,
// while the traveller owns up to 200. A true sentence about any of the other
// 186 items would be deleted as unsupported -- the exact mirror of the bug
// being fixed here, and the shared module's own doctrine says deleting a true
// claim is worse than the failure it prevents. Absence is grounded in the FULL
// census and its completeness flag, so only absence is enforced.

import {
  enforceClosetAbsenceProseSafety,
  type EliseClosetAbsenceEvidence,
} from './eliseOwnershipProseSafety.ts';

/**
 * Layering role -> the words a traveller or a model would actually use for it.
 *
 * The census counts by ROLE (`inferLayeringRole`'s vocabulary); an absence
 * claim names a GARMENT or a CATEGORY ("no jacket", "no footwear"). This table
 * is the join, and every token in it is one the shared guard can already
 * resolve -- there is no point listing a word its subject vocabulary will not
 * recognise.
 *
 * `layer` appears under both mid and outer because it is genuinely ambiguous in
 * English. Owning either one therefore suppresses a bare "layer" absence claim.
 * That over-suppresses in a narrow case and is the correct direction: a dropped
 * sentence costs presentation, an unblocked one tells someone they do not own a
 * coat they are wearing.
 */
const ROLE_SUBJECTS: Record<string, string[]> = {
  base: ['top', 'shirt', 'blouse', 'tee', 'tshirt', 'tank', 'polo', 'turtleneck', 'baselayer'],
  mid: [
    'sweater', 'cardigan', 'jumper', 'hoodie', 'sweatshirt', 'pullover', 'vest',
    'knitwear', 'midlayer', 'layer',
  ],
  outer: ['jacket', 'coat', 'trench', 'parka', 'bomber', 'blazer', 'outerwear', 'outerlayer', 'layer'],
  bottom: ['bottom', 'trouser', 'pant', 'jean', 'chino', 'short', 'skirt', 'legging', 'denim', 'legwear'],
  one_piece: ['dress', 'gown', 'jumpsuit', 'romper'],
  shoe: [
    'shoe', 'footwear', 'sneaker', 'trainer', 'boot', 'heel', 'pump', 'sandal',
    'oxford', 'brogue', 'derby', 'mule', 'loafer',
  ],
  accessory: [
    'accessory', 'bag', 'purse', 'tote', 'clutch', 'backpack', 'belt', 'scarf',
    'hat', 'cap', 'watch', 'necklace', 'bracelet', 'sunglasses', 'jewelry', 'jewellery',
    'headwear', 'eyewear',
  ],
};

/**
 * Turn Packing's census into the evidence the shared guard reads.
 *
 * `censusAvailable` carries the SAME honesty condition the gap engine and the
 * scarcity signal already enforce: a retrieval that came back full may have
 * missed part of the Closet, and a census that saw part of a Closet can prove
 * PRESENCE but never ABSENCE. When it is false the guard removes every
 * checkable absence claim, because none of them can be supported.
 */
export function buildPackingAbsenceEvidence(input: {
  closetRoleCensus: Record<string, number> | undefined;
  censusComplete: boolean;
}): EliseClosetAbsenceEvidence {
  const census = input.closetRoleCensus ?? {};
  const presentSubjects: string[] = [];
  for (const [role, count] of Object.entries(census)) {
    if (!(count > 0)) continue;
    for (const subject of ROLE_SUBJECTS[role] ?? []) presentSubjects.push(subject);
  }
  return { censusAvailable: input.censusComplete === true, presentSubjects };
}

export interface PackingProseVerdict {
  /** Sanitized text, or null when nothing safe survived and the field is dropped. */
  text: string | null;
  conflictCodes: string[];
}

/**
 * Sanitize one piece of model prose.
 *
 * DROPS RATHER THAN SUBSTITUTES. When every sentence is an unprovable absence
 * claim this returns null and the caller omits the field entirely -- an
 * assumption bullet disappears, a reason becomes absent. It never swaps in
 * replacement copy: the structured plan (items, outfits, counts, gaps,
 * scarcity) is the authority and is untouched, so dropping prose loses
 * presentation, never evidence.
 */
export function sanitizePackingProse(
  text: string | null,
  evidence: EliseClosetAbsenceEvidence,
): PackingProseVerdict {
  if (!text) return { text: null, conflictCodes: [] };
  const verdict = enforceClosetAbsenceProseSafety({
    text,
    evidence,
    // Empty on purpose: an empty result is the signal to DROP the field, which
    // is what this module wants, rather than to show invented neutral copy.
    neutralFallback: '',
  });
  if (!verdict.conflictDetected) return { text, conflictCodes: [] };
  const safe = verdict.safeText.trim();
  return { text: safe ? safe : null, conflictCodes: verdict.conflictCodes };
}
