// Deterministic, title-based offer judges for benchmark scoring.
//
// LIMITATION (reported with every metric that uses these judges): an offer is
// judged from its title, brand field and destination only. No product image is
// compared. "Exact product" therefore means "the listing names the labelled
// brand and a complete labelled model phrase"; it does not prove the
// colourway or that the listing photo shows the same item.

export const norm = (value) =>
  typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
const hasPhrase = (hay, needle) => !!norm(needle) && ` ${norm(hay)} `.includes(` ${norm(needle)} `);
const singular = (t) => t.replace(/(es|s)$/, '');

/** Category vocabularies used to grade alternatives. Keys match manifest `labels.category`. */
export const CATEGORY_TERMS = Object.freeze({
  footwear: ['shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'boot', 'boots', 'sandal', 'sandals', 'clog', 'clogs', 'loafer', 'loafers', 'heel', 'heels', 'pump', 'pumps', 'slipper', 'slippers', 'footwear', 'mule', 'mules', 'flats'],
  top: ['top', 'shirt', 'shirts', 't shirt', 'tee', 'polo', 'blouse', 'sweater', 'jumper', 'hoodie', 'sweatshirt', 'cardigan', 'pullover', 'knit', 'tank', 'jersey'],
  outerwear: ['jacket', 'coat', 'parka', 'anorak', 'raincoat', 'trench', 'puffer', 'windbreaker', 'gilet', 'vest', 'outerwear', 'duffle', 'duffel', 'peacoat', 'bomber'],
  blazer: ['blazer', 'suit jacket', 'sport coat'],
  dress: ['dress', 'gown', 'sundress'],
  pants: ['jeans', 'pants', 'trousers', 'chinos', 'shorts', 'leggings', 'joggers', 'denim'],
  skirt: ['skirt', 'kilt'],
  bag: ['bag', 'handbag', 'backpack', 'tote', 'purse', 'satchel', 'clutch', 'crossbody', 'rucksack', 'duffel', 'shoulder bag'],
  accessory: ['watch', 'sunglasses', 'glasses', 'scarf', 'hat', 'cap', 'beanie', 'tie', 'necktie', 'belt', 'gloves', 'shawl'],
});

function categoryHit(title, category) {
  const terms = CATEGORY_TERMS[category] ?? [];
  return terms.some((t) => hasPhrase(title, t) || (t.length > 3 && hasPhrase(title, singular(t))));
}

/**
 * Exact-product judge.
 *   exact_product — brand agrees and a complete model alias is in the title
 *   same_brand    — brand agrees, model not established
 *   other         — brand absent or different
 * Brand agreement: provider brand field equals a brand alias, else a brand alias is a whole phrase in the title.
 */
export function judgeExactProduct(offer, exactProduct) {
  if (!exactProduct || !exactProduct.knowable) return 'not_applicable';
  const brandAliases = [exactProduct.brand, ...(exactProduct.brandAliases ?? [])].filter(Boolean);
  const title = offer.title ?? '';
  const normalizedTitle = norm(title);
  const declared = norm(offer.brand);
  const brandAgrees = declared
    ? brandAliases.some((b) => norm(b) === declared)
    : brandAliases.some((b) => hasPhrase(title, b));
  if (!brandAgrees) return 'other';
  if (/\b(inspired|replicas?|dupes?|fake|knock ?off|alternative to|look ?alike|compatible with|fits|replacement|socks?|laces?|insoles?|straps?|bands?|cases?|cleaners?)\b/.test(normalizedTitle)) return 'same_brand';
  const modelMatch = [exactProduct.model, ...(exactProduct.modelAliases ?? [])]
    .some((alias) => hasPhrase(normalizedTitle, alias));
  return modelMatch ? 'exact_product' : 'same_brand';
}

/**
 * Alternative relevance grade, 0..3, from title text only.
 *   3 category + subtype + primary colour
 *   2 category + subtype (or category + colour when the label has no subtype terms)
 *   1 category only
 *   0 category absent or a reject term present
 */
export function gradeAlternative(offer, labels) {
  const title = offer.title ?? '';
  if ((labels.rejectTerms ?? []).some((t) => hasPhrase(title, t))) return 0;
  if (!categoryHit(title, labels.category) && !(labels.subtypeTerms ?? []).some((t) => hasPhrase(title, t))) return 0;
  const subtype = (labels.subtypeTerms ?? []).some((t) => hasPhrase(title, t) || hasPhrase(title, singular(norm(t))));
  const color = (labels.colorTerms ?? []).some((t) => hasPhrase(title, t));
  if ((labels.subtypeTerms ?? []).length === 0) return color ? 2 : 1;
  if (subtype && color) return 3;
  if (subtype) return 2;
  return 1;
}

/** Brand assertion check for identification results (unsupported brand claim). */
export function brandClaimSupported(claimedBrand, labels) {
  if (!claimedBrand) return true;
  if (!labels.brand || !labels.brand.visible) return false;
  return [labels.brand.name, ...(labels.brand.aliases ?? [])].some((b) => norm(b) === norm(claimedBrand));
}

export function categoryCorrect(predicted, labels) {
  if (!predicted) return false;
  const p = norm(predicted);
  if (p === norm(labels.category)) return true;
  return (labels.categoryAliases ?? []).some((a) => norm(a) === p) || categoryHit(predicted, labels.category);
}
