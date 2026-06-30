#!/usr/bin/env node
/**
 * Terminal smoke test for the scan-identify Edge Function.
 *
 * Run after providing a valid staging user JWT:
 *   STAGING_USER_JWT=eyJ... node scripts/smoke-scan-identify.js
 *
 * Does NOT use a service-role key or fabricated JWTs.
 * Does NOT print token values.
 * Prints only safe metadata from the response.
 *
 * Exit codes:
 *   0  — function live and response contract validated
 *   1  — auth token missing (by design — needs human setup)
 *   2  — HTTP or response contract error
 */

'use strict';

const DEFAULT_URL = 'https://wyyuqfdxucjksghsmhry.supabase.co';
const ENDPOINT_PATH = '/functions/v1/scan-identify';
const TIMEOUT_MS = 4000;

const token = process.env.STAGING_USER_JWT;
const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || DEFAULT_URL).replace(/\/$/, '');

if (!token) {
  console.log('SMOKE_TEST_REQUIRES_AUTH_TOKEN');
  console.log('');
  console.log('To run the authenticated smoke test:');
  console.log('  STAGING_USER_JWT=<valid-staging-user-jwt> node scripts/smoke-scan-identify.js');
  console.log('');
  console.log('The JWT must be from a signed-in staging user session — not a service-role key.');
  console.log('Obtain it from the running app (Metro logs, dev tools, or auth session inspector).');
  process.exit(1);
}

const url = supabaseUrl + ENDPOINT_PATH;

// text mode payload — supported by scan-identify (index.ts mode === 'text' branch).
const payload = {
  mode: 'text',
  textQuery: 'black tailored jacket',
};

console.log('[smoke] scan-identify smoke test starting');
console.log('[smoke] url:', url);
console.log('[smoke] mode: text / textQuery: black tailored jacket');
console.log('[smoke] timeout:', TIMEOUT_MS + 'ms');
console.log('[smoke] token: [REDACTED — not printed]');
console.log('');

const controller = new AbortController();
const timer = setTimeout(() => {
  controller.abort();
}, TIMEOUT_MS);

(async () => {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      console.error('[smoke] FAIL — request timed out after ' + TIMEOUT_MS + 'ms');
    } else {
      console.error('[smoke] FAIL — fetch error:', err && err.message ? err.message : String(err));
    }
    process.exit(2);
  }
  clearTimeout(timer);

  console.log('[smoke] HTTP status:', res.status);

  if (!res.ok) {
    const hint = res.status === 401
      ? ' (401 = token invalid/expired or no Authorization header)'
      : res.status === 403
      ? ' (403 = JWT valid but user not authorized)'
      : '';
    console.error('[smoke] FAIL — non-2xx HTTP status:' + res.status + hint);
    process.exit(2);
  }

  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    console.error('[smoke] FAIL — response body is not valid JSON');
    process.exit(2);
  }

  // Print safe metadata only — never prints token, base64, or PII.
  const scanStatus = typeof body.status === 'string' ? body.status : '(missing)';
  const hasDisplayResult = body.displayResult !== undefined && body.displayResult !== null;
  const productsIsArray = Array.isArray(body.recommendedProducts);
  const productsCount = productsIsArray ? body.recommendedProducts.length : '(not array)';

  console.log('[smoke] scan status:', scanStatus);
  console.log('[smoke] displayResult present:', hasDisplayResult ? 'YES' : 'NO');
  console.log('[smoke] recommendedProducts is array:', productsIsArray ? 'YES' : 'NO');
  console.log('[smoke] recommendedProducts count:', productsCount);

  if (productsIsArray && body.recommendedProducts.length > 0) {
    const first = body.recommendedProducts[0];
    const safeKeys = [
      'id', 'name', 'title', 'product_name', 'retailer', 'category',
      'canonical_category', 'color_normalized', 'availability',
      'matchScore', 'confidenceTier',
    ];
    const safeFirst = {};
    for (const k of safeKeys) {
      if (first[k] !== undefined) safeFirst[k] = first[k];
    }
    safeFirst.has_image_url = typeof first.image_url === 'string' || typeof first.imageUrl === 'string';
    safeFirst.has_product_url = typeof first.product_url === 'string' || typeof first.productUrl === 'string';
    console.log('[smoke] first product (safe keys only):', JSON.stringify(safeFirst));
  }

  // Contract assertions
  const failures = [];
  if (!['completed', 'non_fashion', 'failed'].includes(scanStatus)) {
    failures.push('scan status is unrecognized: ' + scanStatus);
  }
  if (!productsIsArray) {
    failures.push('recommendedProducts is not an array');
  }
  if (scanStatus === 'completed' && !body.attributes && !body.identification) {
    failures.push('completed response missing both attributes and identification');
  }

  if (failures.length > 0) {
    console.error('');
    console.error('[smoke] FAIL — contract violations:');
    for (const f of failures) console.error('  -', f);
    process.exit(2);
  }

  console.log('');
  console.log('[smoke] PASS — scan-identify is live and response contract validated');
  process.exit(0);
})();
