// K+ Packing Intelligence V1 — refinement intent (B5).
//
// WHAT REFINEMENT IS HERE. The traveller types "don't bring the boots". Two
// things then happen, and the order matters:
//
//   1. If the phrase unambiguously names ONE item in the plan currently on
//      screen, that item's id becomes a hard exclusion. The server enforces it
//      in post-model validation, so the boots are gone whether or not the model
//      cooperates.
//   2. The sentence is ALSO sent as a constraint the model reads, so a
//      refinement this resolver cannot decode ("something less formal") still
//      shapes the next plan.
//
// Case 1 is a deterministic win; case 2 is the B2M behaviour, unchanged. There
// is no case 3 where a refinement silently does nothing.
//
// WHY MATCHING HAPPENS ON THE CLIENT. The only thing this produces is a list of
// ITEM IDS, and every id it can produce came from the plan the server itself
// built out of the traveller's own authorized Closet rows. The server then
// re-resolves those ids against a freshly retrieved candidate set, so a forged
// or stale id resolves to nothing. The client is choosing among things the
// server already authorized, never asserting new ones.
//
// AMBIGUITY IS NOT RESOLVED BY GUESSING. Two black items and a request to drop
// "the black one" produces NO exclusion -- the sentence goes to the model
// instead. Removing the wrong garment is worse than removing none.

import type { PackingPlan, PackingPlanItem } from '../../types/packing';

export interface PackingRefinementIntent {
  /** Unambiguously matched items to exclude. Often empty; that is fine. */
  excludeItemIds: string[];
  /** The sentence, always forwarded so the model sees the request too. */
  note: string;
  /** True when the phrasing asked to remove something but matched nothing. */
  unmatchedRemoval: boolean;
}

/** Phrasings that mean "take this out", as opposed to "add" or "change". */
const REMOVAL_PATTERN =
  /\b(?:don'?t|do not|no|not|without|skip|leave (?:out|behind)?|remove|drop|lose|ditch|exclude)\b/i;

/**
 * Words carried by almost every sentence. Matching on these would let "the" or
 * "my" select an arbitrary garment.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'my', 'me', 'i', 'we', 'us', 'it', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'for', 'to', 'of', 'on', 'in', 'at', 'with', 'without', 'from',
  'dont', 'do', 'not', 'no', 'skip', 'leave', 'out', 'behind', 'remove', 'drop', 'lose',
  'ditch', 'exclude', 'bring', 'take', 'pack', 'packing', 'wear', 'want', 'need', 'trip',
  'please', 'just', 'any', 'some', 'one', 'ones', 'thing', 'things', 'item', 'items',
  'is', 'are', 'be', 'am', 'was', 'were', 'will', 'would', 'can', 'could', 'should',
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/** Every word that could legitimately name this garment. */
function itemVocabulary(item: PackingPlanItem): Set<string> {
  const words = new Set<string>();
  for (const source of [item.title, item.subtype, item.category, item.primaryColor, item.brand]) {
    if (!source) continue;
    for (const token of tokenize(source)) {
      words.add(token);
      // "boot" should match "boots" and vice versa; a naive plural strip is
      // enough here because a wrong strip only ever costs a match, and a
      // missed match falls through to the model.
      if (token.endsWith('s') && token.length > 3) words.add(token.slice(0, -1));
      else words.add(`${token}s`);
    }
  }
  return words;
}

/**
 * Resolves a free-text refinement against the plan on screen.
 *
 * Returns exclusions ONLY for an unambiguous single match. The note is always
 * returned, so the caller never has to decide whether to forward it.
 */
export function resolveRefinementIntent(
  note: string,
  plan: PackingPlan | null,
): PackingRefinementIntent {
  const trimmed = note.trim().slice(0, 300);
  if (!trimmed || !plan) {
    return { excludeItemIds: [], note: trimmed, unmatchedRemoval: false };
  }
  if (!REMOVAL_PATTERN.test(trimmed)) {
    // "Give me another dinner outfit" is a real refinement, just not a removal.
    return { excludeItemIds: [], note: trimmed, unmatchedRemoval: false };
  }

  const subject = tokenize(trimmed);
  if (subject.length === 0) {
    return { excludeItemIds: [], note: trimmed, unmatchedRemoval: true };
  }

  // Score every packed item by how many of the sentence's meaningful words it
  // answers to. Only a clear, unshared best match is acted on.
  const scored = plan.packedItems.map((item) => {
    const vocabulary = itemVocabulary(item);
    const hits = subject.filter((token) => vocabulary.has(token)).length;
    return { item, hits };
  });

  const best = Math.max(0, ...scored.map((entry) => entry.hits));
  if (best === 0) {
    return { excludeItemIds: [], note: trimmed, unmatchedRemoval: true };
  }

  const winners = scored.filter((entry) => entry.hits === best);
  if (winners.length !== 1) {
    // Ambiguous: two garments answer equally well. Removing the wrong one is
    // worse than removing none, so the model gets the sentence instead.
    return { excludeItemIds: [], note: trimmed, unmatchedRemoval: false };
  }

  return {
    excludeItemIds: [winners[0].item.itemId],
    note: trimmed,
    unmatchedRemoval: false,
  };
}
