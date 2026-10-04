/**
 * Elise Conversation Quality V2 — the deterministic task frame (Build 35).
 *
 * WHAT THIS IS. A pure reducer over the conversation the client ALREADY holds
 * (the session's loaded `messages`) plus the message being sent. It answers
 * four questions deterministically, with no model call and no network:
 *
 *   1. Is this turn a new task, or a refinement of the one on the table?
 *   2. Which explicit constraints are still live for that task — budget,
 *      colour, negations ("no heels"), occasion, owned-only, formality and
 *      warmth direction, rejected options, corrections?
 *   3. Does a reference in this turn ("that jacket", "the second one")
 *      resolve against something actually shown — or is it ambiguous?
 *   4. Did the reply that came back contradict a live constraint?
 *
 * WHAT THIS IS NOT.
 *   - Not a memory system. Nothing here is persisted: the frame is re-derived
 *     from the loaded history on every send, so there is no second store to
 *     drift, leak across actors, or outlive a session.
 *   - Not an ownership authority. It never marks anything owned. Ownership is
 *     decided server-side (`ownership=` on verified attachments) and by the
 *     RLS-bound Closet read; conversation text cannot grant it.
 *   - Not a Commerce scorer. It decides only WHETHER a turn the model already
 *     proposed as shopping may reach the existing Commerce path; ranking,
 *     shelf memory and exclusions stay in `commerceActivation` / #409.
 *   - Not a classifier model. Closed phrase sets only, for the same reason the
 *     server's `strengthForTurn` and `detectShelfMemoryDirective` use them.
 *
 * ZERO IMPORTS on purpose: several hook harnesses load their subject through a
 * require-map sandbox, and a pure leaf module can be mapped to itself.
 */

/** Local rollback switch, in the same idiom as ENABLE_STYLECHAT_EXPLANATIONS. */
export const ELISE_CONVERSATION_QUALITY_V2_ENABLED = true;

export const ELISE_CONVERSATION_FRAME_VERSION = 1 as const;

export const ELISE_CONVERSATION_FRAME_LIMITS = {
  /** Newest persisted/optimistic messages the frame will look at. */
  maxMessagesScanned: 16,
  /** A task older than this many user turns stops carrying constraints. */
  maxUserTurnsPerTask: 8,
  maxNegations: 8,
  maxRejections: 6,
  maxCorrections: 4,
  maxColors: 3,
  /**
   * Characters of any one message the frame will read. Above the server's
   * 1000-char reply cap, so a numbered list is never cut short and miscounted.
   */
  maxMessageChars: 2000,
} as const;

/** The persisted block type the notices below travel under (ui_blocks). */
export const ELISE_CONVERSATION_NOTICE_BLOCK_TYPE = 'elise_conversation_notice';

/** The `provider` value a locally-authored clarification is persisted with. */
export const ELISE_LOCAL_CLARIFICATION_PROVIDER = 'elise_clarification';

// ── Types ────────────────────────────────────────────────────────────────────

export type EliseTaskKind =
  | 'shopping'
  | 'owned_styling'
  | 'styling'
  | 'comparison'
  | 'identification'
  | 'wardrobe_question'
  | 'packing'
  | 'explanation'
  | 'general';

export type EliseTurnRelation =
  | 'new_task'
  | 'refinement'
  | 'reference'
  | 'rejection'
  | 'correction'
  | 'acceptance';

export type EliseNegationAxis = 'garment' | 'material' | 'color' | 'silhouette';

export interface EliseNegation {
  axis: EliseNegationAxis;
  /** Canonical token from a closed vocabulary, e.g. `heels`, `leather`. */
  token: string;
}

export interface EliseRejection {
  /** Canonical garment class of the rejected option. */
  garmentClass: string;
  /** Head noun as it was shown, e.g. `sneakers`. */
  noun: string;
  /** Vocabulary modifiers as shown, e.g. [`white`]. Empty = identity unknown. */
  modifiers: string[];
  /** Explicit reason token when the customer gave one, e.g. `too_formal`. */
  reason: string | null;
}

export interface EliseCorrection {
  from: string;
  to: string;
}

export type EliseShoppingMemoryOp = 'different' | 'another' | 'not_those' | 'reference' | 'cheaper';

export interface EliseConversationFrame {
  version: typeof ELISE_CONVERSATION_FRAME_VERSION;
  taskKind: EliseTaskKind;
  /** User turns this task has absorbed, including the current one. */
  userTurnsInTask: number;
  /** Canonical garment class the task is about, when one is established. */
  garmentFocus: string | null;
  occasion: string | null;
  budget: { amount: number; currency: string } | null;
  /** Colours the customer explicitly asked for. Descriptors of owned items are not requests. */
  colors: string[];
  negations: EliseNegation[];
  ownedOnly: boolean;
  formality: 'less' | 'more' | null;
  warmth: 'warmer' | 'cooler' | null;
  rejections: EliseRejection[];
  corrections: EliseCorrection[];
  /** A shelf was shown, or shopping was requested, inside this task. */
  shoppingActive: boolean;
  /** The previous assistant turn held a shopping proposal and offered it. */
  shoppingOffered: boolean;
}

export type EliseShoppingCue = 'explicit' | 'need' | 'memory_op' | 'acceptance' | null;

export type EliseReferenceOutcome =
  | { status: 'none' }
  | { status: 'resolved'; source: 'structured' | 'numbered' | 'prose'; label: string; ordinal: number | null }
  | { status: 'ambiguous'; candidates: string[]; noun: string }
  | { status: 'out_of_range'; ordinal: number; available: number };

export interface EliseTurnAnalysis {
  frame: EliseConversationFrame;
  relation: EliseTurnRelation;
  /** The previous task was dropped by this turn. */
  taskReset: boolean;
  shoppingCue: EliseShoppingCue;
  ownedOnlyCue: boolean;
  memoryOp: EliseShoppingMemoryOp | null;
  reference: EliseReferenceOutcome;
  /**
   * A clarification the client can answer WITHOUT a model call, because the
   * ambiguity is a fact about what was shown rather than a styling judgement.
   */
  localClarification: string | null;
  /** The message is only a request for an item: "Only black boots please." */
  ellipticalRequest: boolean;
}

/** Minimal message shape the frame reads — satisfied by `StyleChatMessage`. */
export interface EliseFrameMessage {
  sender: string;
  content?: unknown;
  uiBlocks?: unknown;
  provider?: unknown;
}

// ── Vocabulary ───────────────────────────────────────────────────────────────
//
// Word tables are written as single space-separated strings, never as arrays of
// quoted words: the Edge parity manifest scanner (B34-DEF-001) has minted
// phantom specifiers from quoted-word array literals before. This file is not
// an Edge module, but the habit is cheap and keeps it portable.

function words(list: string): string[] {
  return list.trim().split(/\s+/);
}

/** Canonical garment class -> nouns (singular and plural). */
const GARMENT_CLASS_WORDS: Readonly<Record<string, readonly string[]>> = {
  footwear: words(
    'shoe shoes sneaker sneakers trainer trainers loafer loafers boot boots bootie booties heel heels pump pumps ' +
      'stiletto stilettos slingback slingbacks sandal sandals mule mules flat flats oxford oxfords brogue brogues ' +
      'derby derbies espadrille espadrilles clog clogs slide slides',
  ),
  outerwear: words(
    'jacket jackets blazer blazers coat coats trench trenches parka parkas puffer puffers bomber bombers ' +
      'overcoat overcoats raincoat raincoats shacket shackets gilet gilets',
  ),
  top: words(
    'top tops tee tees t-shirt t-shirts shirt shirts blouse blouses sweater sweaters jumper jumpers knit knits ' +
      'cardigan cardigans hoodie hoodies sweatshirt sweatshirts tank tanks camisole camisoles turtleneck turtlenecks ' +
      'polo polos bodysuit bodysuits',
  ),
  bottom: words(
    'jeans trousers pants chinos shorts skirt skirts leggings joggers culottes',
  ),
  dress: words('dress dresses gown gowns jumpsuit jumpsuits romper rompers'),
  bag: words('bag bags tote totes clutch clutches crossbody backpack backpacks purse purses handbag handbags'),
  accessory: words(
    'belt belts scarf scarves hat hats cap caps sunglasses necklace necklaces earrings bracelet bracelets ' +
      'watch watches jewelry jewellery tie ties',
  ),
};

