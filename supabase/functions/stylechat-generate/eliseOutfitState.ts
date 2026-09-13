/**
 * Build 36 / Wardrobe Concierge V2 -- structured refinement state.
 *
 * WHAT WAS ACTUALLY BROKEN
 * ------------------------
 * `runEliseAdvicePipeline` took exactly one thing about the conversation: the
 * current `message`. Nothing about the outfit it had just proposed reached it.
 * So "not the loafers, something else" ran the same retrieval, scored the same
 * candidates and produced the same shortlist -- loafers included -- and whether
 * the customer's rejection was honoured depended on the model noticing its own
 * previous reply in the history window. Measured on the real pipeline before
 * this module existed: the rejected item was present in the next turn's
 * shortlist in the identical position.
 *
 * That is a STATE gap, not a prompt gap. Telling the model harder to remember
 * does not give it something to remember; this does.
 *
 * WHERE THE STATE LIVES (and why there is no migration)
 * ----------------------------------------------------
 * In the assistant message's `ui_blocks`, exactly as `concierge_evidence`
 * already does: the server returns it in `adviceMetadata`, the client persists
 * it with the message it belongs to, and the server's existing history read --
 * which already selects `ui_blocks` -- hands it back on the next turn. No new
 * table, no new column, no second query, no new round trip. Actor scoping is
 * inherited rather than reinvented: that read is `.eq('user_id', actorId)`
 * under RLS, so another actor's outfit is not merely filtered out, it is
 * unreadable.
 *
 * THE TRUST RULE
 * --------------
 * Because it round-trips through the client, restored state is UNTRUSTED. The
 * contract is shaped so that cannot matter (see `EliseOutfitState`):
 * rejections only ever REMOVE candidates, and a retention is honoured only
 * after the id is re-found in THIS turn's freshly authorized evidence. Nothing
 * here can put a garment into the answer, and nothing here can make one owned.
 * Every function in this module is pure.
 */

import type {
  EliseActorRelationship,
  EliseOutfitState,
  EliseOutfitStateItem,
  EliseRecommendationRole,
  EliseRefinementAction,
  EliseRefinementOutcome,
  EliseScoredCandidate,
  EliseWardrobeCandidate,
  EliseWardrobeSourceType,
} from './eliseAdviceTypes.ts';

/** Bounds. Every one of these caps a value that arrives from the client. */
export const ELISE_OUTFIT_STATE_LIMITS = {
  maxItems: 8,
  maxRetained: 8,
  maxRejected: 24,
  maxRejectedClasses: 12,
  maxConstraints: 8,
  maxIdChars: 80,
  /** Refinement turns before the outfit is considered stale and restarts. */
  maxTurns: 24,
} as const;

/** The block type the client persists this state under, in `ui_blocks`. */
export const ELISE_OUTFIT_STATE_BLOCK_TYPE = 'concierge_outfit_state';

const VALID_ROLES: EliseRecommendationRole[] = [
  'primary', 'alternative', 'layer', 'shoe', 'accessory', 'substitute', 'gap',
];
const VALID_RELATIONSHIPS: EliseActorRelationship[] = [
  'owned', 'saved', 'scanned', 'shared', 'discovered', 'unverified', 'unknown',
];
const VALID_SOURCE_TYPES: EliseWardrobeSourceType[] = [
  'closet', 'saved_scan', 'recent_scan', 'owned_room', 'shared_room',
  'saved_product', 'commerce_product', 'inspiration', 'focused_scan',
];

/**
 * Garment words a rejection can name, kept deliberately in the customer's
 * vocabulary rather than the internal taxonomy -- "not the loafers" is what a
 * person says, and the class is what they mean.
 *
 * This is the same everyday vocabulary the ownership prose guard checks claims
 * against, for the same reason: the thing being matched is the word the
 * customer used.
 */
