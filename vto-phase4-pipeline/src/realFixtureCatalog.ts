import { join, resolve } from 'node:path';
import type { Phase4ProductInput } from './types';

/** Repo root, resolved relative to this compiled module's location (dist/src/realFixtureCatalog.js -> dist -> package -> repo root). */
export function repoRoot(): string {
  return resolve(__dirname, '..', '..', '..');
}

function baseProduct(overrides: Partial<Phase4ProductInput> & { productRef: string; category: string; images: Phase4ProductInput['images'] }): Phase4ProductInput {
  return {
    retailer: null,
    variantId: null,
    variantAuthoritative: false,
    title: null,
    brand: null,
    evidenceClass: 'AUTHORIZED_FIXTURE',
    ...overrides,
  };
}

/**
 * `assets/qa_fixtures/*.jpg` — real photographs, already committed and
 * already authorized in this exact repository for the scan-identify QA
 * suite (see docs/vto-phase4-corpus-discovery.md §3). Read here only,
 * never modified or copied elsewhere.
 *
 * `bottom_skirt.jpg` is deliberately excluded — see the corpus discovery
 * doc for why.
 */
export function realAuthorizedFixtureProducts(): Phase4ProductInput[] {
  const dir = join(repoRoot(), 'assets', 'qa_fixtures');
  const at = (name: string) => join(dir, name);

  return [
    baseProduct({ productRef: 'qa-fixture-top', category: 'top', title: 'QA fixture: top.jpg (model-worn hoodie)', images: [{ ref: at('top.jpg'), origin: 'local-fixture' }] }),
    baseProduct({ productRef: 'qa-fixture-outerwear', category: 'outerwear', title: 'QA fixture: outerwear.jpg (severe crop editorial)', images: [{ ref: at('outerwear.jpg'), origin: 'local-fixture' }] }),
    baseProduct({ productRef: 'qa-fixture-dress', category: 'dress', title: 'QA fixture: dress.jpg (full-length model)', images: [{ ref: at('dress.jpg'), origin: 'local-fixture' }] }),
    baseProduct({ productRef: 'qa-fixture-bottom-jeans', category: 'bottom', title: 'QA fixture: bottom_jeans.jpg (model-worn)', images: [{ ref: at('bottom_jeans.jpg'), origin: 'local-fixture' }] }),
    baseProduct({ productRef: 'qa-fixture-accessory', category: 'accessory', title: 'QA fixture: accessory.jpg (bag/sunglasses flat-lay, no garment)', images: [{ ref: at('accessory.jpg'), origin: 'local-fixture' }] }),
    baseProduct({ productRef: 'qa-fixture-footwear', category: 'footwear', title: 'QA fixture: footwear.jpg (shoe on foot)', images: [{ ref: at('footwear.jpg'), origin: 'local-fixture' }] }),
    baseProduct({ productRef: 'qa-fixture-non-fashion', category: 'non_fashion', title: 'QA fixture: non_fashion.jpg (coffee mug)', images: [{ ref: at('non_fashion.jpg'), origin: 'local-fixture' }] }),
  ];
}
