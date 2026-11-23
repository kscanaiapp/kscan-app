/**
 * Listing brand identity for Scanner identity-aware ranking (B42-SCAN-02).
 *
 * Pure, local, deterministic. Answers one question about a provider listing:
 * does it name the brand the Scanner observed, a different brand, or neither?
 *
 * Evidence rules:
 *   - A provider-declared brand field wins over the title.
 *   - Without one, the title is read for whole-phrase brand names. A brand from
 *     the closed lexicon below that belongs to another brand family is a
 *     contradiction; a brand from the scanned family is agreement.
 *   - Ambiguous names that are also ordinary words or colours ("Coach",
 *     "Guess", "Gap", "Polo", "Hunter") are never read from a title as a
 *     contradiction. They can still agree, because agreement is only ever
 *     checked against the brand the Scanner itself observed.
 *   - A title naming BOTH the scanned brand and another lexicon brand is
 *     'unknown' (comparison listings, "X vs Y", marketplace bundles).
 *
 * Retailer neutrality: `source`, `retailer`, `merchant` and the destination
 * host are never read. A store called "Nike" selling adidas is judged by the
 * listing, not the store.
 */

export type ListingBrandVerdict = 'agrees' | 'contradicts' | 'unknown';

type BrandFamily = {
  id: string;
  /** Whole phrases (normalized) that name this family. */
  names: readonly string[];
  /** Subset of `names` too ambiguous to assert a contradiction from a title. */
  ambiguous?: readonly string[];
};

/**
 * Closed lexicon. Sub-brands and common spellings share a family so that
 * "adidas Originals", "Air Jordan" (Nike) or "YSL" (Saint Laurent) never read
 * as a different brand from their parent.
 */
const BRAND_FAMILIES: readonly BrandFamily[] = Object.freeze([
  { id: 'adidas', names: ['adidas', 'adidas originals', 'adidas performance', 'yeezy'] },
  { id: 'nike', names: ['nike', 'nike sportswear', 'air jordan', 'jordan', 'jordan brand', 'nike sb'], ambiguous: ['jordan'] },
  { id: 'converse', names: ['converse'] },
  { id: 'new balance', names: ['new balance'] },
  { id: 'puma', names: ['puma'] },
  { id: 'reebok', names: ['reebok'] },
  { id: 'asics', names: ['asics', 'onitsuka tiger'] },
  { id: 'vans', names: ['vans'] },
  { id: 'fila', names: ['fila'] },
  { id: 'saucony', names: ['saucony'] },
  { id: 'hoka', names: ['hoka', 'hoka one one'] },
  { id: 'salomon', names: ['salomon'] },
  { id: 'skechers', names: ['skechers'] },
  { id: 'crocs', names: ['crocs'] },
  { id: 'birkenstock', names: ['birkenstock'] },
  { id: 'dr martens', names: ['dr martens', 'doc martens', 'dr marten'] },
  { id: 'timberland', names: ['timberland'] },
  { id: 'ugg', names: ['ugg'] },
  { id: 'clarks', names: ['clarks'] },
  { id: 'veja', names: ['veja'] },
  { id: 'casio', names: ['casio', 'g shock'] },
  { id: 'seiko', names: ['seiko'] },
  { id: 'timex', names: ['timex'] },
  { id: 'rolex', names: ['rolex'] },
  { id: 'tudor', names: ['tudor'] },
  { id: 'omega', names: ['omega'], ambiguous: ['omega'] },
  { id: 'citizen', names: ['citizen'], ambiguous: ['citizen'] },
  { id: 'ray ban', names: ['ray ban', 'rayban'] },
  { id: 'oakley', names: ['oakley'] },
  { id: 'persol', names: ['persol'] },
  { id: 'fjallraven', names: ['fjallraven'] },
  { id: 'herschel', names: ['herschel'] },
  { id: 'jansport', names: ['jansport'] },
  { id: 'eastpak', names: ['eastpak'] },
  { id: 'longchamp', names: ['longchamp'] },
  { id: 'coach', names: ['coach'], ambiguous: ['coach'] },
  { id: 'michael kors', names: ['michael kors'] },
  { id: 'kate spade', names: ['kate spade'] },
  { id: 'tory burch', names: ['tory burch'] },
  { id: 'louis vuitton', names: ['louis vuitton'] },
  { id: 'gucci', names: ['gucci'] },
  { id: 'prada', names: ['prada'] },
  { id: 'miu miu', names: ['miu miu'] },
  { id: 'chanel', names: ['chanel'] },
  { id: 'hermes', names: ['hermes'] },
  { id: 'dior', names: ['dior', 'christian dior'] },
  { id: 'fendi', names: ['fendi'] },
  { id: 'balenciaga', names: ['balenciaga'] },
  { id: 'saint laurent', names: ['saint laurent', 'yves saint laurent', 'ysl'] },
  { id: 'bottega veneta', names: ['bottega veneta'] },
  { id: 'burberry', names: ['burberry'] },
  { id: 'versace', names: ['versace'] },
  { id: 'givenchy', names: ['givenchy'] },
  { id: 'valentino', names: ['valentino'] },
  { id: 'celine', names: ['celine'] },
  { id: 'loewe', names: ['loewe'] },
  { id: 'moncler', names: ['moncler'] },
  { id: 'canada goose', names: ['canada goose'] },
  { id: 'the north face', names: ['the north face', 'north face'] },
  { id: 'patagonia', names: ['patagonia'] },
  { id: 'arcteryx', names: ['arcteryx', 'arc teryx'] },
  { id: 'columbia', names: ['columbia'], ambiguous: ['columbia'] },
  { id: 'carhartt', names: ['carhartt'] },
  { id: 'levis', names: ['levis', 'levi s', 'levi strauss'] },
  { id: 'wrangler', names: ['wrangler'] },
  { id: 'ralph lauren', names: ['ralph lauren', 'polo ralph lauren', 'polo'], ambiguous: ['polo'] },
  { id: 'tommy hilfiger', names: ['tommy hilfiger'] },
  { id: 'calvin klein', names: ['calvin klein'] },
  { id: 'hugo boss', names: ['hugo boss', 'boss'], ambiguous: ['boss'] },
  { id: 'lacoste', names: ['lacoste'] },
  { id: 'champion', names: ['champion'], ambiguous: ['champion'] },
  { id: 'supreme', names: ['supreme'], ambiguous: ['supreme'] },
  { id: 'stussy', names: ['stussy'] },
  { id: 'uniqlo', names: ['uniqlo'] },
  { id: 'zara', names: ['zara'] },
  { id: 'h m', names: ['h m'] },
  { id: 'gap', names: ['gap'], ambiguous: ['gap'] },
  { id: 'guess', names: ['guess'], ambiguous: ['guess'] },
  { id: 'hunter', names: ['hunter'], ambiguous: ['hunter'] },
  { id: 'mango', names: ['mango'], ambiguous: ['mango'] },
  { id: 'diesel', names: ['diesel'], ambiguous: ['diesel'] },
  { id: 'lee', names: ['lee'], ambiguous: ['lee'] },
]);