const REJECTABLE_GARMENTS = [
  'loafer', 'sneaker', 'trainer', 'boot', 'heel', 'pump', 'sandal', 'oxford',
  'brogue', 'mule', 'shoe', 'flat',
  'blazer', 'jacket', 'coat', 'trench', 'parka', 'bomber', 'cardigan',
  'sweater', 'jumper', 'hoodie', 'sweatshirt', 'pullover', 'vest',
  'shirt', 'blouse', 'tee', 'tshirt', 'top', 'tank', 'polo', 'turtleneck',
  'trouser', 'pant', 'jean', 'chino', 'short', 'skirt', 'legging',
  'dress', 'gown', 'jumpsuit', 'romper',
  'bag', 'purse', 'tote', 'clutch', 'backpack', 'belt', 'scarf', 'hat', 'cap',
  'watch', 'necklace', 'bracelet', 'sunglasses',
];

/**
 * Role words a refinement can name directly ("swap the shoes", "keep the top").
 * Maps the customer's word onto the recommendation role vocabulary that already
 * exists, rather than introducing a second set of slot names.
 */
const ROLE_WORDS: Record<string, EliseRecommendationRole> = {
  shoe: 'shoe', shoes: 'shoe', footwear: 'shoe',
  accessory: 'accessory', accessories: 'accessory',
  layer: 'layer', layers: 'layer', jacket: 'layer', coat: 'layer',
};

/**
 * Produce every plausible stem of a word.
 *
 * Deliberately the same over-generating strategy the ownership guard uses
 * (`wordVariants` there): guessing a single normalization silently disables
 * matching for whole classes ("shoes" -> "sho"), while an extra candidate stem
 * simply matches nothing.
 */
function wordStems(value: string): string[] {
  const lower = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (lower.length < 3) return lower ? [lower] : [];
  const stems = new Set<string>([lower]);
  if (lower.length > 3 && lower.endsWith('ies')) stems.add(`${lower.slice(0, -3)}y`);
  if (lower.length > 3 && lower.endsWith('es')) stems.add(lower.slice(0, -2));
  if (lower.length > 2 && lower.endsWith('s') && !lower.endsWith('ss')) {
    stems.add(lower.slice(0, -1));
  }
  return [...stems];
}

function directGarmentClassOf(word: string): string | null {
  for (const stem of wordStems(word)) {
    if (REJECTABLE_GARMENTS.includes(stem)) return stem;
  }
  return null;
}

/**
 * Words that END in a garment without being one. Without this the compound rule
 * reads "I don't want to overdress" as a rejection of every dress. One
 * space-separated string rather than an array of quoted words, which the
 * governed Edge manifest scanner misreads (B34-DEF-001).
 */
const NOT_GARMENT_COMPOUNDS = new Set(
  'overdress underdress undress redress address wheel reboot invest harvest outskirt'.split(' '),
);

/**
 * The garment class a word names, or null.
 *
 * Exported (Build 35) so Packing refinement resolves "the loafers" through THIS
 * vocabulary rather than a second garment word list. Compounds resolve to the
 * garment they end in -- a raincoat is a coat, sweatpants are pants, a
 * shirtdress is a dress -- so "not the raincoat" is a rejection here exactly as
 * it is in Packing, and one Closet item has one set of classes in both. Only
 * suffix classes of four or more letters count, so a laptop is never a top.
 */
export function garmentClassOf(word: string): string | null {
  const direct = directGarmentClassOf(word);
  if (direct) return direct;
  const letters = word.toLowerCase().replace(/[^a-z]/g, '');
  if (wordStems(letters).some((stem) => NOT_GARMENT_COMPOUNDS.has(stem))) return null;
  for (let index = 1; index <= letters.length - 4; index += 1) {
    const hit = directGarmentClassOf(letters.slice(index));
    if (hit && hit.length >= 4) return hit;
  }
  return null;
}

/** The garment classes a candidate can honestly be referred to by. */
export function candidateGarmentClasses(candidate: EliseWardrobeCandidate): string[] {
  const classes = new Set<string>();
  for (const field of [candidate.category, candidate.subcategory, candidate.title]) {
    if (typeof field !== 'string') continue;
    for (const word of field.split(/[^A-Za-z0-9]+/)) {
      const garment = garmentClassOf(word);
      if (garment) classes.add(garment);
    }
  }
  return [...classes];
}

