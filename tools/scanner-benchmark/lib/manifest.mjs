// Benchmark manifest contract and validator.

export const STRATA = Object.freeze([
  'exact_known',      // a specific purchasable model is identified by the source (category / title)
  'unknown_generic',  // garment with no identifiable exact product
  'logo_visible',     // brand wordmark or logo legible in the image
  'texture_pattern',  // the defining attribute is a pattern or surface texture
  'multi_item',       // more than one garment in frame (mannequins, windows, racks)
  'difficult',        // derived adverse-condition variant of a labelled source case
  'non_fashion',      // control: no fashion item
]);

export const CATEGORIES = Object.freeze(['footwear', 'top', 'outerwear', 'blazer', 'dress', 'pants', 'skirt', 'bag', 'accessory', 'non_fashion']);

// Commons licences admitted (same policy as the Build 4 Tier-A set): no NC, no ND, no unknown.
// Jurisdiction-ported variants ("CC BY-SA 2.5 si") carry the same terms and are admitted.
const LICENCE_OK = /^(cc0|public domain|cc by(-sa)? (2\.0|2\.5|3\.0|4\.0)( [a-z]{2,3})?)$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export function validateManifest(manifest) {
  const errors = [];
  const err = (id, msg) => errors.push(`${id}: ${msg}`);
  if (!manifest || !Array.isArray(manifest.cases)) return ['manifest.cases must be an array'];
  const ids = new Set();
  const byId = new Map(manifest.cases.map((c) => [c.caseId, c]));
  for (const c of manifest.cases) {
    const id = c?.caseId ?? '(missing id)';
    if (!/^b42-[a-z0-9-]+$/.test(c?.caseId ?? '')) err(id, 'caseId must match ^b42-[a-z0-9-]+$');
    if (ids.has(c.caseId)) err(id, 'duplicate caseId');
    ids.add(c.caseId);
    if (!STRATA.includes(c.stratum)) err(id, `unknown stratum ${c.stratum}`);
    if (!['development', 'holdout'].includes(c.split)) err(id, 'split must be development|holdout');
    const L = c.labels ?? {};
    if (!CATEGORIES.includes(L.category)) err(id, `unknown category ${L.category}`);
    if ((L.category === 'non_fashion') !== (L.nonFashion === true)) err(id, 'nonFashion must agree with category');
    if (c.stratum === 'non_fashion' && !L.nonFashion) err(id, 'non_fashion stratum requires nonFashion');
    if (c.stratum === 'exact_known') {
      const ep = L.exactProduct ?? {};
      if (!ep.knowable || !ep.brand || !(ep.modelAliases?.length)) err(id, 'exact_known requires exactProduct {knowable, brand, modelAliases}');
    }
    if (c.stratum === 'logo_visible' && !(L.brand?.visible && L.brand?.name)) err(id, 'logo_visible requires a visible brand');
    if (c.stratum === 'multi_item' && !((L.garments?.length ?? 0) >= 2)) err(id, 'multi_item requires >= 2 labelled garments');
    if (!Array.isArray(c.labelSources) || c.labelSources.length === 0) err(id, 'labelSources required');
    const s = c.source ?? {};
    if (s.kind === 'commons') {
      if (!LICENCE_OK.test(s.licence ?? '')) err(id, `licence not admitted: ${s.licence}`);
      if (!s.author) err(id, 'author required for attribution');
      if (!/^https:\/\/commons\.wikimedia\.org\//.test(s.filePage ?? '')) err(id, 'filePage must be a Commons file page');
      if (!/^https:\/\/upload\.wikimedia\.org\//.test(s.fetchUrl ?? '')) err(id, 'fetchUrl must be an upload.wikimedia.org URL');
      if (!SHA256.test(s.sha256 ?? '')) err(id, 'sha256 required');
    } else if (s.kind === 'derived') {
      const parent = byId.get(s.derivedFrom);
      if (!parent || parent.source?.kind !== 'commons') err(id, 'derivedFrom must name a commons case');
      if (parent && parent.split !== c.split) err(id, 'derived case must share its parent split');
      if (!s.transform) err(id, 'transform required');
    } else {
      err(id, `unknown source kind ${s.kind}`);
    }
  }
  return errors;
}

export function summarizeManifest(manifest) {
  const count = (key) => manifest.cases.reduce((m, c) => ({ ...m, [key(c)]: (m[key(c)] ?? 0) + 1 }), {});
  return {
    cases: manifest.cases.length,
    byStratum: count((c) => c.stratum),
    bySplit: count((c) => c.split),
    byCategory: count((c) => c.labels.category),
    exactProductKnowable: manifest.cases.filter((c) => c.labels.exactProduct?.knowable).length,
    brandVisible: manifest.cases.filter((c) => c.labels.brand?.visible).length,
  };
}