/** Lower-case, accent-free, punctuation collapsed to single spaces. */
export function brandKey(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

function hasPhrase(haystackKey: string, needleKey: string): boolean {
  return !!needleKey && ` ${haystackKey} `.includes(` ${needleKey} `);
}

/** The lexicon family a brand phrase belongs to, or null when it is not in the lexicon. */
export function brandFamilyOf(brand: unknown): string | null {
  const k = brandKey(brand);
  if (!k) return null;
  for (const family of BRAND_FAMILIES) {
    if (family.names.includes(k)) return family.id;
  }
  // "adidas Originals Stan Smith" as a declared brand: the leading family phrase decides.
  for (const family of BRAND_FAMILIES) {
    if (family.names.some((name) => !(family.ambiguous ?? []).includes(name) && k.startsWith(`${name} `))) return family.id;
  }
  return null;
}

/** Every phrase that names the scanned brand: its own key plus its lexicon family. */
function scannedBrandPhrases(scannedBrand: string): string[] {
  const own = brandKey(scannedBrand);
  const familyId = brandFamilyOf(scannedBrand);
  const family = familyId ? BRAND_FAMILIES.find((f) => f.id === familyId) : undefined;
  return [...new Set([own, ...(family?.names ?? [])].filter(Boolean))];
}

/** Two brand strings name the same brand (identical, same family, or one is a leading sub-brand phrase of the other). */
export function brandsAgree(a: unknown, b: unknown): boolean {
  const ka = brandKey(a);
  const kb = brandKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const fa = brandFamilyOf(ka);
  const fb = brandFamilyOf(kb);
  if (fa && fb) return fa === fb;
  return ka.startsWith(`${kb} `) || kb.startsWith(`${ka} `);
}

/** Lexicon families (other than `exceptFamily`) named unambiguously in a title. */
export function otherBrandFamiliesInTitle(title: unknown, exceptFamily: string | null, exceptPhrases: readonly string[] = []): string[] {
  const t = brandKey(title);
  if (!t) return [];
  const found: string[] = [];
  for (const family of BRAND_FAMILIES) {
    if (family.id === exceptFamily) continue;
    const unambiguous = family.names.filter((name) => !(family.ambiguous ?? []).includes(name));
    // A phrase that is part of the scanned brand's own name is not another brand.
    if (unambiguous.some((name) => hasPhrase(t, name) && !exceptPhrases.some((p) => hasPhrase(p, name)))) {
      found.push(family.id);
    }
  }
  return found;
}

/**
 * Brand verdict for one listing against the Scanner-observed brand.
 * `scannedBrand` must already be the verified (wordmark / high-confidence logo)
 * brand; callers never pass a model hypothesis or an unverified guess here.
 */
export function listingBrandVerdict(
  listing: { title?: unknown; brand?: unknown },
  scannedBrand: string,
): ListingBrandVerdict {
  const scanned = brandKey(scannedBrand);
  if (!scanned) return 'unknown';
  const declared = brandKey(listing.brand);
  if (declared) return brandsAgree(declared, scanned) ? 'agrees' : 'contradicts';

  const title = brandKey(listing.title);
  if (!title) return 'unknown';
  const phrases = scannedBrandPhrases(scanned);
  const namesScanned = phrases.some((phrase) => hasPhrase(title, phrase));
  const others = otherBrandFamiliesInTitle(title, brandFamilyOf(scanned), phrases);
  if (namesScanned) return others.length === 0 ? 'agrees' : 'unknown';
  return others.length > 0 ? 'contradicts' : 'unknown';
}