// ── Restoring untrusted state ────────────────────────────────────────────────

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function boundedStringArray(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = boundedString(entry, maxChars);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Parse a persisted state block back into a validated `EliseOutfitState`.
 *
 * Everything is re-validated: unknown enum values are dropped rather than
 * coerced, every array is capped, every string is bounded and control
 * characters are stripped. A block that does not survive validation yields
 * `null`, which the pipeline reads as "no active outfit" -- the same, safe
 * state as a first turn.
 */
export function restoreOutfitState(raw: unknown): EliseOutfitState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const outfitId = boundedString(record.outfitId, ELISE_OUTFIT_STATE_LIMITS.maxIdChars);
  if (!outfitId) return null;

  const turnValue = typeof record.turn === 'number' && Number.isFinite(record.turn)
    ? Math.floor(record.turn)
    : 0;
  // A turn count past the bound means the conversation has been refining the
  // same outfit for longer than this contract models. Restarting is the honest
  // response; carrying an unbounded counter is not.
  if (turnValue < 0 || turnValue > ELISE_OUTFIT_STATE_LIMITS.maxTurns) return null;

  const items: EliseOutfitStateItem[] = [];
  if (Array.isArray(record.items)) {
    for (const entry of record.items) {
      if (items.length >= ELISE_OUTFIT_STATE_LIMITS.maxItems) break;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const candidateId = boundedString(item.candidateId, ELISE_OUTFIT_STATE_LIMITS.maxIdChars);
      if (!candidateId) continue;
      const role = item.role as EliseRecommendationRole;
      const relationship = item.relationship as EliseActorRelationship;
      const sourceType = item.sourceType as EliseWardrobeSourceType;
      if (!VALID_ROLES.includes(role)) continue;
      if (!VALID_RELATIONSHIPS.includes(relationship)) continue;
      if (!VALID_SOURCE_TYPES.includes(sourceType)) continue;
      if (items.some((existing) => existing.candidateId === candidateId)) continue;
      items.push({ candidateId, role, relationship, sourceType });
    }
  }

  return {
    outfitId,
    turn: turnValue,
    items,
    retainedCandidateIds: boundedStringArray(
      record.retainedCandidateIds,
      ELISE_OUTFIT_STATE_LIMITS.maxRetained,
      ELISE_OUTFIT_STATE_LIMITS.maxIdChars,
    ),
    rejectedCandidateIds: boundedStringArray(
      record.rejectedCandidateIds,
      ELISE_OUTFIT_STATE_LIMITS.maxRejected,
      ELISE_OUTFIT_STATE_LIMITS.maxIdChars,
    ),
    rejectedGarmentClasses: boundedStringArray(
      record.rejectedGarmentClasses,
      ELISE_OUTFIT_STATE_LIMITS.maxRejectedClasses,
      32,
    ),
    activeConstraints: boundedStringArray(
      record.activeConstraints,
      ELISE_OUTFIT_STATE_LIMITS.maxConstraints,
      32,
    ),
  };
}

/**
 * Find the most recent persisted outfit state in a message history window.
 *
 * Rows must be newest-first, matching the order the generation path already
 * fetches them in. Only ASSISTANT rows are consulted: a user row's `ui_blocks`
 * is client-authored content for a message the server never generated, and
 * reading state out of one would let a crafted user message seed the outfit.
 */
export function findLatestOutfitState(
  rows: Array<{ sender?: unknown; ui_blocks?: unknown }>,
): EliseOutfitState | null {
  for (const row of rows) {
    if (row?.sender !== 'assistant') continue;
    if (!Array.isArray(row.ui_blocks)) continue;
    for (const block of row.ui_blocks) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as Record<string, unknown>;
      if (typed.type !== ELISE_OUTFIT_STATE_BLOCK_TYPE) continue;
      const restored = restoreOutfitState(typed.state);
      if (restored) return restored;
    }
  }
  return null;
}

// ── Reading the refinement out of the message ────────────────────────────────

/**
 * Does this message continue the active outfit, or start a new one?
 *
 * The bar for CONTINUING is a phrase that only makes sense against something
 * already on the table -- "swap the shoes", "keep the trousers", "not those",
 * "another version", "less formal". Everything else starts a new outfit, which
 * is the safe default: a new outfit simply means a fresh shortlist, while
 * wrongly continuing would silently apply stale exclusions to an unrelated
 * request.
 */
