// Dev-only helper for Nike Shoe Details integration testing.
// This file is guarded by __DEV__ — do NOT import from production code paths.

import { fetchNikeShoeDetails, normalizeNikeResult } from './nikeShoeDetails';

const TEST_URL =
  'https://www.nike.com/t/air-jordan-3-retro-medium-olive-mens-shoes-bPRc5V/DN3707-202';

export async function testNikeShoeDetails(): Promise<void> {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;

  console.log('[nikeShoeDetails-test] ── Starting Nike Shoe Details integration test ──');
  console.log('[nikeShoeDetails-test] URL:', TEST_URL);

  const start = Date.now();

  try {
    // Invoke via Edge Function — returns raw payload forwarded from RapidAPI
    const { supabase } = await import('./supabaseClient');
    const { data, error } = await supabase.functions.invoke('nike-shoe-details', {
      body: { product_url: TEST_URL },
    });

    const ms = Date.now() - start;

    if (error) {
      console.error('[nikeShoeDetails-test] invoke error:', error?.message, ms, 'ms');
      return;
    }

    if (!data || typeof data !== 'object') {
      console.warn('[nikeShoeDetails-test] no data returned', ms, 'ms');
      return;
    }

    // ── Step 1: Dump raw payload so we can inspect actual field paths ──────────
    console.log('[nikeShoeDetails-test] RAW PAYLOAD ↓', ms, 'ms');
    console.log(JSON.stringify(data, null, 2));

    // ── Step 2: Detected field paths ─────────────────────────────────────────
    const raw = data as Record<string, unknown>;
    console.log('[nikeShoeDetails-test] DETECTED TOP-LEVEL KEYS:', Object.keys(raw).join(', '));

    if (raw.product && typeof raw.product === 'object') {
      console.log(
        '[nikeShoeDetails-test] DETECTED product.* KEYS:',
        Object.keys(raw.product as object).join(', '),
      );
    }

    // ── Step 3: Normalized result ─────────────────────────────────────────────
    const normalized = normalizeNikeResult(TEST_URL, raw);
    console.log('[nikeShoeDetails-test] NORMALIZED RESULT ↓');
    console.log({
      source:       normalized.source,
      title:        normalized.title,
      subtitle:     normalized.subtitle,
      price:        normalized.price,
      currency:     normalized.currency,
      styleCode:    normalized.styleCode,
      colorway:     normalized.colorway,
      imageUrl:     normalized.imageUrl ? '(present)' : null,
      description:  normalized.description ? normalized.description.slice(0, 80) + '…' : null,
      sizes:        normalized.sizes,
      availability: normalized.availability,
    });

    // ── Step 4: Full client function round-trip ───────────────────────────────
    const result = await fetchNikeShoeDetails({ product_url: TEST_URL });
    console.log(
      '[nikeShoeDetails-test] fetchNikeShoeDetails() →',
      result ? `OK (title="${result.title}", price=${result.price})` : 'null',
    );

  } catch (err: any) {
    console.error('[nikeShoeDetails-test] THREW:', err?.message);
  }

  console.log('[nikeShoeDetails-test] ── Done ──');
}
