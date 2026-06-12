// Dev-only helpers for sneaker enrichment testing.
// This file is guarded by __DEV__ — do NOT import from production code paths.

import { searchKicksCrewRapidApi } from './providers/kickscrewRapidApi';

const KC_TEST_URL =
  'https://www.kickscrew.com/en-PT/products/nike-ja-3-mink-brown-hf2793-200';

export async function testKicksCrewIntegration(): Promise<void> {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;

  const cases: Array<{ label: string; url: string | null }> = [
    { label: 'valid KicksCrew URL',             url: KC_TEST_URL },
    { label: 'non-kickscrew URL (expect [])',    url: 'https://stockx.com/nike-dunk-low' },
    { label: 'null productUrl (expect [])',      url: null },
  ];

  console.log('[sneakers/kickscrew-test] ── Starting KicksCrew integration tests ──');
  for (const { label, url } of cases) {
    try {
      const start   = Date.now();
      const results = await searchKicksCrewRapidApi(url);
      const ms      = Date.now() - start;
      console.log(
        `[sneakers/kickscrew-test] "${label}" — ${results.length} result(s) in ${ms}ms`,
        results.map(r => `${r.source}: ${r.name} [sku=${r.sku ?? 'none'}] img=${!!r.imageUrl}`),
      );
    } catch (err: any) {
      console.error(`[sneakers/kickscrew-test] "${label}" — THREW: ${err?.message}`);
    }
  }
  console.log('[sneakers/kickscrew-test] ── Done ──');
}