const SWAP_PATTERNS = [
  /\bswap\b/i, /\bchange\s+(?:the|my|out)\b/i, /\breplace\b/i,
  /\bdifferent\s+(?:shoes?|top|jacket|bag|pair)\b/i,
];
const KEEP_PATTERNS = [
  /\bkeep\b/i, /\bstick\s+with\b/i, /\bhold\s+on\s+to\b/i, /\bleave\s+the\b/i,
];
const REJECT_PATTERNS = [
  /\bnot\s+(?:the|those|that|these)\b/i, /\bno\s+(?:to\s+)?(?:the)\b/i,
  /\bdon'?t\s+(?:like|want)\b/i, /\bsomething\s+else\b/i, /\banything\s+but\b/i,
  /\blose\s+the\b/i, /\bdrop\s+the\b/i, /\bskip\s+the\b/i,
];
const VARIATION_PATTERNS = [
  /\banother\s+(?:version|option|one|look)\b/i, /\bdifferent\s+version\b/i,
  /\bshow\s+me\s+(?:another|more)\b/i, /\btry\s+again\b/i,
  /\bsomething\s+(?:different|new)\b/i,
];
const CONSTRAINT_PATTERNS: Array<[RegExp, string]> = [
  [/\bless\s+formal\b|\bmore\s+casual\b|\bdress\s+(?:it\s+)?down\b/i, 'less_formal'],
  [/\bmore\s+formal\b|\bdress\s+(?:it\s+)?up\b|\bsmarter\b/i, 'more_formal'],
  [/\bwarmer\b|\bfor\s+the\s+cold\b/i, 'warmer'],
  [/\bcooler\b|\blighter\b/i, 'lighter'],
  [/\bbrighter\b|\bmore\s+colou?r\b/i, 'brighter'],
  [/\bsimpler\b|\bmore\s+minimal\b/i, 'simpler'],
  [/\bwithout\s+buying\b|\bno\s+shopping\b|\bcloset\s+only\b|\bown(?:ed)?\s+only\b/i, 'owned_only'],
];

export interface EliseRefinementDirectives {
  action: EliseRefinementAction;
  /** Garment classes the user asked to remove. */
  rejectedGarmentClasses: string[];
  /** Roles the user asked to keep. */
  retainedRoles: EliseRecommendationRole[];
  /** Garment classes the user asked to keep. */
  retainedGarmentClasses: string[];
  /** Constraint codes stated this turn. */
  constraints: string[];
}

/**
 * Read the refinement directives out of one message.
 *
 * Deliberately literal pattern matching, for the same reason the ownership
 * guard is: a clever intent parser that is occasionally wrong silently drops a
 * customer's instruction, which is worse than a blunt one whose behaviour can
 * be read off the table above. Nothing here calls a model.
 */
export function readRefinementDirectives(message: string): EliseRefinementDirectives {
  const text = typeof message === 'string' ? message : '';
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);

  const constraints: string[] = [];
  for (const [pattern, code] of CONSTRAINT_PATTERNS) {
    if (pattern.test(text) && !constraints.includes(code)) constraints.push(code);
  }

  const swap = SWAP_PATTERNS.some((p) => p.test(text));
  const keep = KEEP_PATTERNS.some((p) => p.test(text));
  const reject = REJECT_PATTERNS.some((p) => p.test(text));
  const variation = VARIATION_PATTERNS.some((p) => p.test(text));

  // Which garments does the message name, and on which side of the instruction?
  // A message can carry both ("keep the trousers, change everything else"), so
  // the two are read from the clause each garment sits in rather than from one
  // verdict about the whole sentence.
  const rejectedGarmentClasses: string[] = [];
  const retainedGarmentClasses: string[] = [];
  const retainedRoles: EliseRecommendationRole[] = [];

  const clauses = text.split(/[,;]|\band\b|\bbut\b/i);
  for (const clause of clauses) {
    const clauseKeeps = KEEP_PATTERNS.some((p) => p.test(clause));
    const clauseRejects =
      REJECT_PATTERNS.some((p) => p.test(clause)) || SWAP_PATTERNS.some((p) => p.test(clause));
    if (!clauseKeeps && !clauseRejects) continue;
    for (const word of clause.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
      const garment = garmentClassOf(word);
      if (!garment) continue;
      if (clauseKeeps) {
        if (!retainedGarmentClasses.includes(garment)) retainedGarmentClasses.push(garment);
      } else if (!rejectedGarmentClasses.includes(garment)) {
        rejectedGarmentClasses.push(garment);
      }
    }
    if (clauseKeeps) {
      for (const word of clause.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
        const role = ROLE_WORDS[word.toLowerCase()];
        if (role && !retainedRoles.includes(role)) retainedRoles.push(role);
      }
    }
  }

  // A rejection with no garment named ("something else", "try again") is a
  // request for a different outfit, not for a different piece.
  let action: EliseRefinementAction = 'new_outfit';
  if (swap && rejectedGarmentClasses.length) action = 'refine_swap';
  else if (reject && rejectedGarmentClasses.length) action = 'refine_reject';
  else if (keep && (retainedGarmentClasses.length || retainedRoles.length)) action = 'refine_keep';
  else if (variation || reject || swap) action = 'refine_variation';
  else if (constraints.length && words.length <= 12) action = 'refine_constraint';

  return {
    action,
    rejectedGarmentClasses: rejectedGarmentClasses.slice(
      0, ELISE_OUTFIT_STATE_LIMITS.maxRejectedClasses,
    ),
    retainedRoles,
    retainedGarmentClasses,
    constraints: constraints.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxConstraints),
  };
}

