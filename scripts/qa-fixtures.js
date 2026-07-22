const fs   = require('fs');
const path = require('path');

// No hosted default: callers must explicitly name a non-production QA target.
const API_URL =
  process.env.BASE_URL         ||
  process.env.KSCAN_API_URL;

if (!API_URL) {
  throw new Error('Set BASE_URL or KSCAN_API_URL explicitly; no legacy hosted default exists.');
}

// Token-gated diagnostic headers: set VALIDATION_SECRET_KEY in your shell to
// receive X-KScan-* version headers from the production backend.
const VALIDATION_SECRET = process.env.VALIDATION_SECRET_KEY || '';

const FIXTURE_DIR = path.join(__dirname, '..', 'assets', 'qa_fixtures');
const LOG_DIR     = path.join(__dirname, '..', 'qa');
const LOG_FILE    = path.join(LOG_DIR, 'fixtures-output.log');

const fixtures = [
  { id: 'footwear',            file: 'footwear.jpg',      fashion: true  },
  { id: 'outerwear',           file: 'outerwear.jpg',     fashion: true  },
  { id: 'top',                 file: 'top.jpg',           fashion: true  },
  { id: 'bottom_jeans',        file: 'bottom_jeans.jpg',  fashion: true  },
  { id: 'bottom_skirt',        file: 'bottom_skirt.jpg',  fashion: true  },
  { id: 'dress_or_one_piece',  file: 'dress.jpg',         fashion: true  },
  { id: 'accessory',           file: 'accessory.jpg',     fashion: true  },
  { id: 'non_fashion_control', file: 'non_fashion.jpg',   fashion: false },
];

function toDataUri(file) {
  const fullPath = path.join(FIXTURE_DIR, file);
  const base64 = fs.readFileSync(fullPath).toString('base64');
  return `data:image/jpeg;base64,${base64}`;
}

function hasMetadata(data) {
  return Boolean(
    data?.metadata?.category &&
    data?.metadata?.color &&
    data?.metadata?.silhouette &&
    Array.isArray(data?.products)
  );
}

async function analyze(fixture) {
  const headers = { 'Content-Type': 'application/json' };
  if (VALIDATION_SECRET) headers['X-KScan-Validation-Auth'] = VALIDATION_SECRET;
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image: toDataUri(fixture.file) }),
  });
  const data = await response.json();

  // Capture X-KScan-Debug deployment diagnostic headers
  const parserVersion       = response.headers.get('x-kscan-parser-version')        || 'unknown';
  const normalizationVersion = response.headers.get('x-kscan-normalization-version') || 'unknown';
  const promptVersion        = response.headers.get('x-kscan-prompt-version')        || 'unknown';
  const retryTriggered       = response.headers.get('x-kscan-retry-triggered')       || 'unknown';

  const ok = fixture.fashion
    ? response.status === 200 && hasMetadata(data)
    : response.status === 200 && data?.type === 'non-fashion';

  const resultPreview = String(data?.result || data?.message || '').slice(0, 300);

  return {
    fixture:             fixture.id,
    ok,
    status:              response.status,
    type:                data?.type || 'fashion',
    category:            data?.metadata?.category   || '',
    color:               data?.metadata?.color       || '',
    silhouette:          data?.metadata?.silhouette  || '',
    confidence:          data?.metadata?.confidence  ?? null,
    products:            Array.isArray(data?.products) ? data.products.length : 0,
    message:             data?.message || '',
    resultPreview,
    // deployment diagnostics (populated when server runs feature branch)
    parserVersion,
    normalizationVersion,
    promptVersion,
    retryTriggered,
  };
}

async function main() {
  const timestamp = new Date().toISOString();
  console.log(`[K-SCAN QA] Running fixtures against: ${API_URL}`);
  console.log(`[K-SCAN QA] Timestamp: ${timestamp}\n`);

  const results = [];
  for (const fixture of fixtures) {
    results.push(await analyze(fixture));
  }

  console.table(results.map(r => ({
    fixture:    r.fixture,
    ok:         r.ok,
    status:     r.status,
    type:       r.type,
    category:   r.category,
    color:      r.color,
    silhouette: r.silhouette,
    confidence: r.confidence,
    products:   r.products,
    message:    r.message,
    retryTriggered: r.retryTriggered,
  })));

  // Schema drift check — flag non-canonical values
  const CATEGORY_CANONICAL  = new Set(['Tops', 'Bottoms', 'Outerwear', 'Footwear', 'Accessories', 'Dresses', '']);
  const SILHOUETTE_CANONICAL = new Set(['Oversized', 'Fitted', 'Relaxed', 'Boxy', 'Cropped', 'Wide-leg', 'Slim', 'Flowy', 'Straight', 'Layered', '']);
  const driftRows = results.filter(r => r.ok && (
    !CATEGORY_CANONICAL.has(r.category) || !SILHOUETTE_CANONICAL.has(r.silhouette)
  ));
  if (driftRows.length > 0) {
    console.warn('\n[K-SCAN QA] TAXONOMY DRIFT DETECTED:');
    driftRows.forEach(r => console.warn(`  ${r.fixture}: category="${r.category}" silhouette="${r.silhouette}"`));
  } else {
    console.log('\n[K-SCAN QA] No taxonomy drift detected in passing fixtures.');
  }

  // Deployment version summary
  const versions = [...new Set(results.map(r => r.parserVersion))];
  if (versions.length > 1) {
    console.warn(`\n[K-SCAN QA] MIXED DEPLOYMENT VERSIONS DETECTED: ${versions.join(', ')}`);
    console.warn('[K-SCAN QA] This indicates rolling deployment lag or stale container instances.');
  } else if (versions[0] !== 'unknown') {
    console.log(`\n[K-SCAN QA] Parser version: ${versions[0]} (uniform across all requests)`);
  } else {
    console.log('\n[K-SCAN QA] Deployment version headers not present (server may be running pre-v3.0 or production mode).');
  }

  // Save full output to log file
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const logEntry = {
    timestamp,
    apiUrl: API_URL,
    summary: {
      total:  results.length,
      passed: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
    },
    versions: {
      parser:        [...new Set(results.map(r => r.parserVersion))],
      normalization: [...new Set(results.map(r => r.normalizationVersion))],
      prompt:        [...new Set(results.map(r => r.promptVersion))],
    },
    driftCount: driftRows.length,
    results,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
  console.log(`\n[K-SCAN QA] Full output saved to: ${LOG_FILE}`);

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[K-SCAN QA] FAILED fixtures: ${failed.map(f => f.fixture).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[K-SCAN QA] Fixture validation failed:', error?.message || error);
  process.exit(1);
});
