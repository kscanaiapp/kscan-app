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
  EliseAdviceIntent,
  EliseOutfitState,
  EliseOutfitStateItem,
  EliseRecommendationRole,
  EliseRefinementAction,
  EliseRefinementOutcome,
  EliseScoredCandidate,
  EliseWardrobeCandidate,
  EliseWardrobeSourceType,
} from './eliseAdviceTypes.ts';
import { COLOR_TOKENS } from './eliseFashionFeatures.ts';

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
  maxLooks: 3,
  maxLookItems: 4,
  maxOccasionTokens: 4,
} as const;

/** The block type the client persists this state under, in `ui_blocks`. */
export const ELISE_OUTFIT_STATE_BLOCK_TYPE = 'concierge_outfit_state';

const VALID_ROLES: EliseRecommendationRole[] = [
  'primary', 'alternative', 'layer', 'shoe', 'accessory', 'substitute', 'gap',
];
const VALID_RELATIONSHIPS: EliseActorRelationship[] = [
  'owned', 'saved', 'scanned', 'shared', 'discovered', 'unverified', 'unknown',
];
const VALID_INTENTS: EliseAdviceIntent[] = [
  'style_current_item', 'build_outfit', 'compare_items', 'find_owned_alternative',
  'find_saved_alternative', 'wardrobe_gap', 'purchase_advice', 'occasion_fit', 'color_pairing',
  'layering_advice', 'shoe_pairing', 'accessory_pairing', 'seasonal_advice',
  'multi_look_generation', 'general_style_advice',
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

/**
 * Everyday umbrella words and the layering role they name (Build 35).
 *
 * "Keep the pants" when the look holds jeans, "different shoes" when it holds
 * loafers: the customer names the ROLE, and a garment-class match alone finds
 * nothing. One table for Packing and Concierge -- Packing previously carried
 * its own copy -- and the values are `inferLayeringRole`'s role codes, so no
 * second role taxonomy exists.
 */
const UMBRELLA_ROLE_WORDS: Record<string, string> = {
  trouser: 'bottom', trousers: 'bottom', pant: 'bottom', pants: 'bottom', jean: 'bottom', jeans: 'bottom',
  chino: 'bottom', chinos: 'bottom', short: 'bottom', shorts: 'bottom', skirt: 'bottom', skirts: 'bottom',
  bottom: 'bottom', bottoms: 'bottom', legging: 'bottom', leggings: 'bottom',
  top: 'base', tops: 'base', shirt: 'base', shirts: 'base', blouse: 'base', blouses: 'base', tee: 'base', tees: 'base',
  shoe: 'shoe', shoes: 'shoe', sneakers: 'shoe', boots: 'shoe', footwear: 'shoe', pair: 'shoe', pairs: 'shoe',
  dress: 'one_piece', dresses: 'one_piece',
  jacket: 'outer', jackets: 'outer', coat: 'outer', coats: 'outer', blazer: 'outer', blazers: 'outer',
  outerwear: 'outer',
  sweater: 'mid', sweaters: 'mid', cardigan: 'mid', knitwear: 'mid',
  bag: 'accessory', bags: 'accessory',
};

/** The layering role an everyday garment or umbrella word names, or null. */
export function layeringRoleOfWord(word: string): string | null {
  return UMBRELLA_ROLE_WORDS[word.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/**
 * The role a piece plays in a look, for refinement. The scorer's layering
 * role when it has one; otherwise the role its own garment words name through
 * the umbrella table -- a "Camel blazer" filed under an "outerwear" bucket
 * that `inferLayeringRole` cannot place is still an outer layer.
 */
export function refinementRoleOf(candidate: EliseWardrobeCandidate): string | null {
  if (candidate.layeringRole) return candidate.layeringRole;
  for (const garment of candidateGarmentClasses(candidate)) {
    const role = layeringRoleOfWord(garment);
    if (role) return role;
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
    // Build 35. Optional; absent keys stay absent so an older block restores
    // byte-for-byte as it did.
    ...(VALID_INTENTS.includes(record.intent as EliseAdviceIntent)
      ? { intent: record.intent as EliseAdviceIntent }
      : {}),
    ...(Array.isArray(record.occasionTokens)
      ? {
          occasionTokens: boundedStringArray(
            record.occasionTokens,
            ELISE_OUTFIT_STATE_LIMITS.maxOccasionTokens,
            20,
          ).filter((token) => /^[a-z_]{2,20}$/.test(token)),
        }
      : {}),
    ...(Array.isArray(record.looks)
      ? {
          looks: record.looks
            .slice(0, ELISE_OUTFIT_STATE_LIMITS.maxLooks)
            .map((look) =>
              boundedStringArray(look, ELISE_OUTFIT_STATE_LIMITS.maxLookItems, ELISE_OUTFIT_STATE_LIMITS.maxIdChars)
            )
            .filter((look) => look.length > 0),
        }
      : {}),
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
  // Build 35: the one-word chip and its everyday forms.
  /^\s*(?:another|one\s+more|more\s+options?|other\s+options?|alternatives?)\s*[.!?]*\s*$/i,
];

// ── Build 35 refinement quality ─────────────────────────────────────────────
// Words that turn the garment or colour after them into a rejection. Kept to
// the customer's everyday forms, like the tables above.
const NEGATORS = new Set('no not without skip avoid nothing lose drop ditch'.split(' '));
const DETERMINERS = new Set('the those that these this my your'.split(' '));
const QUANTIFIERS = new Set('any all no a an'.split(' '));
const SWAP_WORDS = new Set('swap change replace different other another new switch'.split(' '));
/** A message that asks a NEW question rather than refining the one on the table. */
const NEW_TASK_PATTERNS = [
  /\bwhat\s+(?:should|can|could|do)\s+i\s+wear\b/i,
  /\b(?:outfit|look|something|ideas?)\s+(?:for|to\s+wear\s+to)\s+(?:a|an|my|the|this|next)\b/i,
  /\bwear\s+to\s+(?:a|an|my|the)\b/i,
  /\bstart\s+over\b/i, /\bfrom\s+scratch\b/i, /\bnew\s+outfit\b/i,
  /\bsomething\s+(?:\w+\s+)?for\s+(?:a|an|my|the|this|next)\s+(?!same\b)/i,
  /\bfor\s+(?:a|an|my|the)\s+(?:beach|wedding|party|date|interview|funeral|meeting|trip|vacation|holiday|brunch|gala|concert|festival|hike)\b/i,
];
// "I don't own that anymore", "not that one": a piece named only by pronoun.
const PRONOUN_REJECTION = /\b(?:don'?t\s+(?:own|have|like|want)|no\s+longer\s+(?:own|have)|not|lose|drop|skip|ditch)\s+(?:that|this|it)(?:\s+one)?\b/i;
const STYLE_TOKENS = new Set('formal casual'.split(' '));
const ORDINALS: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2 };
const ORDINAL_PATTERN = /\b(first|second|third|1st|2nd|3rd)\s+(?:one|look|option|outfit)\b|\b(?:look|option|outfit)\s+(?:#\s*|number\s+)?([1-3])\b/i;
const CHANGE_PATTERN = /\b(?:change|swap|replace|different|don'?t\s+like|not)\b/i;
const OTHER_REFERENCE = /\bthe\s+other\s+([a-z]+)\b/i;
const CORRECTION = /\b(?:that'?s|it'?s|this\s+is|those\s+are|these\s+are|they'?re|they\s+are|it\s+is|is|are)\s+(?:actually\s+)?(?:a\s+|an\s+)?([a-z]+),?\s+not\s+(?:a\s+|an\s+)?([a-z]+)\b/i;
const POSITIVE_COLOR = /\b(?:make\s+it|in|wear|use|want|prefer|go\s+with|something|instead|bright)\b/i;
const COLOR_ALLOWED =/\b([a-z]+)\s+is\s+(?:fine|ok(?:ay)?|good)\b/i;

export interface EliseRefinementTarget {
  /** 'reject': the user turned it down. 'swap': replace it and keep the rest. */
  kind: 'reject' | 'swap';
  garmentClass: string | null;
  /** The layering role an umbrella word names ("shoes", "jacket"). */
  role: string | null;
  /** Colour words qualifying it ("the black loafers"). */
  colors: string[];
  /**
   * True when the words name a PIECE ("the loafers", "those boots"), false
   * when they name a kind ("no heels"). A piece is removed by id; only a kind
   * becomes a class exclusion -- a narrow rejection is never broadened.
   */
  specific: boolean;
  word: string;
}
const CONSTRAINT_PATTERNS: Array<[RegExp, string]> = [
  // Build 35: a rejection REASON ("too formal", "don't overdress me") is a
  // direction, and continues the outfit like the instruction it implies.
  [/\bless\s+(?:formal|dressy)\b|\bmore\s+(?:casual|relaxed)\b|\bdress\s+(?:it\s+)?down\b|\btoo\s+(?:formal|dressy|fancy|smart|much)\b|\bover-?dress(?:ed|ing)?\b/i, 'less_formal'],
  [/\bmore\s+(?:formal|polished)\b|\bdress\s+(?:it\s+)?up\b|\bsmarter\b|\bdressier\b|\btoo\s+(?:casual|sloppy|plain)\b|\bunder-?dress(?:ed|ing)?\b/i, 'more_formal'],
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
  /** Build 35: pieces named for rejection or replacement, resolved by the planner. */
  targets: EliseRefinementTarget[];
  /** Build 35: "the second one" -- an index into the presented looks. */
  ordinal: { index: number; mode: 'keep' | 'change' } | null;
  /** Build 35: "the other jacket" / "the other one". */
  otherReference: { garmentClass: string | null; role: string | null; word: string } | null;
  /** Build 35: words after a negator that are neither garments nor colours ("no leather"). */
  negatedTerms: string[];
  /** Build 35: colours the user withdrew an exclusion for ("black is fine"). */
  allowedColors: string[];
  /** Build 35: the message asks a new question; the old outfit's state does not apply. */
  newTask: boolean;
  /** Build 35: "I don't own that anymore" -- a piece named only by pronoun. */
  pronounReference: boolean;
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

  // ── Build 35: targets, attributes, references, corrections ──────────────
  const targets: EliseRefinementTarget[] = [];
  const negatedTerms: string[] = [];
  const allowedColors: string[] = [];
  const correction = CORRECTION.exec(text);
  if (correction) {
    const [, actual, said] = correction;
    const actualClass = garmentClassOf(actual);
    const saidClass = garmentClassOf(said);
    if (actualClass && saidClass && actualClass !== saidClass) {
      constraints.push(`correct:${saidClass}>${actualClass}`.slice(0, 32));
    } else if (COLOR_TOKENS.includes(actual.toLowerCase()) && COLOR_TOKENS.includes(said.toLowerCase())) {
      constraints.push(`correct_color:${said.toLowerCase()}>${actual.toLowerCase()}`.slice(0, 32));
    }
  }
  const allowed = COLOR_ALLOWED.exec(text);
  if (allowed && COLOR_TOKENS.includes(allowed[1].toLowerCase())) allowedColors.push(allowed[1].toLowerCase());

  // A correction describes a piece; it is not a rejection of the word it corrects.
  const scanText = correction ? text.replace(correction[0], ' ') : text;
  for (const clause of scanText.split(/[,;.!?]|\bbut\b/i)) {
    const tokens = clause.toLowerCase().split(/[^a-z0-9']+/).map((word) => word.replace(/'/g, '')).filter(Boolean);
    const clauseKeeps = KEEP_PATTERNS.some((p) => p.test(clause)) || /\bdon'?t\s+(?:change|touch|swap)\b/i.test(clause);
    const clauseRejects = REJECT_PATTERNS.some((p) => p.test(clause)) || /\bdon'?t\s+(?:like|want|love)\b/i.test(clause);
    for (let index = 0; index < tokens.length; index += 1) {
      const word = tokens[index];
      const garmentClass = garmentClassOf(word);
      const role = layeringRoleOfWord(word);
      const isColor = COLOR_TOKENS.includes(word);
      if (!garmentClass && !role && !isColor) {
        if (index > 0 && NEGATORS.has(tokens[index - 1]) && word.length >= 4) negatedTerms.push(word);
        continue;
      }
      if (clauseKeeps) continue;
      // Walk back over colours to the word that governs this garment.
      let cursor = index - 1;
      const colors: string[] = [];
      while (cursor >= 0 && COLOR_TOKENS.includes(tokens[cursor])) {
        colors.unshift(tokens[cursor]);
        cursor -= 1;
      }
      const governing = tokens[cursor] ?? '';
      const before = tokens.slice(Math.max(0, cursor - 2), cursor + 1);
      if (isColor) {
        // A bare colour after a negator ("not black", "nothing black").
        const next = tokens[index + 1] ?? '';
        const bare = !garmentClassOf(next) && !layeringRoleOfWord(next) && !COLOR_TOKENS.includes(next);
        if (bare && (NEGATORS.has(governing) || (clauseRejects && colors.length === 0))) {
          constraints.push(`not_color:${word}`);
        } else if (bare && POSITIVE_COLOR.test(clause)) {
          // "Make it red", "red instead": an explicit wish, which outranks
          // Signature Style's inferred palette.
          constraints.push(`prefer_color:${word}`);
        }
        continue;
      }
      if (governing === 'other' && tokens[cursor - 1] === 'the') continue; // "the other jacket" is a reference
      const swapped = before.some((entry) => SWAP_WORDS.has(entry)) ||
        (SWAP_PATTERNS.some((p) => p.test(clause)) && !clauseRejects);
      const rejected = NEGATORS.has(governing) || before.some((entry) => NEGATORS.has(entry)) || clauseRejects;
      if (!swapped && !rejected) continue;
      const specific = DETERMINERS.has(governing) || (swapped && !QUANTIFIERS.has(governing));
      if (targets.some((target) => target.word === word)) continue;
      targets.push({
        kind: swapped && !NEGATORS.has(governing) ? 'swap' : 'reject',
        garmentClass,
        role,
        colors,
        specific,
        word,
      });
    }
  }
  for (const code of [...new Set(constraints.filter((code) => code.startsWith('not_color:')))]) {
    if (allowedColors.includes(code.split(':')[1])) constraints.splice(constraints.indexOf(code), 1);
  }

  const ordinalMatch = ORDINAL_PATTERN.exec(text);
  const ordinal = ordinalMatch
    ? {
        index: ordinalMatch[1] ? ORDINALS[ordinalMatch[1].toLowerCase()] : Number.parseInt(ordinalMatch[2], 10) - 1,
        mode: CHANGE_PATTERN.test(text) ? 'change' as const : 'keep' as const,
      }
    : null;
  const otherMatch = OTHER_REFERENCE.exec(text);
  const otherReference = otherMatch
    ? {
        garmentClass: otherMatch[1] === 'one' ? null : garmentClassOf(otherMatch[1]),
        role: otherMatch[1] === 'one' ? null : layeringRoleOfWord(otherMatch[1]),
        word: otherMatch[1].toLowerCase(),
      }
    : null;
  const newTask = NEW_TASK_PATTERNS.some((pattern) => pattern.test(text));
  const pronounReference = PRONOUN_REJECTION.test(text) && targets.length === 0;

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

  // Build 35: only a KIND named for rejection is a class exclusion. A piece
  // ("the loafers", "those boots") is resolved to its id by `planRefinement`,
  // and a swap never excludes a class at all -- "different shoes" must leave
  // other shoes to swap to.
  const classRejections = targets
    .filter((target) => target.kind === 'reject' && !target.specific && target.colors.length === 0 && target.garmentClass)
    .map((target) => target.garmentClass as string);
  const namedRejections = [...new Set([...rejectedGarmentClasses.filter((garment) =>
    !targets.some((target) => target.garmentClass === garment && (target.specific || target.kind === 'swap' || target.colors.length > 0))
  ), ...classRejections])];

  // A rejection with no garment named ("something else", "try again") is a
  // request for a different outfit, not for a different piece.
  let action: EliseRefinementAction = 'new_outfit';
  const hasTargets = targets.length > 0;
  if (newTask) action = 'new_outfit';
  else if (targets.some((target) => target.kind === 'swap') || (swap && namedRejections.length)) action = 'refine_swap';
  else if (hasTargets || (reject && namedRejections.length) || pronounReference) action = 'refine_reject';
  else if ((keep && (retainedGarmentClasses.length || retainedRoles.length)) || ordinal?.mode === 'keep' || otherReference) {
    action = 'refine_keep';
  } else if (ordinal?.mode === 'change') action = 'refine_swap';
  else if (variation || reject || swap) action = 'refine_variation';
  else if ((constraints.length || negatedTerms.length || allowedColors.length) && words.length <= 12) {
    action = 'refine_constraint';
  }

  return {
    action,
    rejectedGarmentClasses: namedRejections.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxRejectedClasses),
    retainedRoles,
    retainedGarmentClasses,
    constraints: [...new Set(constraints)].slice(0, ELISE_OUTFIT_STATE_LIMITS.maxConstraints),
    targets: targets.slice(0, 6),
    ordinal: ordinal && ordinal.index >= 0 && ordinal.index < ELISE_OUTFIT_STATE_LIMITS.maxLooks ? ordinal : null,
    otherReference,
    negatedTerms: [...new Set(negatedTerms)].slice(0, 4),
    allowedColors,
    newTask,
    pronounReference,
  };
}

// ── Applying the refinement ──────────────────────────────────────────────────

/**
 * Build 35. Does this message refine the outfit on the table? The one answer
 * both the pipeline (which task to rank for) and `planRefinement` (which state
 * to carry) use. "Something different for the beach" after a dinner outfit is
 * a new question, whatever its wording borrows from a refinement, and old
 * exclusions must not follow it.
 */
export function continuesOutfit(input: {
  prior: EliseOutfitState | null;
  directives: EliseRefinementDirectives;
  messageOccasionTokens?: string[];
}): boolean {
  if (!input.prior || input.directives.action === 'new_outfit' || input.directives.newTask) return false;
  // "Formal" and "casual" are in the occasion vocabulary but describe style:
  // "make it less formal" refines a dinner outfit, it does not replace it.
  const occasions = (tokens: string[] | undefined) => (tokens ?? []).filter((token) => !STYLE_TOKENS.has(token));
  const priorOccasions = occasions(input.prior.occasionTokens);
  const messageOccasions = occasions(input.messageOccasionTokens);
  const occasionChanged = priorOccasions.length > 0 && messageOccasions.length > 0 &&
    !messageOccasions.some((token) => priorOccasions.includes(token));
  return !occasionChanged;
}

/**
 * Turn the prior state plus this turn's directives into the exclusion and
 * retention sets the pipeline applies.
 *
 * `prior` being null (a first turn, a new outfit, a tampered block that failed
 * validation) yields empty sets, which is exactly the pre-V2 behaviour.
 *
 * Build 35. Named pieces ("the loafers", "those boots", "different shoes",
 * "the other jacket", "the second one") are resolved HERE, against the look
 * that was actually presented and this turn's authorized candidates -- never
 * by broadening them to a class. Whatever the refinement did not target in
 * the presented look is PRESERVED: a small correction makes a small change.
 */
export function planRefinement(input: {
  prior: EliseOutfitState | null;
  directives: EliseRefinementDirectives;
  /** This turn's authorized candidates. Resolution can only ever REMOVE or keep these. */
  candidates?: EliseWardrobeCandidate[];
  /** Occasion tokens this message names. A different occasion is a new task. */
  messageOccasionTokens?: string[];
}): {
  continued: boolean;
  excludedCandidateIds: string[];
  excludedGarmentClasses: string[];
  retainedCandidateIds: string[];
  activeConstraints: string[];
  /** Build 35: pieces of the presented look the refinement did not target. */
  preservedCandidateIds: string[];
  /** Build 35: a reference with more than one plausible piece. Nothing is guessed. */
  ambiguity: { noun: string; candidateIds: string[] } | null;
  /** Build 35: named pieces that are not on the table (reported, never broadened). */
  unresolved: string[];
} {
  const { prior, directives } = input;
  const continued = continuesOutfit({ prior, directives, messageOccasionTokens: input.messageOccasionTokens });

  if (!continued) {
    return {
      continued: false,
      excludedCandidateIds: [],
      excludedGarmentClasses: [],
      retainedCandidateIds: [],
      // A constraint stated on a NEW request still applies to that request.
      activeConstraints: directives.constraints,
      preservedCandidateIds: [],
      ambiguity: null,
      unresolved: [],
    };
  }

  const state = prior as EliseOutfitState;
  const byId = new Map((input.candidates ?? []).map((candidate) => [candidate.candidateId, candidate]));
  const presented = state.looks?.[0] ?? state.items.slice(0, 3).map((item) => item.candidateId);
  const pool = [...presented, ...state.items.map((item) => item.candidateId).filter((id) => !presented.includes(id))];
  const colorsOf = (id: string) => (byId.get(id)?.colors ?? []).join(' ').toLowerCase();
  // The role a piece plays. The scorer's role when it has one; otherwise the
  // role its own garment words name ("Camel blazer" in an "outerwear" bucket
  // the scorer cannot place), through the shared umbrella table.
  const roleOf = (id: string): string | null => {
    const candidate = byId.get(id);
    return candidate ? refinementRoleOf(candidate) : null;
  };
  type Named = { garmentClass: string | null; role: string | null; colors: string[] };
  // The pieces the words name, among `ids`. The garment CLASS first ("those
  // boots" are boots); the umbrella role only when no piece is of that class
  // ("the jacket" when the look holds a blazer). Colours narrow either way.
  const pick = (ids: string[], target: Named): string[] => {
    const known = ids.filter((id) => byId.has(id));
    const colored = (list: string[]) =>
      target.colors.length === 0 ? list : list.filter((id) => target.colors.some((color) => colorsOf(id).includes(color)));
    const byClass = target.garmentClass
      ? known.filter((id) => candidateGarmentClasses(byId.get(id)!).includes(target.garmentClass!))
      : [];
    if (byClass.length > 0) return colored(byClass);
    return target.role ? colored(known.filter((id) => roleOf(id) === target.role)) : [];
  };

  // Exclusions accumulate across the conversation: a piece rejected two turns
  // ago stays rejected. That is the whole point -- a rejection the system
  // forgets is a rejection the customer has to repeat.
  const excludedCandidateIds = [...state.rejectedCandidateIds];
  const excludedGarmentClasses = [...state.rejectedGarmentClasses];
  const exclude = (id: string) => {
    if (!excludedCandidateIds.includes(id)) excludedCandidateIds.push(id);
  };

  for (const garment of directives.rejectedGarmentClasses) {
    if (!excludedGarmentClasses.includes(garment)) excludedGarmentClasses.push(garment);
  }

  const unresolved: string[] = [];
  let ambiguity: { noun: string; candidateIds: string[] } | null = null;
  const targeted = new Set<string>();
  for (const target of directives.targets) {
    if (target.kind === 'reject' && !target.specific && target.colors.length === 0) continue; // a class, handled above
    let ids: string[];
    if (target.kind === 'reject' && !target.specific) {
      // "No black heels": every authorized piece that is both, by id. A piece
      // with no recorded colour is not assumed to be black.
      ids = pick([...byId.keys()], target);
    } else {
      const inLook = pick(presented, target);
      const inPool = pick(pool, target);
      if (inLook.length > 0) ids = inLook;
      // Not in the presented look: a swap moves on to the next option, so the
      // top-ranked match is the one being replaced -- never every match, which
      // would leave nothing to swap to. A rejection of "those boots" with two
      // pairs on the table is a question, not a guess.
      else if (inPool.length <= 1 || target.kind === 'swap') ids = inPool.slice(0, 1);
      else {
        ambiguity ??= { noun: target.word, candidateIds: inPool.slice(0, 3) };
        continue;
      }
    }
    if (ids.length === 0) {
      unresolved.push(target.word);
      continue;
    }
    for (const id of ids) {
      exclude(id);
      targeted.add(id);
    }
  }

  // Retention is a REQUEST at this stage. The pipeline honours it only for ids
  // it can re-find in this turn's authorized evidence.
  const retainedCandidateIds: string[] = [];
  const wantsRole = (role: EliseRecommendationRole) => directives.retainedRoles.includes(role);
  for (const item of state.items) {
    if (excludedCandidateIds.includes(item.candidateId)) continue;
    if (wantsRole(item.role)) retainedCandidateIds.push(item.candidateId);
  }
  // Build 35: "keep the jacket" when the look holds a blazer -- the class or
  // the umbrella role, resolved against the presented look first.
  for (const garment of directives.retainedGarmentClasses) {
    const target = { garmentClass: garment, role: layeringRoleOfWord(garment), colors: [] };
    const inLook = pick(presented, target);
    for (const id of inLook.length > 0 ? inLook : pick(pool, target).slice(0, 1)) {
      if (!retainedCandidateIds.includes(id) && !excludedCandidateIds.includes(id)) retainedCandidateIds.push(id);
    }
  }

  // "The second one": the structured look at that index, never the prose.
  if (directives.ordinal) {
    const look = state.looks?.[directives.ordinal.index];
    if (!look) {
      unresolved.push(`look ${directives.ordinal.index + 1}`);
    } else if (directives.ordinal.mode === 'keep') {
      for (const id of look) if (!retainedCandidateIds.includes(id)) retainedCandidateIds.push(id);
    } else {
      const elsewhere = new Set((state.looks ?? []).filter((_, index) => index !== directives.ordinal!.index).flat());
      for (const id of look) {
        if (elsewhere.has(id)) continue;
        exclude(id);
        targeted.add(id);
      }
    }
  }

  // "Use the other jacket": the one candidate on the table, outside the
  // presented look, that the words name. Two plausible pieces are a question.
  // "I don't own that anymore": with one piece on the table it is that piece;
  // with several it is a question. Never a guess.
  if (directives.pronounReference) {
    if (presented.length === 1) {
      exclude(presented[0]);
      targeted.add(presented[0]);
    } else if (presented.length > 1) {
      ambiguity ??= { noun: 'piece', candidateIds: presented.slice(0, 3) };
    }
  }

  if (directives.otherReference) {
    const reference = directives.otherReference;
    const target = { garmentClass: reference.garmentClass, role: reference.role, colors: [] };
    const named = reference.garmentClass || reference.role;
    const outside = pool.filter((id) => !presented.includes(id) && !excludedCandidateIds.includes(id));
    const others = named ? pick(outside, target) : outside;
    if (others.length === 1) {
      retainedCandidateIds.push(others[0]);
      for (const id of named ? pick(presented, target) : []) {
        exclude(id);
        targeted.add(id);
      }
    } else if (others.length > 1) {
      ambiguity = { noun: reference.word === 'one' ? 'piece' : reference.word, candidateIds: others.slice(0, 3) };
    } else {
      unresolved.push(`other ${reference.word}`);
    }
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
  // Build 35: a colour wish and a colour exclusion for the same colour cannot
  // both stand; the later instruction wins. "Black is fine" lifts the exclusion.
  for (const code of directives.constraints) {
    const [kind, color] = code.split(':');
    if (kind === 'prefer_color') {
      for (const existing of [...activeConstraints]) {
        if (existing === `not_color:${color}` || (existing.startsWith('prefer_color:') && existing !== code)) {
          activeConstraints.splice(activeConstraints.indexOf(existing), 1);
        }
      }
    } else if (kind === 'not_color') {
      const index = activeConstraints.indexOf(`prefer_color:${color}`);
      if (index >= 0) activeConstraints.splice(index, 1);
    }
  }
  for (const color of directives.allowedColors) {
    const index = activeConstraints.indexOf(`not_color:${color}`);
    if (index >= 0) activeConstraints.splice(index, 1);
  }

  // PRESERVE what the refinement did not target. A variation ("another")
  // asks for a different look and preserves nothing; everything else keeps the
  // presented pieces it did not name, so "different shoes" changes the shoes.
  const excludedColors = activeConstraints
    .filter((code) => code.startsWith('not_color:'))
    .map((code) => code.slice('not_color:'.length));
  // "Keep the jacket, change everything else" names what stays; only a
  // reference swap ("use the other jacket") keeps the rest of the look too.
  const preserves = ['refine_swap', 'refine_reject', 'refine_constraint'].includes(directives.action) ||
    (directives.action === 'refine_keep' && Boolean(directives.otherReference) &&
      directives.retainedGarmentClasses.length === 0 && directives.retainedRoles.length === 0);
  const preservedCandidateIds = !preserves || ambiguity
    ? []
    : presented.filter((id) => {
        if (excludedCandidateIds.includes(id) || targeted.has(id)) return false;
        const candidate = byId.get(id);
        if (!candidate) return false;
        if (candidateGarmentClasses(candidate).some((garment) => excludedGarmentClasses.includes(garment))) return false;
        return !excludedColors.some((color) => colorsOf(id).includes(color));
      });

  return {
    continued: true,
    excludedCandidateIds: excludedCandidateIds.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxRejected),
    excludedGarmentClasses: excludedGarmentClasses.slice(
      0, ELISE_OUTFIT_STATE_LIMITS.maxRejectedClasses,
    ),
    retainedCandidateIds: retainedCandidateIds.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxRetained),
    activeConstraints: activeConstraints.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxConstraints),
    preservedCandidateIds,
    ambiguity,
    unresolved,
  };
}

/** Colour codes a state's constraints carry, restricted to the shared colour vocabulary. */
export function constraintColors(activeConstraints: string[], kind: 'not_color' | 'prefer_color'): string[] {
  return activeConstraints
    .filter((code) => code.startsWith(`${kind}:`))
    .map((code) => code.slice(kind.length + 1))
    .filter((color) => COLOR_TOKENS.includes(color));
}

/**
 * Remove rejected candidates from a ranked shortlist.
 *
 * Exclusion is the ONLY thing restored state is allowed to do to a shortlist,
 * which is what makes it safe to restore from the client at all.
 *
 * Build 35: colour and material exclusions act only on POSITIVE evidence. A
 * piece whose record carries no colour (or no material) is not assumed to
 * satisfy "not black" / "no leather"; it is kept and counted in
 * `unverifiedCandidateIds` so the prompt can say the claim cannot be made.
 */
export function applyRefinementExclusions(input: {
  shortlist: EliseScoredCandidate[];
  excludedCandidateIds: string[];
  excludedGarmentClasses: string[];
  excludedColors?: string[];
  excludedMaterials?: string[];
}): { shortlist: EliseScoredCandidate[]; excludedCandidateIds: string[]; unverifiedCandidateIds: string[] } {
  const excludedIds = new Set(input.excludedCandidateIds);
  const excludedClasses = new Set(input.excludedGarmentClasses);
  const colors = input.excludedColors ?? [];
  const materials = input.excludedMaterials ?? [];
  if (!excludedIds.size && !excludedClasses.size && !colors.length && !materials.length) {
    return { shortlist: input.shortlist, excludedCandidateIds: [], unverifiedCandidateIds: [] };
  }

  const removed: string[] = [];
  const unverified: string[] = [];
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
    if (colors.length) {
      const own = candidate.colors.join(' ').toLowerCase();
      if (colors.some((color) => own.includes(color))) {
        removed.push(candidate.candidateId);
        return false;
      }
      if (!own) unverified.push(candidate.candidateId);
    }
    if (materials.length) {
      const own = `${candidate.materials.join(' ')} ${candidate.title ?? ''}`.toLowerCase().split(/[^a-z]+/);
      if (materials.some((material) => own.includes(material))) {
        removed.push(candidate.candidateId);
        return false;
      }
      if (candidate.materials.length === 0 && !unverified.includes(candidate.candidateId)) {
        unverified.push(candidate.candidateId);
      }
    }
    return true;
  });

  return { shortlist: kept, excludedCandidateIds: removed, unverifiedCandidateIds: unverified };
}

/**
 * Build 35. Put the pieces a refinement keeps first, so the deterministic look
 * builder composes the next look AROUND them -- the presented look minus what
 * was changed -- instead of from a re-ranked list. Reorders only: nothing is
 * added, so an untrusted state cannot introduce a piece this way either.
 * A colour wish ("make it red") then lifts matching pieces within the rest.
 */
export function orderForRefinement(input: {
  shortlist: EliseScoredCandidate[];
  keepFirst: string[];
  preferColors: string[];
  /** Pieces the refinement moved away from ("too formal" -> the blazer), last. */
  demote?: string[];
}): EliseScoredCandidate[] {
  const demote = input.demote ?? [];
  const rank = (scored: EliseScoredCandidate) => {
    const kept = input.keepFirst.indexOf(scored.candidate.candidateId);
    if (kept >= 0) return kept;
    if (demote.includes(scored.candidate.candidateId)) return 300;
    const own = scored.candidate.colors.join(' ').toLowerCase();
    return input.preferColors.some((color) => own.includes(color)) ? 100 : 200;
  };
  if (!input.keepFirst.length && !input.preferColors.length && !demote.length) return input.shortlist;
  return input.shortlist
    .map((scored, index) => ({ scored, index }))
    .sort((a, b) => rank(a.scored) - rank(b.scored) || a.index - b.index)
    .map((entry) => entry.scored);
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
  /** Build 35: the task, its occasions, and the looks as presented. */
  intent?: EliseAdviceIntent;
  occasionTokens?: string[];
  looks?: string[][] | null;
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
  // Only looks made of THIS turn's authorized evidence are recorded.
  const looks = (input.looks ?? [])
    .map((look) => look.filter((id) => authorizedIds.has(id)).slice(0, ELISE_OUTFIT_STATE_LIMITS.maxLookItems))
    .filter((look) => look.length > 0)
    .slice(0, ELISE_OUTFIT_STATE_LIMITS.maxLooks);
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
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.occasionTokens && input.occasionTokens.length
      ? { occasionTokens: input.occasionTokens.slice(0, ELISE_OUTFIT_STATE_LIMITS.maxOccasionTokens) }
      : {}),
    ...(looks.length ? { looks } : {}),
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