// ── Applying the refinement ──────────────────────────────────────────────────

/**
 * Turn the prior state plus this turn's directives into the exclusion and
 * retention sets the pipeline applies.
 *
 * `prior` being null (a first turn, a new outfit, a tampered block that failed
 * validation) yields empty sets, which is exactly the pre-V2 behaviour.
 */
export function planRefinement(input: {
  prior: EliseOutfitState | null;
  directives: EliseRefinementDirectives;
}): {
  continued: boolean;
  excludedCandidateIds: string[];
  excludedGarmentClasses: string[];
  retainedCandidateIds: string[];
  activeConstraints: string[];
} {
  const { prior, directives } = input;
  const continued = Boolean(prior) && directives.action !== 'new_outfit';

  if (!continued) {
    return {
      continued: false,
      excludedCandidateIds: [],
      excludedGarmentClasses: [],
      retainedCandidateIds: [],
      // A constraint stated on a NEW request still applies to that request.
      activeConstraints: directives.constraints,
    };
  }

  const state = prior as EliseOutfitState;

  // Exclusions accumulate across the conversation: a piece rejected two turns
  // ago stays rejected. That is the whole point -- a rejection the system
  // forgets is a rejection the customer has to repeat.
  const excludedCandidateIds = [...state.rejectedCandidateIds];
  const excludedGarmentClasses = [...state.rejectedGarmentClasses];

  for (const garment of directives.rejectedGarmentClasses) {
    if (!excludedGarmentClasses.includes(garment)) excludedGarmentClasses.push(garment);
  }

  // Retention is a REQUEST at this stage. The pipeline honours it only for ids
  // it can re-find in this turn's authorized evidence.
  const retainedCandidateIds: string[] = [];
  const wantsRole = (role: EliseRecommendationRole) => directives.retainedRoles.includes(role);
  for (const item of state.items) {
    if (excludedCandidateIds.includes(item.candidateId)) continue;
    if (wantsRole(item.role)) retainedCandidateIds.push(item.candidateId);
  }

  const activeConstraints = [...state.activeConstraints];
  for (const code of directives.constraints) {
    if (!activeConstraints.includes(code)) activeConstraints.push(code);
  }
  // A formality instruction replaces its opposite rather than stacking with it:
  // "less formal" after "more formal" is a correction, not a contradiction to
  // be held simultaneously.
  const dropOpposite = (a: string, b: string) => {
    if (directives.constraints.includes(a)) {
      const index = activeConstraints.indexOf(b);
      if (index >= 0) activeConstraints.splice(index, 1);
    }
  };
  dropOpposite('less_formal', 'more_formal');
  dropOpposite('more_formal', 'less_formal');
  dropOpposite('warmer', 'lighter');
  dropOpposite('lighter', 'warmer');

  return {
    continued: true,
    excludedCandidateIds: excludedCandidateIds.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxRejected),
    excludedGarmentClasses: excludedGarmentClasses.slice(
      0, ELISE_OUTFIT_STATE_LIMITS.maxRejectedClasses,
    ),
    retainedCandidateIds: retainedCandidateIds.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxRetained),
    activeConstraints: activeConstraints.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxConstraints),
  };
}