const NOUN_TO_CLASS = new Map<string, string>();
for (const [garmentClass, nouns] of Object.entries(GARMENT_CLASS_WORDS)) {
  for (const noun of nouns) NOUN_TO_CLASS.set(noun, garmentClass);
}

/**
 * Negatable garment tokens and every surface form that violates them.
 *
 * `heels` is a GROUP: a pump is a heel. Deliberately NOT included: `platform`
 * (platform sneakers are not heels) and `wedge` (too often a sneaker too).
 */
const GARMENT_NEGATION_FORMS: Readonly<Record<string, readonly string[]>> = {
  heels: words('heel heels heeled pump pumps stiletto stilettos slingback slingbacks'),
  boots: words('boot boots bootie booties'),
  sneakers: words('sneaker sneakers trainer trainers'),
  loafers: words('loafer loafers'),
  sandals: words('sandal sandals'),
  flats: words('flat flats'),
  blazer: words('blazer blazers'),
  jacket: words('jacket jackets'),
  coat: words('coat coats overcoat overcoats'),
  jeans: words('jeans'),
  shorts: words('shorts'),
  skirt: words('skirt skirts'),
  dress: words('dress dresses'),
  trousers: words('trousers pants'),
  hoodie: words('hoodie hoodies'),
  tie: words('tie ties'),
};

/** Named heel types: a singular "heel" counts only after one of these. */
const HEEL_TYPES = new Set(words('block kitten stiletto high low platform cone chunky slim spike wedge'));

/** Surface word -> the negation token it belongs to (heel -> heels). */
const SURFACE_TO_NEGATION = new Map<string, string>();
for (const [token, forms] of Object.entries(GARMENT_NEGATION_FORMS)) {
  for (const form of forms) SURFACE_TO_NEGATION.set(form, token);
}

const MATERIAL_TOKENS = words(
  'leather suede denim wool silk satin linen cashmere velvet sequin sequins lace fur nylon polyester cotton tweed corduroy',
);
/** Material -> garments that ARE that material by definition ("anything except denim" rules out jeans). */
const MATERIAL_IMPLIED_NOUNS: Readonly<Record<string, readonly string[]>> = {
  denim: words('jeans'),
};

const SILHOUETTE_TOKENS = words(
  'cropped oversized skinny bodycon mini maxi midi wide-leg flared strapless backless sleeveless',
);

const COLOR_TOKENS = words(
  'black white red blue navy green olive yellow orange pink purple brown tan beige camel cream ivory grey gray ' +
    'charcoal burgundy gold silver',
);

/** Extra vocabulary modifiers that distinguish two shown options. Never colours or materials. */
const STYLE_MODIFIERS = words(
  'structured tailored relaxed boxy slim chunky pointed-toe pointed platform block kitten ankle knee-high chelsea ' +
    'longline double-breasted quilted classic minimal',
);

const MODIFIER_VOCAB = new Set<string>([
  ...COLOR_TOKENS,
  ...MATERIAL_TOKENS,
  ...SILHOUETTE_TOKENS,
  ...STYLE_MODIFIERS,
]);

const OCCASION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['dinner', /\bdinner\b/],
  ['date', /\bdate(?:\s+night)?\b/],
  // Not bare `work`: "what shoes work with this?" is not an occasion.
  ['work', /\b(?:for|to|at)\s+work\b|\bwork[- ]appropriate\b|\b(?:office|workplace|meeting|business\s+casual)\b/],
  ['interview', /\binterview\b/],
  ['wedding', /\bwedding\b/],
  ['party', /\b(?:party|cocktail|gala)\b/],
  ['brunch', /\b(?:brunch|lunch)\b/],
  ['beach', /\bbeach\b/],
  ['gym', /\b(?:gym|workout)\b/],
  ['concert', /\bconcert\b/],
  ['weekend', /\b(?:weekend|errands)\b/],
  ['night_out', /\bnight\s+out\b/],
  ['graduation', /\bgraduation\b/],
];

// ── Phrase sets ──────────────────────────────────────────────────────────────

const EXPLICIT_SHOPPING_RE = new RegExp(
  [
    String.raw`\b(?:find|shop|buy|purchase|order)\b`,
    String.raw`\bget\s+me\b`,
    String.raw`\bwhere\s+(?:can|do|could|should)\s+i\s+(?:buy|get|find|shop)\b`,
    String.raw`\b(?:looking|look|searching|search)\s+for\b`,
    String.raw`\bshow\s+me\s+(?:some|a\s+few|options|more|other|different|another|what'?s\s+available)\b`,
    String.raw`\bshow\s+me\s+(?:\w+\s+){0,3}(?:under|below|for\s+less)\b`,
    String.raw`\b(?:options|recommendations?|suggestions?)\s+to\s+buy\b`,
    String.raw`\bto\s+buy\b`,
    String.raw`\bin\s+stock\b`,
    String.raw`\bon\s+sale\b`,
    String.raw`\bunder\s+\$?\s?\d`,
    String.raw`\$\s?\d`,
    String.raw`\bbudget\b`,
  ].join('|'),
  'i',
);

/**
 * Words an elliptical REQUEST FOR ITEMS may consist of besides garments and
 * attribute vocabulary: "Only black boots please.", "a red jacket, not
 * leather", "black loafers under $150". No verb, no question — just the thing.
 */
const ELLIPSIS_FILLER = new Set(words(
  'only just some a an pair pairs of please in under below with without no not and or but also maybe ideally ' +
    'something new usd dollars',
));

