#!/usr/bin/env node
/**
 * Explicit-attribute ranking fixtures (continuation brief section 13).
 *
 * NINE committed fixtures in three tiers, each with a FIXED candidate universe
 * and a FIXED identification, so a before/after ordering claim is checkable
 * rather than anecdotal. The ordinary and strong tiers deliberately SHARE their
 * universes and identifications: the only difference between F01 and F04 is how
 * strongly the customer asked, which is the whole point of the mechanism.
 *
 * WHY THE IDENTIFICATION IS RICH. These fixtures exercise the RANKER, which is
 * shared with Scanner. A Scanner identification carries material, silhouette and
 * pattern, so candidates can differ on secondary fashion attributes -- which is
 * the only way to ask whether a preferred colour is elevating a genuinely weaker
 * option past a genuinely better one. An Elise-only identification (category and
 * subtype) makes every candidate agree except on colour, and no such question
 * can be posed. The end-to-end Elise path is covered by the journey suite.
 *
 * PROVIDER ORDER IS MODELLED, NOT IDEALISED. The owner's observation is that
 * matching products "tend to be lower on the list in commerce returns", so the
 * preferred candidate is placed LATE in every universe. A fixture whose
 * preferred item already arrives first cannot demonstrate elevation.
 *
 * NOTE ON `primary_color`: the identifications here describe the GARMENT, and
 * never carry the customer's requested colour. A requested colour is a
 * preference and is scored once, on the contextual axis, with provenance and
 * strength attached.
 */
'use strict';

const p = (id, title, price, o = {}) => ({
  id,
  title,
  price,
  currency: o.currency === null ? undefined : (o.currency ?? 'USD'),
  type: o.type ?? 'retail',
  source: o.source ?? 'Farfetch',
  ...(o.noImage ? {} : { imageUrl: `https://img.cdn.io/${id}.jpg` }),
  productUrl: o.productUrl ?? `https://www.${String(o.source ?? 'Farfetch').toLowerCase()}.com/p/${id}`,
});

/** A Scanner-grade boot identification. No colour: colour is the preference. */
const ID_BOOT = {
  item_type: 'footwear',
  subtype: 'chelsea boot',
  material_estimate: 'leather',
  silhouette: 'ankle',
  pattern: 'solid',
};

const ID_JACKET = {
  item_type: 'outerwear',
  subtype: 'field jacket',
  material_estimate: 'cotton',
  silhouette: 'relaxed',
  pattern: 'solid',
};

const ID_DRESS = {
  item_type: 'dress',
  subtype: 'shift dress',
  material_estimate: 'cotton',
  silhouette: 'shift',
  pattern: 'solid',
};

// ── Tier 1 + 2 universes (shared between the ordinary and strong requests) ──

/**
 * Three strong non-black alternatives, one genuinely WEAKER black arrival last.
 *
 * The black option is genuinely weaker on SECONDARY FASHION ATTRIBUTES: right
 * category, but a silhouette and material that do not match the garment. It is
 * fully real and fully buyable -- photograph, valid retailer URL, real price --
 * so nothing about its commercial quality is in question. This is the candidate
 * set section 13 asks for, and the question it poses is the honest one: how far
 * should a weaker option rise because the customer named its colour?
 *
 * It must stay above the shape filters. A candidate with no photograph is
 * removed by an existing Stage A rule (`missing_image`) long before ranking, so
 * a missing image cannot be used to model "weaker" -- it models "rejected".
 */
const U_BLACK_WEAK_LAST = [
  p('u1_brown_chelsea', 'Brown Leather Chelsea Ankle Boot Solid', '$180.00', { source: 'Farfetch' }),
  p('u1_tan_chelsea', 'Tan Leather Chelsea Ankle Boot Solid', '$170.00', { source: 'KicksCrew' }),
  p('u1_burgundy_chelsea', 'Burgundy Leather Chelsea Ankle Boot Solid', '$160.00', { source: 'Poshmark' }),
  p('u1_black_weaker', 'Black Woven Espadrille', '$62.00', { source: 'Serper' }),
];

/** Red is the preferred colour, arrives last, and is the weaker listing. */
const U_RED_WEAK_LAST = [
  p('u2_navy_field', 'Navy Cotton Field Jacket Relaxed Solid', '$320.00', { source: 'Farfetch' }),
  p('u2_olive_field', 'Olive Cotton Field Jacket Relaxed Solid', '$240.00', { source: 'KicksCrew' }),
  p('u2_grey_field', 'Grey Cotton Field Jacket Relaxed Solid', '$275.00', { source: 'Poshmark' }),
  p('u2_red_weaker', 'Red Nylon Cropped Puffer', '$95.00', { source: 'Serper' }),
];

/** Navy is the preferred colour, arrives last, and is the weaker listing. */
const U_NAVY_WEAK_LAST = [
  p('u3_ivory_shift', 'Ivory Cotton Shift Dress Solid', '$230.00', { source: 'Farfetch' }),
  p('u3_green_shift', 'Green Cotton Shift Dress Solid', '$210.00', { source: 'KicksCrew' }),
  p('u3_black_shift', 'Black Cotton Shift Dress Solid', '$260.00', { source: 'Poshmark' }),
  p('u3_navy_weaker', 'Navy Linen Tiered Maxi Dress', '$120.00', { source: 'Serper' }),
];

// ── Tier 3 universes (sparse / competing quality) ──────────────────────────