/**
 * Remove rejected candidates from a ranked shortlist.
 *
 * Exclusion is the ONLY thing restored state is allowed to do to a shortlist,
 * which is what makes it safe to restore from the client at all.
 */
export function applyRefinementExclusions(input: {
  shortlist: EliseScoredCandidate[];
  excludedCandidateIds: string[];
  excludedGarmentClasses: string[];
}): { shortlist: EliseScoredCandidate[]; excludedCandidateIds: string[] } {
  const excludedIds = new Set(input.excludedCandidateIds);
  const excludedClasses = new Set(input.excludedGarmentClasses);
  if (!excludedIds.size && !excludedClasses.size) {
    return { shortlist: input.shortlist, excludedCandidateIds: [] };
  }

  const removed: string[] = [];
  const kept = input.shortlist.filter((scored) => {
    const candidate = scored.candidate;
    if (excludedIds.has(candidate.candidateId)) {
      removed.push(candidate.candidateId);
      return false;
    }
    if (excludedClasses.size) {
      const classes = candidateGarmentClasses(candidate);
      if (classes.some((garment) => excludedClasses.has(garment))) {
        removed.push(candidate.candidateId);
        return false;
      }
    }
    return true;
  });

  return { shortlist: kept, excludedCandidateIds: removed };
}

/**
 * Build the state to persist for the next turn.
 *
 * `shortlist` is THIS turn's authorized, post-exclusion evidence, so every item
 * recorded here was re-derived from retrieval on this turn -- never carried
 * over from the restored object.
 */
export function projectOutfitState(input: {
  prior: EliseOutfitState | null;
  continued: boolean;
  shortlist: EliseScoredCandidate[];
  excludedCandidateIds: string[];
  excludedGarmentClasses: string[];
  retainedCandidateIds: string[];
  activeConstraints: string[];
  /** Injected so this module stays pure and its output stays testable. */
  newOutfitId: string;
}): { state: EliseOutfitState; outcome: EliseRefinementOutcome; action: EliseRefinementAction } {
  const authorizedIds = new Set(input.shortlist.map((s) => s.candidate.candidateId));

  // A retention only survives if this turn's evidence still authorizes it. An
  // id that cannot be re-found is REPORTED, never quietly kept: a piece that
  // can no longer be verified must not keep being spoken about as though it
  // were still there.
  const honouredRetainedIds = input.retainedCandidateIds.filter((id) => authorizedIds.has(id));
  const droppedRetainedIds = input.retainedCandidateIds.filter((id) => !authorizedIds.has(id));

  const items: EliseOutfitStateItem[] = input.shortlist
    .slice(0, ELISE_OUTFIT_STATE_LIMITS.maxItems)
    .map((scored) => ({
      candidateId: scored.candidate.candidateId,
      role: scored.recommendationRole,
      relationship: scored.candidate.actorRelationship,
      sourceType: scored.candidate.sourceType,
    }));

  const priorTurn = input.continued && input.prior ? input.prior.turn : 0;
  const state: EliseOutfitState = {
    outfitId: input.continued && input.prior ? input.prior.outfitId : input.newOutfitId,
    turn: Math.min(priorTurn + 1, ELISE_OUTFIT_STATE_LIMITS.maxTurns),
    items,
    retainedCandidateIds: honouredRetainedIds,
    rejectedCandidateIds: [
      ...new Set([
        ...(input.continued && input.prior ? input.prior.rejectedCandidateIds : []),
        ...input.excludedCandidateIds,
      ]),
    ].slice(0, ELISE_OUTFIT_STATE_LIMITS.maxRejected),
    rejectedGarmentClasses: input.excludedGarmentClasses.slice(
      0, ELISE_OUTFIT_STATE_LIMITS.maxRejectedClasses,
    ),
    activeConstraints: input.activeConstraints.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxConstraints),
  };

  return {
    state,
    outcome: {
      action: 'new_outfit',
      continued: input.continued,
      excludedCandidateIds: input.excludedCandidateIds,
      honouredRetainedIds,
      droppedRetainedIds,
    },
    action: 'new_outfit',
  };
}