/** "I need a new rain jacket" — discovery, when not bound to what they own. */
const NEED_RE = /\b(?:i\s+need|i'?m\s+in\s+need\s+of|i\s+want\s+to\s+get)\s+(?:a|an|some|new|a\s+new)\b|\bi\s+want\s+(?:a\s+new|new|some\s+new)\b/i;

const OWNED_ONLY_RE = new RegExp(
  [
    String.raw`\b(?:use|using|with|from|out\s+of)\s+(?:only\s+)?(?:what|things|pieces|clothes|stuff|items)\s+i\s+(?:already\s+)?(?:own|have)\b`,
    String.raw`\bfrom\s+(?:my|the)\s+(?:closet|wardrobe)\b`,
    String.raw`\b(?:in|out\s+of)\s+my\s+(?:closet|wardrobe)\b`,
    String.raw`\b(?:which|what)\s+of\s+my\b`,
    String.raw`\b(?:which|what)\s+(?:\w+\s+){0,2}(?:do\s+)?i\s+(?:already\s+)?own\b`,
    String.raw`\bi\s+already\s+(?:own|have)\b`,
    String.raw`\bwhat\s+i\s+(?:already\s+)?(?:own|have)\b`,
    String.raw`\b(?:don'?t|do\s+not)\s+make\s+me\s+buy\b`,
    String.raw`\bwithout\s+(?:buying|shopping|purchasing)\b`,
    String.raw`\bno\s+shopping\b`,
    String.raw`\bshop\s+my\s+(?:closet|wardrobe)\b`,
    String.raw`\bdo\s+i\s+(?:already\s+)?(?:have|own)\b`,
    String.raw`\bnothing\s+new\b`,
  ].join('|'),
  'i',
);

/** Customer explicitly re-opens shopping after an owned-only turn. */
const SHOPPING_REOPEN_RE = /\b(?:happy|fine|ok(?:ay)?|willing)\s+to\s+(?:buy|shop)\b|\b(?:can|could)\s+buy\b|\bshow\s+me\s+(?:some\s+)?(?:options|things)\s+to\s+buy\b/i;

const ACCEPTANCE_RE = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|please do|go ahead|do it|let'?s see|show me|sounds good)\b[\s!.,]*(?:please)?[\s!.]*$/i;

const RESTART_RE = /\b(?:new\s+question|different\s+question|change\s+of\s+(?:topic|subject)|start\s+over|forget\s+(?:that|all\s+that|it)|never\s*mind|something\s+else\s+entirely)\b/i;

const PACKING_RE = /\b(?:pack|packing|suitcase|carry[- ]on|luggage)\b|\bwhat\s+(?:should|do)\s+i\s+bring\b/i;
const IDENTIFICATION_RE = /\bwhat\s+(?:style|kind|type|sort)\s+of\s+\w+\s+(?:is|are)\s+(?:this|that|it|these|those)\b|\bwhat\s+is\s+(?:this|that)\s+called\b|\bidentify\b|\bwhat\s+brand\b/i;
const WARDROBE_RE = /\bwhat\s+am\s+i\s+missing\b|\b(?:gaps?|missing)\b.*\b(?:closet|wardrobe)\b|\bcapsule\b|\bwhat\s+should\s+i\s+add\s+to\s+my\s+(?:closet|wardrobe)\b/i;
const COMPARISON_RE = /\bcompare\b|\bversus\b|\bvs\.?\s|\bwhich\s+(?:of\s+(?:these|those|the)|one)\b|\bwhich\s+is\s+better\b|\bbetter\s+with\b/i;
const EXPLANATION_RE = /^(?:why|how\s+come)\b|\bexplain\b|\btell\s+me\s+(?:more|why)\b|\bwhy\s+(?:does|do|is|would|did)\b/i;
const STYLING_RE = /\b(?:style|styling|outfit|wear|dress\s+me|pair|goes?\s+with|go\s+with|work\s+with|works\s+with|match|combine|layer|look)\b/i;
const REQUEST_SHAPE_RE = /\b(?:style|help\s+me|dress\s+me|what\s+should\s+i\s+wear|what\s+(?:do|can)\s+i\s+wear|build|put\s+together|outfit\s+for|find|show\s+me|recommend|suggest|what\s+goes\s+with|what\s+(?:shoes|jacket|top|bag)\b)/i;

/** "style my black blazer", "build an outfit around this dress" — the anchor noun. */
const ANCHOR_RE = /\b(?:style|styling|restyle|dress\s+up|dress\s+down|(?:build|make|put\s+together)\s+(?:me\s+)?(?:an?\s+)?(?:outfit|look)\s+(?:around|with|for)|outfit\s+(?:around|with))\s+(?:my|this|a|an|the|these|those|our)?\s*(?:[a-z-]+\s+){0,2}?(shoes?|sneakers?|trainers?|loafers?|boots?|booties?|heels?|pumps?|sandals?|mules?|flats?|jackets?|blazers?|coats?|trench|parkas?|puffers?|bombers?|tops?|tees?|t-shirts?|shirts?|blouses?|sweaters?|jumpers?|knits?|cardigans?|hoodies?|jeans|trousers|pants|chinos|shorts|skirts?|leggings|dress|dresses|gowns?|jumpsuits?|bags?|totes?|clutch|scarf|belt)\b/i;

/**
 * Kinds that belong to the same conversational job. Moving between members is
 * not a new task: "which of my shoes?" inside a styling task is still styling.
 */
const TASK_FAMILY: Readonly<Record<EliseTaskKind, string>> = {
  styling: 'styling',
  owned_styling: 'styling',
  comparison: 'styling',
  explanation: 'styling',
  general: 'styling',
  shopping: 'shopping',
  identification: 'identification',
  wardrobe_question: 'wardrobe',
  packing: 'packing',
};

/** Kinds strong enough to re-label a continuing task. */
const PROMOTING_KINDS = new Set<EliseTaskKind>(['shopping', 'owned_styling', 'packing', 'identification', 'wardrobe_question']);

/** Anaphora and refinement openers: this turn leans on the one before. */
const REFINEMENT_RE = new RegExp(
  [
    String.raw`^(?:different|another|one\s+more|something\s+else|other\s+options?|less|more|warmer|colder|cooler|lighter|cheaper|dressier|smarter|not|no|same|make\s+it|what\s+about|how\s+about|try|use|swap|instead|and|also|but|with|without|actually|keep|lose|ditch|now|then|ok(?:ay)?\s+but)\b`,
    // "this"/"these" are NOT anaphora on their own: "style this dress" names a
    // new object. They lean on the last turn only after a preposition.
    String.raw`\b(?:it|those|them|same|instead|again|too)\b`,
    String.raw`\b(?:with|for|to|over|under|about)\s+(?:this|these|that)\b`,
    String.raw`\bthat\s+(?:one|look|outfit|idea|option|pair)\b`,
    String.raw`\bthe\s+(?:first|second|third|fourth|fifth|last|other)\b`,
  ].join('|'),
  'i',
);

const LESS_FORMAL_RE = /\b(?:less\s+formal|more\s+casual|dress(?:ed)?\s+(?:it\s+)?down|more\s+relaxed|less\s+dressy|too\s+(?:formal|dressy|fancy|stiff|corporate)|casual(?:ize)?\s+it)\b/i;
const MORE_FORMAL_RE = /\b(?:more\s+formal|dressier|dress(?:ed)?\s+(?:it\s+)?up|smarter|less\s+casual|more\s+polished|too\s+(?:casual|sloppy|plain))\b/i;
const WARMER_RE = /\b(?:warmer|colder\s+than|it'?s\s+(?:cold|chilly|freezing)|getting\s+cold|too\s+cold|layer\s+up|chilly|freezing)\b/i;
const COOLER_RE = /\b(?:cooler|too\s+(?:warm|hot)|it'?s\s+(?:hot|warm|humid)|hotter\s+than)\b/i;

const DIFFERENT_RE = /\b(?:different(?:\s+ones?)?|something\s+else|other\s+options?)\b/i;
const ANOTHER_RE = /\b(?:another(?:\s+one)?|one\s+more)\b/i;
const NOT_THOSE_RE = /\b(?:not\s+(?:those|these|them)|none\s+of\s+(?:these|those|them))\b/i;
const CHEAPER_RE = /\b(?:cheaper|less\s+expensive|more\s+affordable|lower\s+price)\b/i;

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4,
  fifth: 5, '5th': 5, sixth: 6, '6th': 6,
};
const ORDINAL_RE = /\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|last)\s+(?:one|ones|look|option|outfit|pair|idea|suggestion|choice|item)\b|\b(?:option|look|number|#)\s*(\d)\b/i;

/**
 * "that jacket", "this black jacket". Bare "the jacket" and "the other dress"
 * are NOT treated as demonstrative references: too often generic, or already
 * pointing at one of two, to justify stopping the customer with a question.
 */
const DEMONSTRATIVE_RE = /\b(?:that|this|those|these)\s+(?:(?:[a-z-]+)\s+)?([a-z-]+)\b/gi;

/**
 * Negators that make a mention a CLASS exclusion when followed directly by a
 * garment/material/colour word. A following determiner ("the", "those") makes
 * it an object rejection instead — see REJECTION_RE.
 */
const NEGATOR = String.raw`(?:no|not|without|nothing|never|avoid|skip|minus|except|anything\s+but|anything\s+except|other\s+than|no\s+more|(?:i\s+)?(?:don'?t|do\s+not)\s+(?:want|like|love|do|wear)|(?:i\s+)?hate|not\s+a\s+fan\s+of)`;
const CLASS_NEGATION_RE = new RegExp(String.raw`\b${NEGATOR}\s+(?:any\s+|a\s+|an\s+)?([a-z-]+)(?:\s+([a-z-]+))?`, 'gi');

const REJECTION_RE = /\b(?:i\s+(?:don'?t|do\s+not)\s+(?:like|love|want)|(?:i\s+)?(?:don'?t|do\s+not)\s+(?:use|include)|i\s+hate|not\s+(?:a\s+fan\s+of|loving|into)|lose|ditch|drop|swap\s+out|get\s+rid\s+of|change|no\s+to)\s+(?:the|those|that|these|this)\s+([a-z-]+)/i;
const WRONG_RE = /\b(?:the|those|that|these|this)\s+([a-z-]+)\s+(?:are|is|look|looks|feel|feels)\s+(?:wrong|off|not\s+right|too\s+([a-z]+))/i;
const BARE_REJECTION_RE = /^(?:i\s+(?:don'?t|do\s+not)\s+like\s+(?:that|it|them|those|these)|not\s+(?:that|those|these)(?:\s+ones?)?|no,?\s+not\s+that|nope)\b/i;
const TOO_REASON_RE = /\b(?:that'?s|it'?s|they'?re|too)\s+(?:way\s+|a\s+bit\s+|kind\s+of\s+)?too\s+([a-z]+)|\btoo\s+([a-z]+)\b/i;

const CORRECTION_RE = /\b(?:those|that|it|they|these|this)(?:\s+(?:are|is)|'re|'s)\s+(?:actually\s+)?(?:a\s+|an\s+)?([a-z-]+)(?:\s*,)?\s+not\s+(?:a\s+|an\s+)?([a-z-]+)\b|\b(?:those|that|it|they|these|this)\s*(?:aren'?t|isn'?t|are\s+not|is\s+not)\s+(?:a\s+|an\s+)?([a-z-]+)(?:\s*[,;-]+\s*|\s+)(?:they'?re|it'?s|they\s+are|it\s+is)\s+(?:a\s+|an\s+)?([a-z-]+)\b/i;

const LIFT_RE = /\b([a-z-]+)\s+(?:are|is)\s+(?:fine|ok(?:ay)?|good|allowed)\b|\b(?:actually\s+)?(?:you\s+can\s+(?:use|include)|i'?m\s+ok(?:ay)?\s+with)\s+([a-z-]+)\b/i;

const BUDGET_RE = /\b(?:under|below|less\s+than|max(?:imum)?|up\s+to|no\s+more\s+than|within)\s+(\$|usd\s*|eur\s*|gbp\s*|£|€)?\s?(\d{1,6}(?:\.\d{1,2})?)\s*(dollars|usd|eur|euros|gbp|pounds)?/i;
const CLEAR_BUDGET_RE = /\b(?:any\s+price|price\s+(?:doesn'?t|does\s+not)\s+matter|no\s+budget|forget\s+the\s+budget)\b/i;

const REQUESTED_COLOR_RE = new RegExp(
  String.raw`\b(?:i\s+want|i'?d\s+like|something|anything|in|only|a|an|some|find\s+me\s+(?:a|an|some)?|show\s+me)\s+(?:(?:bright|deep|dark|light|pale|soft)\s+)?(${COLOR_TOKENS.join('|')})\b`,
  'i',
);

// ── Small helpers ────────────────────────────────────────────────────────────

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, ELISE_CONVERSATION_FRAME_LIMITS.maxMessageChars).toLowerCase().replace(/[‘’]/g, "'");
}

function uiBlocksOf(message: EliseFrameMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.uiBlocks)
    ? (message.uiBlocks as unknown[]).filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    : [];
}

function hasBlock(message: EliseFrameMessage, type: string): boolean {
  return uiBlocksOf(message).some((b) => b.type === type);
}

function isGreeting(message: EliseFrameMessage): boolean {
  return hasBlock(message, 'greeting');
}

function garmentClassOf(word: string): string | null {
  return NOUN_TO_CLASS.get(word) ?? null;
}

const FOCUS_NEGATORS = new Set(words('no not without nothing never except avoid skip minus'));

/** "dress me", "dress it up": the verb, not the garment. */
const DRESS_VERB_RE = /^(?:me|up|down|it|them|for|like)$/;

function firstGarmentClass(value: string): string | null {
  const tokens = [...value.matchAll(/[a-z-]+/g)].map((m) => m[0]);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'dress' && DRESS_VERB_RE.test(tokens[i + 1] ?? '')) continue;
    // "no blazer" excludes a garment; it does not make the task about one.
    if (FOCUS_NEGATORS.has(tokens[i - 1] ?? '') || FOCUS_NEGATORS.has(tokens[i - 2] ?? '')) continue;
    const garmentClass = garmentClassOf(tokens[i]);
    if (garmentClass) return garmentClass;
  }
  return null;
}

function occasionOf(value: string): string | null {
  for (const [token, pattern] of OCCASION_PATTERNS) if (pattern.test(value)) return token;
  return null;
}

function emptyFrame(): EliseConversationFrame {
  return {
    version: ELISE_CONVERSATION_FRAME_VERSION,
    taskKind: 'general',
    userTurnsInTask: 0,
    garmentFocus: null,
    occasion: null,
    budget: null,
    colors: [],
    negations: [],
    ownedOnly: false,
    formality: null,
    warmth: null,
    rejections: [],
    corrections: [],
    shoppingActive: false,
    shoppingOffered: false,
  };
}

function cloneFrame(frame: EliseConversationFrame): EliseConversationFrame {
  return {
    ...frame,
    budget: frame.budget ? { ...frame.budget } : null,
    colors: [...frame.colors],
    negations: frame.negations.map((n) => ({ ...n })),
    rejections: frame.rejections.map((r) => ({ ...r, modifiers: [...r.modifiers] })),
    corrections: frame.corrections.map((c) => ({ ...c })),
  };
}

// ── Per-message signal extraction ────────────────────────────────────────────

/** Phrases that contain a shopping verb without being a shopping request. */
const NOT_SHOPPING_PHRASES_RE = /\b(?:can'?t|cannot|couldn'?t|could\s+not|didn'?t|did\s+not)\s+find\b|\bin\s+order\s+to\b|\bhelp\s+me\s+find\s+(?:an?\s+)?(?:outfit|look|something\s+to\s+wear)\b/gi;

/** "recommend some black boots", "any good rain jackets?", "options for loafers". */
const ITEM_REQUEST_VERB_RE = /\b(?:recommend|suggest|show\s+me|any|options\s+for|ideas\s+for)\b/g;
const ITEM_REQUEST_FILLER = new Set(words(
  'me some a an few pair pairs of any good new nice cute decent rain waterproof winter summer warm lightweight ' +
    'everyday running walking statement',
));

/**
 * A recommend/suggest verb followed — with only filler or attribute words in
 * between — by a garment noun. "Recommend some black boots" asks for items;
 * "recommend how to style my boots" does not, because "how to style my" is not
 * filler.
 */
function asksForItems(value: string): boolean {
  ITEM_REQUEST_VERB_RE.lastIndex = 0;
  for (const match of value.matchAll(ITEM_REQUEST_VERB_RE)) {
    const rest = [...value.slice((match.index ?? 0) + match[0].length).matchAll(/[a-z][a-z-]*/g)].map((m) => m[0]);
    for (const token of rest.slice(0, 6)) {
      if (NOUN_TO_CLASS.has(token)) return true;
      if (ITEM_REQUEST_FILLER.has(token) || MODIFIER_VOCAB.has(token)) continue;
      break;
    }
  }
  return false;
}

export function shoppingCueOf(message: string, frame: EliseConversationFrame | null): EliseShoppingCue {
  const value = text(message).replace(NOT_SHOPPING_PHRASES_RE, ' ');
  if (!value) return null;
  if (frame?.shoppingOffered && ACCEPTANCE_RE.test(value.trim())) return 'acceptance';
  if (EXPLICIT_SHOPPING_RE.test(value) || asksForItems(value)) return 'explicit';
  if (frame?.shoppingActive && (DIFFERENT_RE.test(value) || ANOTHER_RE.test(value) || NOT_THOSE_RE.test(value) || CHEAPER_RE.test(value) || ORDINAL_RE.test(value))) {
    return 'memory_op';
  }
  if (NEED_RE.test(value) && firstGarmentClass(value)) return 'need';
  return null;
}

/**
 * Is this message nothing but a request for an item — "Only black boots
 * please."? Not a question, no verb, every word a garment, an attribute, a
 * price or filler, and at least one garment that is not ruled out.
 */
export function isEllipticalItemRequest(message: string): boolean {
  const value = text(message).trim();
  if (!value || value.includes('?')) return false;
  const tokens = [...value.matchAll(/\$?\d+(?:\.\d+)?|[a-z][a-z-]*/g)].map((m) => m[0]);
  if (!tokens.length || tokens.length > 10) return false;
  let garment = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\$?\d/.test(token)) continue;
    if (NOUN_TO_CLASS.has(token)) {
      if (!FOCUS_NEGATORS.has(tokens[i - 1] ?? '') && !FOCUS_NEGATORS.has(tokens[i - 2] ?? '')) garment = true;
      continue;
    }
    if (MODIFIER_VOCAB.has(token) || ELLIPSIS_FILLER.has(token)) continue;
    if (/^(?:bright|deep|dark|light|pale|soft)$/.test(token)) continue;
    return false;
  }
  return garment;
}

export function memoryOpOf(message: string): EliseShoppingMemoryOp | null {
  const value = text(message);
  if (NOT_THOSE_RE.test(value)) return 'not_those';
  if (ANOTHER_RE.test(value)) return 'another';
  if (DIFFERENT_RE.test(value)) return 'different';
  if (CHEAPER_RE.test(value)) return 'cheaper';
  if (ORDINAL_RE.test(value)) return 'reference';
  return null;
}

function classifyKind(value: string, ownedOnlyCue: boolean, shoppingCue: EliseShoppingCue): EliseTaskKind | null {
  if (PACKING_RE.test(value)) return 'packing';
  if (IDENTIFICATION_RE.test(value)) return 'identification';
  if (WARDROBE_RE.test(value)) return 'wardrobe_question';
  if (shoppingCue === 'explicit' && !ownedOnlyCue) return 'shopping';
  if (ownedOnlyCue) return 'owned_styling';
  if (COMPARISON_RE.test(value) || (/\bor\b/.test(value) && /\?\s*$/.test(value) && value.split(/\s+/).length <= 10)) {
    return 'comparison';
  }
  if (EXPLANATION_RE.test(value)) return 'explanation';
  if (STYLING_RE.test(value)) return 'styling';
  return null;
}

interface ExtractedCorrection extends EliseCorrection {
  /** Character span to hide from negation parsing ("not loafers" is not an exclusion). */
  span: [number, number];
}

function extractCorrection(value: string): ExtractedCorrection | null {
  const match = CORRECTION_RE.exec(value);
  if (!match) return null;
  const to = match[1] ?? match[4];
  const from = match[2] ?? match[3];
  if (!to || !from) return null;
  // Only garment/material words: "that's fine, not great" is not a correction.
  const known = (w: string) => NOUN_TO_CLASS.has(w) || MATERIAL_TOKENS.includes(w) || COLOR_TOKENS.includes(w);
  if (!known(to) || !known(from) || to === from) return null;
  return { from, to, span: [match.index, match.index + match[0].length] };
}

const PASS_THROUGH_WORDS = new Set(words('too bright dark light super very wear wearing want any more in with'));

function negationFor(word: string, next: string | undefined): EliseNegation | null {
  const garment = SURFACE_TO_NEGATION.get(word);
  if (garment) return { axis: 'garment', token: garment };
  if (MATERIAL_TOKENS.includes(word)) return { axis: 'material', token: word === 'sequins' ? 'sequin' : word };
  if (SILHOUETTE_TOKENS.includes(word)) return { axis: 'silhouette', token: word };
  if (COLOR_TOKENS.includes(word)) {
    return { axis: 'color', token: word === 'gray' ? 'grey' : word };
  }
  // "nothing too cropped", "no bright red", "never wear heels", "not in black"
  if (next && PASS_THROUGH_WORDS.has(word)) return negationFor(next, undefined);
  return null;
}

function extractNegations(value: string, hidden: [number, number] | null): EliseNegation[] {
  const found: EliseNegation[] = [];
  CLASS_NEGATION_RE.lastIndex = 0;
  for (const match of value.matchAll(CLASS_NEGATION_RE)) {
    const start = match.index ?? 0;
    if (hidden && start >= hidden[0] && start < hidden[1]) continue;
    const word = match[1];
    // A determiner means a specific object ("don't like the boots"): rejection, not class.
    if (/^(?:the|those|that|these|this|my|it|them)$/.test(word)) continue;
    const negation = negationFor(word, match[2]);
    if (negation && !found.some((n) => n.axis === negation.axis && n.token === negation.token)) {
      found.push(negation);
    }
  }
  return found;
}

function extractLifts(value: string): string[] {
  const match = LIFT_RE.exec(value);
  if (!match) return [];
  const word = match[1] ?? match[2];
  if (!word) return [];
  const negation = negationFor(word, undefined);
  return negation ? [negation.token] : [];
}

function extractBudget(value: string): { amount: number; currency: string } | null {
  const match = BUDGET_RE.exec(value);
  if (!match) return null;
  const amount = Number.parseFloat(match[2]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const symbol = (match[1] ?? '').trim();
  const word = (match[3] ?? '').trim();
  let currency: string | null = null;
  if (symbol === '$' || symbol === 'usd' || word === 'dollars' || word === 'usd') currency = 'USD';
  else if (symbol === '€' || symbol === 'eur' || word === 'eur' || word === 'euros') currency = 'EUR';
  else if (symbol === '£' || symbol === 'gbp' || word === 'gbp' || word === 'pounds') currency = 'GBP';
  // A number with no currency is not a budget the frame can hold honestly.
  return currency ? { amount, currency } : null;
}

function requestedColor(value: string, negations: EliseNegation[]): string | null {
  const match = REQUESTED_COLOR_RE.exec(value);
  if (!match) return null;
  const color = match[1] === 'gray' ? 'grey' : match[1];
  if (negations.some((n) => n.axis === 'color' && n.token === color)) return null;
  // "my black blazer" describes an owned piece; it is not a request for black.
  const before = value.slice(Math.max(0, (match.index ?? 0) - 4), match.index ?? 0);
  if (/\bmy\s*$/.test(before)) return null;
  return color;
}

/** Garment mentions in assistant prose: vocabulary modifiers + head noun. */
interface GarmentMention {
  noun: string;
  garmentClass: string;
  modifiers: string[];
  index: number;
}

function garmentMentions(value: string): GarmentMention[] {
  const tokens = [...value.matchAll(/[a-z][a-z-]*/g)];
  const mentions: GarmentMention[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const noun = tokens[i][0];
    const garmentClass = garmentClassOf(noun);
    if (!garmentClass) continue;
    const modifiers: string[] = [];
    for (let j = i - 1; j >= 0 && j >= i - 2; j -= 1) {
      const candidate = tokens[j][0];
      if (!MODIFIER_VOCAB.has(candidate)) break;
      modifiers.unshift(candidate);
    }
    mentions.push({ noun, garmentClass, modifiers, index: tokens[i].index ?? 0 });
  }
  return mentions;
}

function phraseOf(mention: { modifiers: string[]; noun: string }): string {
  return [...mention.modifiers, mention.noun].join(' ');
}

function extractRejection(
  value: string,
  previousAssistant: string,
): EliseRejection | null {
  let noun: string | null = null;
  let reason: string | null = null;
  const rejection = REJECTION_RE.exec(value);
  const wrong = WRONG_RE.exec(value);
  if (rejection) noun = rejection[1];
  else if (wrong) {
    noun = wrong[1];
    if (wrong[2]) reason = `too_${wrong[2]}`;
  }
  if (!noun) return null;
  const garmentClass = garmentClassOf(noun) ?? (noun === 'look' || noun === 'outfit' ? 'outfit' : null);
  if (!garmentClass) return null;
  if (!reason) {
    const too = TOO_REASON_RE.exec(value);
    const word = too?.[1] ?? too?.[2];
    if (word) reason = `too_${word}`;
  }
  // Resolve the object against what was actually shown: the LAST mention of
  // that class in the previous assistant turn. Without one, identity is
  // unknown and only the reason (if any) is retained.
  const shown = garmentMentions(previousAssistant).filter((m) => m.garmentClass === garmentClass);
  const last = shown[shown.length - 1];
  return {
    garmentClass,
    noun: last?.noun ?? noun,
    modifiers: last ? [...last.modifiers] : [],
    reason,
  };
}

function reasonFormality(reason: string | null): 'less' | 'more' | null {
  if (!reason) return null;
  if (/^too_(?:formal|dressy|fancy|stiff|corporate)$/.test(reason)) return 'less';
  if (/^too_(?:casual|sloppy|plain)$/.test(reason)) return 'more';
  return null;
}

// ── Structured options (for references) ──────────────────────────────────────

interface StructuredOption {
  label: string;
  garmentClass: string | null;
}

function productLabel(product: Record<string, unknown>): string | null {
  const title = product.title ?? product.name;
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : null;
}

/** Options the previous assistant turn actually rendered, in rendered order. */
function structuredOptionsOf(message: EliseFrameMessage | null): {
  commerce: StructuredOption[];
  numbered: StructuredOption[];
} {
  if (!message) return { commerce: [], numbered: [] };
  const commerce: StructuredOption[] = [];
  for (const block of uiBlocksOf(message)) {
    if (block.type !== 'commerce_products' || !Array.isArray(block.products)) continue;
    for (const product of block.products as unknown[]) {
      if (!product || typeof product !== 'object') continue;
      const label = productLabel(product as Record<string, unknown>);
      if (label) commerce.push({ label, garmentClass: firstGarmentClass(label.toLowerCase()) });
    }
  }
  const numbered: StructuredOption[] = [];
  for (const line of text(message.content).split('\n')) {
    const match = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (match) numbered.push({ label: match[2].trim().slice(0, 120), garmentClass: firstGarmentClass(match[2]) });
  }
  return { commerce, numbered };
}

function ordinalOf(value: string, available: number): number | null {
  const match = ORDINAL_RE.exec(value);
  if (!match) return null;
  if (match[2]) return Number.parseInt(match[2], 10);
  const word = match[1].toLowerCase();
  if (word === 'last') return available > 0 ? available : null;
  return ORDINAL_WORDS[word] ?? null;
}

const SPELLED = words('zero one two three four five six');

/**
 * Resolve "the second one" / "that jacket" against what was actually shown.
 *
 * Order: structured options the previous turn rendered, then the numbered
 * options in its prose, then garment mentions in its prose. Never guesses: two
 * plausible objects are AMBIGUOUS, not "probably the first".
 */
export function resolveEliseReference(
  message: string,
  previousAssistant: EliseFrameMessage | null,
): EliseReferenceOutcome {
  const value = text(message);
  if (!value || !previousAssistant) return { status: 'none' };
  const { commerce, numbered } = structuredOptionsOf(previousAssistant);

  if (ORDINAL_RE.test(value)) {
    const pool = commerce.length ? commerce : numbered;
    const source = commerce.length ? 'structured' : 'numbered';
    if (!pool.length) return { status: 'none' };
    const ordinal = ordinalOf(value, pool.length);
    if (ordinal === null) return { status: 'none' };
    if (ordinal < 1 || ordinal > pool.length) return { status: 'out_of_range', ordinal, available: pool.length };
    return { status: 'resolved', source, label: pool[ordinal - 1].label, ordinal };
  }

  // Demonstrative with a garment noun: "that jacket", "the black one" is left
  // to the model (no noun to match on).
  DEMONSTRATIVE_RE.lastIndex = 0;
  let noun: string | null = null;
  let userModifiers: string[] = [];
  for (const match of value.matchAll(DEMONSTRATIVE_RE)) {
    const candidate = match[1].toLowerCase();
    if (!garmentClassOf(candidate)) continue;
    noun = candidate;
    const between = match[0].split(/\s+/).slice(1, -1);
    userModifiers = between.filter((w) => MODIFIER_VOCAB.has(w));
    break;
  }
  if (!noun) return { status: 'none' };

  const sameNoun = (a: string, b: string) => a === b || a.replace(/s$/, '') === b.replace(/s$/, '');
  const mentions = garmentMentions(text(previousAssistant.content)).filter((m) => sameNoun(m.noun, noun!));
  const distinct = new Map<string, GarmentMention>();
  for (const mention of mentions) {
    if (userModifiers.length && !userModifiers.every((w) => mention.modifiers.includes(w))) continue;
    distinct.set(phraseOf(mention), mention);
  }
  if (distinct.size === 0) return { status: 'none' };
  if (distinct.size === 1) {
    const [only] = distinct.values();
    // "a blazer… or another blazer": two mentions nothing distinguishes may be
    // two objects. That is not certainty, so it is not resolved.
    if (!only.modifiers.length && mentions.length > 1) return { status: 'none' };
    return { status: 'resolved', source: 'prose', label: phraseOf(only), ordinal: null };
  }
  // Only claim ambiguity when every candidate is distinguishable by vocabulary;
  // "the jacket or the jacket" is not a question worth asking.
  const candidates = [...distinct.values()];
  if (candidates.some((c) => c.modifiers.length === 0)) return { status: 'none' };
  return { status: 'ambiguous', candidates: candidates.slice(0, 3).map(phraseOf), noun };
}

function clarificationFor(reference: EliseReferenceOutcome): string | null {
  if (reference.status === 'ambiguous') {
    const [a, b, c] = reference.candidates;
    if (c) return `Do you mean the ${a}, the ${b}, or the ${c}?`;
    return `Do you mean the ${a} or the ${b}?`;
  }
  if (reference.status === 'out_of_range') {
    const count = SPELLED[reference.available] ?? String(reference.available);
    return reference.available === 1
      ? 'I only suggested one option there — did you mean that one, or should I give you more?'
      : `I only suggested ${count} options there — which one did you mean?`;
  }
  return null;
}

// ── The reducer ──────────────────────────────────────────────────────────────

interface ApplyResult {
  frame: EliseConversationFrame;
  relation: EliseTurnRelation;
  taskReset: boolean;
  shoppingCue: EliseShoppingCue;
  ownedOnlyCue: boolean;
  memoryOp: EliseShoppingMemoryOp | null;
}

/**
 * Fold one user message into the frame. Copy-on-write: the frame passed in is
 * never mutated.
 */
function applyUserTurn(
  previous: EliseConversationFrame,
  message: string,
  previousAssistant: string,
  isFirstTurn: boolean,
): ApplyResult {
  const value = text(message);
  const ownedOnlyCue = OWNED_ONLY_RE.test(value);
  const shoppingCue = ownedOnlyCue && !SHOPPING_REOPEN_RE.test(value) ? null : shoppingCueOf(value, previous);
  const memoryOp = memoryOpOf(value);
  const kind = classifyKind(value, ownedOnlyCue, shoppingCue);
  const refinement = REFINEMENT_RE.test(value.trim());
  const requestShaped = REQUEST_SHAPE_RE.test(value);
  const occasion = occasionOf(value);
  const correction = extractCorrection(value);
  const focus = correction ? null : firstGarmentClass(value);
  // The garment a request is ANCHORED on ("style my black blazer…"), or the
  // category an explicit shopping request names. A garment merely mentioned
  // ("what shoes work with this?") is not a new anchor.
  const anchorMatch = ANCHOR_RE.exec(value);
  const anchor = anchorMatch ? garmentClassOf(anchorMatch[1]) : (kind === 'shopping' ? focus : null);

  // ── Task boundary ─────────────────────────────────────────────────────────
  //
  // Conservative on purpose: when in doubt the task CONTINUES (bounded by
  // maxUserTurnsPerTask), because dropping "no heels" mid-task is worse than
  // carrying it one turn too long. A reset needs positive evidence.
  const freshRequest = requestShaped && !refinement;
  const packingSwitch = kind === 'packing'
    ? previous.taskKind !== 'packing'
    : previous.taskKind === 'packing' && freshRequest;
  const occasionChanged = Boolean(occasion && previous.occasion && occasion !== previous.occasion);
  const anchorChanged = Boolean(anchor && previous.garmentFocus && anchor !== previous.garmentFocus);
  const kindChanged = Boolean(
    kind && previous.taskKind !== 'general' && kind !== previous.taskKind &&
      TASK_FAMILY[kind] !== TASK_FAMILY[previous.taskKind],
  );
  const stale = previous.userTurnsInTask >= ELISE_CONVERSATION_FRAME_LIMITS.maxUserTurnsPerTask;
  const taskReset =
    isFirstTurn ||
    RESTART_RE.test(value) ||
    packingSwitch ||
    stale ||
    // Mirrors the server reducer: a new garment category is a new shopping
    // intent even when phrased as a refinement ("find a blazer instead").
    (kind === 'shopping' && anchorChanged) ||
    (freshRequest && (occasionChanged || anchorChanged || kindChanged));

  const frame = taskReset ? emptyFrame() : cloneFrame(previous);
  frame.userTurnsInTask += 1;
  frame.shoppingOffered = false;

  // A refinement never demotes the task ("more casual" does not turn a
  // shopping task into generic styling); an explicit kind can promote it.
  if (taskReset) frame.taskKind = kind ?? 'general';
  else if (kind && (PROMOTING_KINDS.has(kind) || frame.taskKind === 'general')) frame.taskKind = kind;
  if (anchor && (taskReset || !frame.garmentFocus || anchorChanged)) frame.garmentFocus = anchor;
  else if (focus && !frame.garmentFocus) frame.garmentFocus = focus;
  if (occasion) frame.occasion = occasion;

  // ── Constraints ───────────────────────────────────────────────────────────
  if (ownedOnlyCue) frame.ownedOnly = true;
  if (frame.ownedOnly && SHOPPING_REOPEN_RE.test(value)) frame.ownedOnly = false;
  if (shoppingCue === 'explicit' || shoppingCue === 'need' || shoppingCue === 'acceptance') {
    frame.shoppingActive = true;
    if (!ownedOnlyCue) frame.ownedOnly = false;
  }

  if (CLEAR_BUDGET_RE.test(value)) frame.budget = null;
  const budget = extractBudget(value);
  if (budget) frame.budget = budget;

  const negations = extractNegations(value, correction ? correction.span : null);
  for (const negation of negations) {
    if (frame.negations.length >= ELISE_CONVERSATION_FRAME_LIMITS.maxNegations) break;
    if (!frame.negations.some((n) => n.axis === negation.axis && n.token === negation.token)) {
      frame.negations.push(negation);
    }
    if (negation.axis === 'color') frame.colors = frame.colors.filter((c) => c !== negation.token);
  }
  const lifted = extractLifts(value);
  if (lifted.length) frame.negations = frame.negations.filter((n) => !lifted.includes(n.token));

  const color = requestedColor(value, frame.negations);
  if (color && (kind === 'shopping' || frame.taskKind === 'shopping' || /\b(?:i\s+want|i'?d\s+like|something|anything|only|in)\b/.test(value))) {
    frame.colors = [color, ...frame.colors.filter((c) => c !== color)].slice(0, ELISE_CONVERSATION_FRAME_LIMITS.maxColors);
    // A colour asked for now overrides an earlier exclusion of it.
    frame.negations = frame.negations.filter((n) => !(n.axis === 'color' && n.token === color));
  }

  if (LESS_FORMAL_RE.test(value)) frame.formality = 'less';
  else if (MORE_FORMAL_RE.test(value)) frame.formality = 'more';
  if (WARMER_RE.test(value)) frame.warmth = 'warmer';
  else if (COOLER_RE.test(value)) frame.warmth = 'cooler';

  let relation: EliseTurnRelation = taskReset ? 'new_task' : 'refinement';

  if (correction) {
    relation = 'correction';
    frame.corrections = [
      ...frame.corrections.filter((c) => c.from !== correction.from),
      { from: correction.from, to: correction.to },
    ].slice(-ELISE_CONVERSATION_FRAME_LIMITS.maxCorrections);
  } else {
    const rejection = extractRejection(value, text(previousAssistant));
    if (rejection) {
      relation = 'rejection';
      frame.rejections = [...frame.rejections, rejection].slice(-ELISE_CONVERSATION_FRAME_LIMITS.maxRejections);
      const direction = reasonFormality(rejection.reason);
      if (direction) frame.formality = direction;
    } else if (BARE_REJECTION_RE.test(value.trim()) || (/^that'?s\s+too\s+/.test(value.trim()))) {
      relation = 'rejection';
      const too = TOO_REASON_RE.exec(value);
      const reason = too ? `too_${too[1] ?? too[2]}` : null;
      const direction = reasonFormality(reason);
      if (direction) frame.formality = direction;
      if (reason) {
        frame.rejections = [
          ...frame.rejections,
          { garmentClass: 'outfit', noun: 'outfit', modifiers: [], reason },
        ].slice(-ELISE_CONVERSATION_FRAME_LIMITS.maxRejections);
      }
    } else if (!taskReset && ORDINAL_RE.test(value)) {
      relation = 'reference';
    } else if (shoppingCue === 'acceptance') {
      relation = 'acceptance';
    }
  }

  return { frame, relation, taskReset, shoppingCue, ownedOnlyCue, memoryOp };
}

/**
 * Fold what an ASSISTANT turn rendered into the frame. Only structured facts
 * count: a shown shelf, and a held shopping proposal. Prose never changes a
 * constraint.
 */
function applyAssistantTurn(frame: EliseConversationFrame, message: EliseFrameMessage): EliseConversationFrame {
  const next = cloneFrame(frame);
  const held = uiBlocksOf(message).some(
    (b) => b.type === ELISE_CONVERSATION_NOTICE_BLOCK_TYPE &&
      (b.code === 'shopping_held_owned_only' || b.code === 'shopping_held_not_requested'),
  );
  // A HELD proposal is not a live shopping task: its intent block is kept only
  // so that a "yes" can resume it, never so "different" can start one.
  if (hasBlock(message, 'commerce_products') || (hasBlock(message, 'commerce_shopping_intent') && !held)) {
    next.shoppingActive = true;
  }
  next.shoppingOffered = held;
  return next;
}

/**
 * Derive the frame for the message being sent.
 *
 * Reads at most `maxMessagesScanned` of the newest messages, skips greetings
 * and still-optimistic assistant placeholders, and replays them in order. The
 * cost is linear in that bound and involves no I/O.
 */
export function analyzeEliseTurn(input: {
  messages: readonly EliseFrameMessage[] | null | undefined;
  message: string;
}): EliseTurnAnalysis {
  const all = Array.isArray(input.messages) ? input.messages : [];
  const window = all
    .filter((m) => m && (m.sender === 'user' || m.sender === 'assistant') && !isGreeting(m))
    .slice(-ELISE_CONVERSATION_FRAME_LIMITS.maxMessagesScanned);

  let frame = emptyFrame();
  let previousAssistant: EliseFrameMessage | null = null;
  let userTurns = 0;
  for (const message of window) {
    if (message.sender === 'assistant') {
      frame = applyAssistantTurn(frame, message);
      previousAssistant = message;
      continue;
    }
    const applied = applyUserTurn(frame, text(message.content), text(previousAssistant?.content), userTurns === 0);
    frame = applied.frame;
    userTurns += 1;
    previousAssistant = null;
  }

  const current = applyUserTurn(frame, input.message, text(previousAssistant?.content), userTurns === 0);
  const reference = current.taskReset && current.relation === 'new_task' && !ORDINAL_RE.test(text(input.message))
    ? ({ status: 'none' } as const)
    : resolveEliseReference(input.message, previousAssistant);

  // A reference into a Commerce shelf belongs to Commerce V2's own reference
  // path (it re-validates price and availability); the frame never answers it
  // locally, so there is exactly one authority for "the second pair".
  const commerceOwned = reference.status === 'out_of_range' && structuredOptionsOf(previousAssistant).commerce.length > 0;
  const localClarification = commerceOwned ? null : clarificationFor(reference);

  return {
    frame: current.frame,
    relation: reference.status !== 'none' && current.relation === 'refinement' ? 'reference' : current.relation,
    taskReset: current.taskReset,
    shoppingCue: current.shoppingCue,
    ownedOnlyCue: current.ownedOnlyCue,
    memoryOp: current.memoryOp,
    reference,
    localClarification,
    ellipticalRequest: isEllipticalItemRequest(input.message),
  };
}

// ── Commerce gate ────────────────────────────────────────────────────────────

export type EliseCommerceDecision =
  | { action: 'allow'; basis: 'explicit' | 'need' | 'memory_op' | 'acceptance' | 'elliptical' | 'active_task' }
  | { action: 'hold'; code: 'shopping_held_owned_only' | 'shopping_held_not_requested' };

/**
 * May a shopping proposal the MODEL made this turn reach the Commerce path?
 *
 * The model proposes; the customer's own words corroborate — the doctrine the
 * server reducer already applies to every shopping field (`userStatedToken`).
 * A garment word alone is not shopping ("which of my jackets works?", "what
 * shoes go with this?"), and an owned-only task never shops on its own.
 */
export function decideEliseCommerceActivation(turn: EliseTurnAnalysis): EliseCommerceDecision {
  const { frame } = turn;
  const explicitNow = turn.shoppingCue === 'explicit' || turn.shoppingCue === 'acceptance';
  if (frame.ownedOnly && !explicitNow) return { action: 'hold', code: 'shopping_held_owned_only' };
  if (turn.relation === 'correction') return { action: 'hold', code: 'shopping_held_not_requested' };
  if (turn.shoppingCue) return { action: 'allow', basis: turn.shoppingCue };
  // "Only black boots please." opening a task is a request for the item. The
  // same words inside a styling task ("black boots please" for the outfit on
  // the table) are a styling refinement, so they do not shop there.
  if (turn.ellipticalRequest && (turn.taskReset || frame.taskKind === 'shopping')) {
    return { action: 'allow', basis: 'elliptical' };
  }
  if (frame.shoppingActive && !turn.taskReset && frame.taskKind === 'shopping') {
    // "what about brown?" inside a live shopping task is a refinement of it.
    return { action: 'allow', basis: 'active_task' };
  }
  return { action: 'hold', code: 'shopping_held_not_requested' };
}

// ── Reply validation ─────────────────────────────────────────────────────────

export interface EliseReplyViolation {
  kind: 'negation' | 'rejected_repeat';
  /** Closed-vocabulary token(s), safe to persist and render. */
  token: string;
}

const REPLY_NEGATOR_BEFORE = /\b(?:no|not|without|skip(?:ping)?|avoid(?:ing)?|instead\s+of|rather\s+than|ditch(?:ing)?|drop(?:ping)?|lose|losing|swap(?:ping)?\s+(?:out\s+)?|leave\s+out|leaving\s+out|over|than|nor|never|exclud(?:e|ing)|except|minus|away\s+from|replac(?:e|ing)|trad(?:e|ing)|n't|since\s+you\s+(?:said|asked)|you\s+(?:said|asked|mentioned)|you\s+don'?t\s+want|ruled\s+out|passed\s+on)\b[^.!?;]{0,24}$/i;
const REPLY_NEGATED_AFTER = /^[^.!?;]{0,16}\b(?:are|is)\s+(?:out|off\s+the\s+table|not\s+an\s+option)\b|^\s*(?:aside|out|out\s+of\s+it)\b/i;

function affirmativeAt(value: string, index: number, length: number): boolean {
  const sentenceStart = Math.max(
    value.lastIndexOf('.', index - 1),
    value.lastIndexOf('!', index - 1),
    value.lastIndexOf('?', index - 1),
    value.lastIndexOf(';', index - 1),
    value.lastIndexOf('\n', index - 1),
  );
  const before = value.slice(Math.max(sentenceStart + 1, index - 60), index);
  const after = value.slice(index + length, index + length + 40);
  return !REPLY_NEGATOR_BEFORE.test(before) && !REPLY_NEGATED_AFTER.test(after);
}

/**
 * Check a reply against the live constraints of the task.
 *
 * Deliberately conservative: a mention counts only when it is AFFIRMATIVE —
 * "skip the heels", "instead of a blazer" and "since you said no heels" are
 * not violations. When unsure it does not flag; a false alarm in front of the
 * customer is worse than the miss, which the model prompt already guards.
 */
export function validateEliseReply(
  frame: EliseConversationFrame,
  reply: string,
): EliseReplyViolation[] {
  const value = text(reply);
  if (!value) return [];
  const violations: EliseReplyViolation[] = [];
  const add = (v: EliseReplyViolation) => {
    if (!violations.some((x) => x.kind === v.kind && x.token === v.token)) violations.push(v);
  };
  const tokens = [...value.matchAll(/[a-z][a-z-]*/g)];

  for (const negation of frame.negations) {
    for (let i = 0; i < tokens.length; i += 1) {
      const word = tokens[i][0];
      const index = tokens[i].index ?? 0;
      let hit = false;
      if (negation.axis === 'garment') {
        hit = SURFACE_TO_NEGATION.get(word) === negation.token;
        // Singular "heel" is usually a PART of a shoe or a figure of speech
        // ("the lift of a heel", "the heel of your hand"). It counts only as a
        // named heel type: "a block heel", "kitten heel".
        if (hit && word === 'heel') {
          hit = HEEL_TYPES.has(tokens[i - 1]?.[0] ?? '') && (tokens[i + 1]?.[0] ?? '') !== 'of';
        }
      } else if (negation.axis === 'material') {
        // A material counts when it qualifies a garment ("leather jacket"), or
        // when the garment is that material by definition ("jeans" for denim).
        const nextWord = tokens[i + 1]?.[0] ?? '';
        const secondWord = tokens[i + 2]?.[0] ?? '';
        const qualifies = word === negation.token && (garmentClassOf(nextWord) || garmentClassOf(secondWord));
        const implied = (MATERIAL_IMPLIED_NOUNS[negation.token] ?? []).includes(word);
        const inFocus = !frame.garmentFocus ||
          garmentClassOf(qualifies ? (garmentClassOf(nextWord) ? nextWord : secondWord) : word) === frame.garmentFocus;
        hit = Boolean((qualifies || implied) && inFocus);
      } else {
        // Colour and silhouette: only directly qualifying a garment of the task.
        const normalized = word === 'gray' ? 'grey' : word;
        const nextWord = tokens[i + 1]?.[0] ?? '';
        const nextClass = garmentClassOf(nextWord);
        hit = normalized === negation.token && Boolean(nextClass) &&
          (!frame.garmentFocus || nextClass === frame.garmentFocus);
      }
      if (hit && affirmativeAt(value, index, word.length)) {
        add({ kind: 'negation', token: negation.token });
        break;
      }
    }
  }

  // Rejected exact options — only where identity is known (a vocabulary
  // modifier was shown). "Reject only the object, not the entire category."
  for (const rejection of frame.rejections) {
    if (!rejection.modifiers.length || rejection.garmentClass === 'outfit') continue;
    for (const mention of garmentMentions(value)) {
      const sameNoun = mention.noun.replace(/s$/, '') === rejection.noun.replace(/s$/, '');
      const sameModifiers = rejection.modifiers.every((m) => mention.modifiers.includes(m));
      if (sameNoun && sameModifiers && affirmativeAt(value, mention.index, mention.noun.length)) {
        add({ kind: 'rejected_repeat', token: phraseOf(rejection) });
        break;
      }
    }
  }
  return violations;
}

// ── Notice block ─────────────────────────────────────────────────────────────

export type EliseConversationNoticeCode =
  | 'constraint_conflict'
  | 'rejected_repeat'
  | 'shopping_held_owned_only'
  | 'shopping_held_not_requested';

export interface EliseConversationNoticeBlock {
  type: typeof ELISE_CONVERSATION_NOTICE_BLOCK_TYPE;
  code: EliseConversationNoticeCode;
  /** Closed-vocabulary tokens only (never model prose). */
  tokens?: string[];
}

const TOKEN_RE = /^[a-z][a-z -]{0,40}$/;

export function buildEliseConversationNotices(input: {
  violations?: readonly EliseReplyViolation[] | null;
  commerceHold?: EliseCommerceDecision | null;
}): EliseConversationNoticeBlock[] {
  const blocks: EliseConversationNoticeBlock[] = [];
  const negations = (input.violations ?? []).filter((v) => v.kind === 'negation').map((v) => v.token);
  const repeats = (input.violations ?? []).filter((v) => v.kind === 'rejected_repeat').map((v) => v.token);
  const clean = (list: string[]) => list.filter((t) => TOKEN_RE.test(t)).slice(0, 3);
  if (clean(negations).length) {
    blocks.push({ type: ELISE_CONVERSATION_NOTICE_BLOCK_TYPE, code: 'constraint_conflict', tokens: clean(negations) });
  }
  if (clean(repeats).length) {
    blocks.push({ type: ELISE_CONVERSATION_NOTICE_BLOCK_TYPE, code: 'rejected_repeat', tokens: clean(repeats) });
  }
  if (input.commerceHold?.action === 'hold') {
    blocks.push({ type: ELISE_CONVERSATION_NOTICE_BLOCK_TYPE, code: input.commerceHold.code });
  }
  return blocks;
}

/** Re-validate a persisted notice before rendering it. Unknown -> null. */
export function parseEliseConversationNotice(raw: unknown): EliseConversationNoticeBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const block = raw as Record<string, unknown>;
  if (block.type !== ELISE_CONVERSATION_NOTICE_BLOCK_TYPE) return null;
  const codes: readonly string[] = ['constraint_conflict', 'rejected_repeat', 'shopping_held_owned_only', 'shopping_held_not_requested'];
  if (typeof block.code !== 'string' || !codes.includes(block.code)) return null;
  const tokens = Array.isArray(block.tokens)
    ? (block.tokens as unknown[]).filter((t): t is string => typeof t === 'string' && TOKEN_RE.test(t)).slice(0, 3)
    : [];
  if ((block.code === 'constraint_conflict' || block.code === 'rejected_repeat') && !tokens.length) return null;
  return {
    type: ELISE_CONVERSATION_NOTICE_BLOCK_TYPE,
    code: block.code as EliseConversationNoticeCode,
    ...(tokens.length ? { tokens } : {}),
  };
}