/** Exactly ONE viable black candidate, last, against three strong alternatives. */
const U_SPARSE_ONE_BLACK = [
  p('u4_brown_chelsea', 'Brown Leather Chelsea Ankle Boot Solid', '$210.00', { source: 'Farfetch' }),
  p('u4_tan_chelsea', 'Tan Leather Chelsea Ankle Boot Solid', '$195.00', { source: 'KicksCrew' }),
  p('u4_cream_chelsea', 'Cream Leather Chelsea Ankle Boot Solid', '$175.00', { source: 'Poshmark' }),
  p('u4_black_chelsea', 'Black Leather Chelsea Ankle Boot Solid', '$130.00', { source: 'Serper' }),
];

/**
 * QUALITY FLOOR (section 14). Two black arrivals: an aggregator "see similar"
 * link with no price and no purchase path, and a real buyable boot behind it.
 * Matching the requested colour must not be able to buy the unusable one the
 * top slot -- and it must not be removed either, only ordered honestly.
 */
const U_BLACK_UNUSABLE_FIRST = [
  p('u5_brown_chelsea', 'Brown Leather Chelsea Ankle Boot Solid', '$180.00', { source: 'Farfetch' }),
  p('u5_tan_chelsea', 'Tan Leather Chelsea Ankle Boot Solid', '$165.00', { source: 'KicksCrew' }),
  p('u5_black_unusable', 'Black Leather Chelsea Ankle Boot Solid - See Similar Items', '', {
    type: 'similar',
    currency: null,
    productUrl: 'https://www.google.com/search?q=black+chelsea+boot',
    source: 'Serper',
  }),
  p('u5_black_good', 'Black Leather Chelsea Ankle Boot Solid', '$185.00', { source: 'Poshmark' }),
];

/** No black candidate exists at all. A preference cannot invent one. */
const U_NO_BLACK = [
  p('u6_brown_chelsea', 'Brown Leather Chelsea Ankle Boot Solid', '$180.00', { source: 'Farfetch' }),
  p('u6_tan_chelsea', 'Tan Leather Chelsea Ankle Boot Solid', '$165.00', { source: 'KicksCrew' }),
  p('u6_burgundy_chelsea', 'Burgundy Leather Chelsea Ankle Boot Solid', '$150.00', { source: 'Poshmark' }),
];

/**
 * The nine fixtures.
 *
 * `contribution` is the context contribution the client assembles, exactly as
 * `parseContextContributions` receives it over the wire. `colorStrength` is
 * absent in the ordinary tier on purpose: absence must degrade to ordinary
 * explicit preference, never to "no preference" and never to "strong".
 */
const FIXTURES = [
  // ── Tier 1: ordinary explicit preference ─────────────────────────────────
  {
    id: 'F01_ordinary_black_boot',
    tier: 'ordinary',
    message: 'Show me black boots.',
    identification: ID_BOOT,
    contribution: { provenance: 'USER_EXPLICIT', color: 'black' },
    universe: U_BLACK_WEAK_LAST,
  },
  {
    id: 'F02_ordinary_red_jacket',
    tier: 'ordinary',
    message: "I'd prefer a red jacket.",
    identification: ID_JACKET,
    contribution: { provenance: 'USER_EXPLICIT', color: 'red' },
    universe: U_RED_WEAK_LAST,
  },
  {
    id: 'F03_ordinary_navy_dress',
    tier: 'ordinary',
    message: 'A navy dress if possible.',
    identification: ID_DRESS,
    contribution: { provenance: 'USER_EXPLICIT', color: 'navy' },
    universe: U_NAVY_WEAK_LAST,
  },

  // ── Tier 2: strong explicit preference (same universes as tier 1) ────────
  {
    id: 'F04_strong_only_black',
    tier: 'strong',
    message: 'Only black.',
    identification: ID_BOOT,
    contribution: { provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    universe: U_BLACK_WEAK_LAST,
    pairedWith: 'F01_ordinary_black_boot',
  },
  {
    id: 'F05_strong_really_want_red',
    tier: 'strong',
    message: 'I really want red.',
    identification: ID_JACKET,
    contribution: { provenance: 'USER_EXPLICIT', color: 'red', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    universe: U_RED_WEAK_LAST,
    pairedWith: 'F02_ordinary_red_jacket',
  },
  {
    id: 'F06_strong_navy_important',
    tier: 'strong',
    message: 'Navy is important to me.',
    identification: ID_DRESS,
    contribution: { provenance: 'USER_EXPLICIT', color: 'navy', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    universe: U_NAVY_WEAK_LAST,
    pairedWith: 'F03_ordinary_navy_dress',
  },

  // ── Tier 3: sparse / competing quality ───────────────────────────────────
  {
    id: 'F07_sparse_single_black',
    tier: 'sparse',
    message: 'Only black please.',
    identification: ID_BOOT,
    contribution: { provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    universe: U_SPARSE_ONE_BLACK,
  },
  {
    id: 'F08_quality_floor_black_unusable',
    tier: 'sparse',
    message: 'Only black.',
    identification: ID_BOOT,
    contribution: { provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    universe: U_BLACK_UNUSABLE_FIRST,
  },
  {
    id: 'F09_no_black_candidate',
    tier: 'sparse',
    message: 'I really want black.',
    identification: ID_BOOT,
    contribution: { provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    universe: U_NO_BLACK,
  },
];

module.exports = {
  FIXTURES,
  ID_BOOT,
  ID_JACKET,
  ID_DRESS,
  U_BLACK_WEAK_LAST,
  U_RED_WEAK_LAST,
  U_NAVY_WEAK_LAST,
  U_SPARSE_ONE_BLACK,
  U_BLACK_UNUSABLE_FIRST,
  U_NO_BLACK,
};
