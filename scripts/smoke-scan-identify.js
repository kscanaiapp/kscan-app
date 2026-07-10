#!/usr/bin/env node
/**
 * Terminal smoke test for the scan-identify Edge Function (text mode).
 *
 * Authenticated (live App Staging) usage — needs a real staging user JWT:
 *   STAGING_USER_JWT=eyJ... node scripts/smoke-scan-identify.js
 *   STAGING_USER_JWT=eyJ... node scripts/smoke-scan-identify.js --text "black puffer jacket"
 *   STAGING_USER_JWT=eyJ... node scripts/smoke-scan-identify.js --batch
 *
 * Offline accuracy matrix (no JWT / no network needed):
 *   node scripts/accuracy-matrix.js
 *
 * Does NOT use a service-role key or fabricated JWTs.
 * Does NOT print token values, base64, or PII.
 *
 * Exit codes:
 *   0  — function live and response contract validated
 *   1  — auth token missing (by design — needs human setup)
 *   2  — HTTP or response contract error
 */

'use strict';

const DEFAULT_URL = 'https://wyyuqfdxucjksghsmhry.supabase.co';
const ENDPOINT_PATH = '/functions/v1/scan-identify';
const TIMEOUT_MS = 6000;

// The 10 baseline accuracy queries (Phase 3 / Phase 13 of the sprint).
const BATCH_QUERIES = [
  'black puffer jacket',
  'cream wool coat',
  'navy blazer',
  'white sneakers',
  'brown leather handbag',
  'floral midi dress',
  'black tote bag next to jacket',
  'lamp on table',
  'dark blurry clothing',
  'person wearing jacket and carrying bag',
];

function parseArgs(argv) {
  const out = { batch: false, text: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--batch') out.batch = true;
    else if (argv[i] === '--text') out.text = argv[++i] || '';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const token = process.env.STAGING_USER_JWT;
const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || DEFAULT_URL).replace(/\/$/, '');
const url = supabaseUrl + ENDPOINT_PATH;

if (!token) {
  console.log('SMOKE_TEST_REQUIRES_AUTH_TOKEN');
  console.log('AUTHENTICATED_SMOKE_NOT_RUN_NO_JWT');
  console.log('');
  console.log('To run the authenticated smoke test:');
  console.log('  STAGING_USER_JWT=<valid-staging-user-jwt> node scripts/smoke-scan-identify.js [--batch | --text "<query>"]');
  console.log('');
  console.log('For an offline accuracy check that needs no JWT, run:');
  console.log('  node scripts/accuracy-matrix.js');
  process.exit(1);
}

const queries = args.batch ? BATCH_QUERIES : [args.text || 'black tailored jacket'];

function safeFirstProduct(first) {
  const safeKeys = [
    'id', 'name', 'title', 'product_name', 'retailer', 'category',
    'canonical_category', 'color_normalized', 'availability', 'matchScore', 'confidenceTier',
  ];
  const safe = {};
  for (const k of safeKeys) if (first[k] !== undefined) safe[k] = first[k];
  safe.has_image_url = typeof first.image_url === 'string' || typeof first.imageUrl === 'string';
  safe.has_product_url = typeof first.product_url === 'string' || typeof first.productUrl === 'string';
  return safe;
}

async function runOne(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const failures = [];
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'text', textQuery: query }),
        signal: controller.signal,
      });
    } catch (err) {
      failures.push(err && err.name === 'AbortError' ? 'request timed out' : ('fetch error: ' + (err && err.message)));
      return { query, failures };
    }

    if (!res.ok) {
      failures.push('non-2xx HTTP status: ' + res.status);
      return { query, http: res.status, failures };
    }

    let body;
    try { body = JSON.parse(await res.text()); }
    catch { failures.push('response body is not valid JSON'); return { query, http: res.status, failures }; }

    const status = typeof body.status === 'string' ? body.status : '(missing)';
    const productsIsArray = Array.isArray(body.recommendedProducts);
    const category = body.attributes && body.attributes.category;
    const idItemType = body.identification && body.identification.item_type;
    const confidenceLabel = body.displayResult && body.displayResult.confidenceLabel;
    const qualityNote = !!(body.identification && body.identification.scan_quality_note);
    const firstCat = productsIsArray && body.recommendedProducts[0]
      ? (body.recommendedProducts[0].canonical_category || body.recommendedProducts[0].category)
      : null;

    if (!['completed', 'non_fashion', 'failed'].includes(status)) failures.push('unrecognized status: ' + status);
    if (!productsIsArray) failures.push('recommendedProducts is not an array');
    if (status === 'completed' && !body.attributes && !body.identification) failures.push('completed missing attributes+identification');
    if (status === 'non_fashion' && productsIsArray && body.recommendedProducts.length > 0) failures.push('non_fashion returned products');

    return {
      query, http: res.status, status,
      category, idItemType, confidenceLabel, qualityNote,
      hasDisplayResult: body.displayResult != null,
      products: productsIsArray ? body.recommendedProducts.length : '(not array)',
      firstProductCategory: firstCat,
      firstProduct: (productsIsArray && body.recommendedProducts[0]) ? safeFirstProduct(body.recommendedProducts[0]) : null,
      failures,
    };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log('[smoke] scan-identify text-mode smoke');
  console.log('[smoke] url:', url);
  console.log('[smoke] mode:', args.batch ? 'batch (10 baseline queries)' : 'single');
  console.log('[smoke] token: [REDACTED]');
  console.log('');

  let anyFail = false;
  for (const q of queries) {
    const r = await runOne(q);
    console.log('- query:', JSON.stringify(q));
    console.log('  http:', r.http, '| status:', r.status,
      '| category:', r.category, '| item_type:', r.idItemType,
      '| confidence:', r.confidenceLabel, '| qualityNote:', r.qualityNote ? 'YES' : 'NO',
      '| displayResult:', r.hasDisplayResult ? 'YES' : 'NO',
      '| products:', r.products, '| firstProductCategory:', r.firstProductCategory);
    if (r.firstProduct) console.log('  firstProduct(safe):', JSON.stringify(r.firstProduct));
    if (r.failures && r.failures.length) {
      anyFail = true;
      for (const f of r.failures) console.log('  FAIL:', f);
    }
    console.log('');
  }

  if (anyFail) { console.error('[smoke] FAIL — contract violations above'); process.exit(2); }
  console.log('[smoke] PASS — scan-identify live and response contract validated');
  process.exit(0);
})();
