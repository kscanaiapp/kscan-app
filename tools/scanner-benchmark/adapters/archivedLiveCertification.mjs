// Adapter: archived Build 35 scanner-live-certification report (+ its corpus)
// -> benchmark { cases, results } so archived Staging evidence can be scored by
// the same metrics as the Build 42 benchmark.
//
// Provenance caveat carried into every derived case: the eight repo QA
// fixtures are `excluded_pending_provenance` for evaluation manifests. Results
// computed here are a descriptive baseline of archived evidence, not a
// benchmark result.

const CATEGORY_FROM_ANY = [
  ['outerwear', ['outerwear', 'jacket', 'coat']],
  ['dress', ['dress', 'gown']],
  ['footwear', ['footwear', 'sneaker', 'sneakers', 'shoe', 'shoes', 'boot']],
  ['bag', ['bag', 'bags', 'handbag', 'satchel', 'backpack']],
  ['pants', ['pants', 'jeans', 'bottoms', 'trousers', 'denim']],
  ['accessory', ['eyewear', 'sunglasses', 'accessory', 'accessories']],
  ['top', ['top', 'tops', 'hoodie', 'sweatshirt', 'shirt', 't-shirt', 'tee', 'sweater']],
];

function canonicalCategory(anyList) {
  const set = new Set((anyList ?? []).map((s) => String(s).toLowerCase()));
  for (const [cat, keys] of CATEGORY_FROM_ANY) if (keys.some((k) => set.has(k))) return cat;
  return 'unknown';
}

export function adaptArchivedReport(report, corpus, { runLabel } = {}) {
  const garmentLabels = new Map();
  for (const image of corpus.images ?? []) {
    for (const g of image.expectedGarments ?? []) {
      garmentLabels.set(`${image.id}:${g.key}`, {
        nonFashion: false,
        category: canonicalCategory(g.categoryAny),
        categoryAliases: g.categoryAny ?? [],
        subtypeTerms: g.subtypeAny ?? [],
        colorTerms: g.colorAny ?? [],
        rejectTerms: g.offerTitleReject ?? [],
        brand: g.brandGrounded?.length ? { visible: true, name: g.brandGrounded[0], aliases: g.brandGrounded } : { visible: false, name: null },
        exactProduct: { knowable: false },
      });
    }
    if ((image.expectedGarments ?? []).length === 0) {
      garmentLabels.set(`${image.id}:__non_fashion__`, { nonFashion: true, category: 'non_fashion', exactProduct: { knowable: false } });
    }
  }

  const cases = [];
  const results = [];
  for (const res of report.results ?? []) {
    const detMs = res.detection?.perPhoto?.[0]?.latencyMs;
    for (const item of res.items ?? []) {
      if (!item.boundGarmentKey) continue; // detected candidate with no ground-truth garment
      const caseId = `archived:${item.imageId}:${item.boundGarmentKey}`;
      const labels = garmentLabels.get(`${item.imageId}:${item.boundGarmentKey}`);
      if (!labels) continue;
      cases.push({ caseId, stratum: `legacy_fixture_${item.imageId}`, labels, provenance: 'excluded_pending_provenance' });
      const id = item.selected?.response?.identification ?? {};
      results.push({
        caseId,
        run: runLabel ?? report.phase,
        identification: {
          status: item.selected?.response?.status === 'completed' ? 'completed' : item.selected?.response?.status ?? 'failed',
          category: id.item_type ?? null,
          subtype: id.subtype ?? null,
          brand: { value: id.brand_guess ?? id.visible_brand_text ?? null },
        },
        offers: (Array.isArray(item.offers) ? item.offers : []).map((o) => ({
          rank: o.rank, title: o.title, brand: o.brand ?? null, destination: o.destination, provider: o.provider ?? null,
          ...(o.matchMetadata ? { matchMetadata: o.matchMetadata } : {}),
          ...(o.matchConfidence ? { matchConfidence: o.matchConfidence } : {}),
        })),
        timings: { detectionMs: typeof detMs === 'number' ? detMs : null, selectedMs: item.selected?.latencyMs ?? null, commerceMs: item.commerce?.latencyMs ?? null },
        commerceAttempted: !!item.commerce,
      });
    }
    // Non-fashion photos produce no items; score their detection status directly.
    for (const photo of res.detection?.perPhoto ?? []) {
      const key = `${photo.imageId}:__non_fashion__`;
      if (!garmentLabels.has(key)) continue;
      const caseId = `archived:${key}`;
      cases.push({ caseId, stratum: `legacy_fixture_${photo.imageId}`, labels: garmentLabels.get(key), provenance: 'excluded_pending_provenance' });
      results.push({ caseId, run: runLabel ?? report.phase, identification: { status: photo.responseStatus === 'non_fashion' || photo.detectionScore?.nonFashion ? 'non_fashion' : photo.responseStatus ?? 'unknown' }, offers: [], timings: {}, commerceAttempted: false });
    }
  }
  return { cases, results };
}
