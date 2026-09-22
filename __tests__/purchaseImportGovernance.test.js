// Receipt & Purchase Intelligence V1 — parity, telemetry, flag and boundary
// controls that are properties of the SOURCE, not of one run.
//
//   - client/server constant parity and byte-identical scrub core (RPI-26/27/32)
//   - telemetry: allowlisted events and properties only, no content (section 38)
//   - feature flag fails closed and gates every entry (RPI-33)
//   - no receipt vault: nothing in the feature writes durable storage (RPI-35)
//   - the ownership seam stays explicit
//   - accessibility of the review surface (section 39)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { loadModule, readRepo, ROOT } = require('./helpers/purchaseImportHarness');


/** Code with comments removed, so a prose mention can never satisfy or fail a source guard. */
function codeOf(rel) {
  return ts.transpileModule(readRepo(rel), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, removeComments: true, jsx: ts.JsxEmit.Preserve },
    fileName: rel,
  }).outputText;
}

// ── Parity ───────────────────────────────────────────────────────────────────

function denoConst(source, name) {
  const m = new RegExp(`export const ${name} = ([^;]+);`).exec(source);
  assert.ok(m, `server constant ${name} missing`);
  // eslint-disable-next-line no-new-func
  return Function(`return (${m[1]});`)();
}

test('client and Edge Function agree on every shared bound', () => {
  const C = loadModule('services/purchaseImport/purchaseImportContract.ts');
  const server = readRepo('supabase/functions/purchase-import-extract/extraction.ts');
  assert.equal(denoConst(server, 'PURCHASE_IMPORT_CONTRACT_VERSION'), C.PURCHASE_IMPORT_CONTRACT_VERSION);
  assert.equal(denoConst(server, 'PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES'), C.PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES);
  assert.equal(denoConst(server, 'PURCHASE_IMPORT_MAX_ITEMS'), C.PURCHASE_IMPORT_MAX_ITEMS);
  assert.equal(
    denoConst(server, 'PURCHASE_IMPORT_DOCUMENT_CONFIDENCE_FLOOR'),
    C.PURCHASE_IMPORT_DOCUMENT_CONFIDENCE_FLOOR,
    'RPI-27: one floor, enforced identically on both sides',
  );
});

test('client and Edge Function agree on every enum', () => {
  const C = loadModule('services/purchaseImport/purchaseImportContract.ts');
  const server = readRepo('supabase/functions/purchase-import-extract/extraction.ts');
  const list = (name) => {
    const m = new RegExp(`export const ${name} = (\\[[\\s\\S]*?\\]) as const;`).exec(server);
    assert.ok(m, name);
    return Function(`return ${m[1]};`)();
  };
  assert.deepEqual(list('LINE_CLASSES'), [...C.PURCHASE_LINE_CLASSES]);
  assert.deepEqual(list('LINE_KINDS'), [...C.PURCHASE_LINE_KINDS]);
  assert.deepEqual(list('DOCUMENT_KINDS'), [...C.PURCHASE_DOCUMENT_KINDS]);
  assert.deepEqual(list('CLOSET_CATEGORIES'), [...C.PURCHASE_CLOSET_CATEGORIES]);
  assert.deepEqual(list('CURRENCY_EVIDENCE'), [...C.CURRENCY_EVIDENCE]);
  assert.deepEqual(list('BRAND_EVIDENCE'), [...C.BRAND_EVIDENCE]);
  assert.deepEqual(list('INPUT_TIERS'), [...C.PURCHASE_IMPORT_INPUT_TIERS]);
});

function scrubCore(rel) {
  const src = readRepo(rel);
  const a = src.indexOf('// BEGIN SHARED SCRUB CORE');
  const b = src.indexOf('// END SHARED SCRUB CORE');
  assert.ok(a >= 0 && b > a, `${rel} scrub-core markers`);
  return src.slice(a, b);
}

test('RPI-26: the sensitive-text scrub core is byte-identical on device and server', () => {
  assert.equal(
    scrubCore('supabase/functions/purchase-import-extract/sensitive.ts'),
    scrubCore('services/purchaseImport/purchaseImportSensitive.ts'),
  );
});

test('RPI-26: the scrub removes card fragments in every common shape and keeps garment text', () => {
  const S = loadModule('services/purchaseImport/purchaseImportSensitive.ts');
  const cases = [
    'VISA **** 4242',
    'Mastercard ending in 4242',
    'Card XXXX-4242',
    '•••• 4242',
    'last 4: 4242',
    'Paid with Amex 4242',
    '4111 1111 1111 1111',
    'Apple Pay 4242',
  ];
  for (const text of cases) {
    const out = S.scrubSensitiveText(`Linen shirt ${text}`) ?? '';
    assert.doesNotMatch(out, /4242|1111/, text);
    assert.match(out, /Linen shirt/);
  }
  // Garment shorthand that looks superficially like the removed shapes survives.
  for (const text of ['BLK DR M', 'Nike Court Vision Low 10', 'Cardigan Grey XL', 'Customer favorite tee', 'XXL tee']) {
    assert.equal(S.scrubSensitiveText(text), text, text);
  }
});

// ── Telemetry (section 38) ───────────────────────────────────────────────────

test('telemetry: only the five permitted events exist, and no property can carry content', () => {
  const T = loadModule('services/purchaseImport/purchaseImportTelemetry.ts');
  assert.deepEqual([...T.PURCHASE_IMPORT_EVENTS], [
    'purchase_import_started',
    'purchase_import_extraction_completed',
    'purchase_import_reviewed',
    'purchase_import_confirmed',
    'purchase_import_failed',
  ]);
  const banned = /merchant|title|brand|color|colour|size|price|currency|sku|gtin|text|image|order|email|phone|address|card|value|error/i;
  for (const p of T.PURCHASE_IMPORT_EVENT_PROPERTIES) assert.doesNotMatch(p, banned, p);
});

test('telemetry: free text, raw numbers and unknown keys never reach the sink', () => {
  const T = loadModule('services/purchaseImport/purchaseImportTelemetry.ts');
  const seen = [];
  T.setPurchaseImportTelemetrySink((event, payload) => seen.push({ event, payload }));
  T.emitPurchaseImportEvent('purchase_import_confirmed', {
    inputTier: 'order_confirmation',
    confirmedCountBucket: '2_4',
    completionState: 'Levi Strauss 501 W32', // free text -> dropped by shape
    merchant: 'Northline', // unknown key -> dropped
    correctionsMoney: 98.5, // not a small integer -> dropped
    correctionsFit: 1,
  });
  T.emitPurchaseImportEvent('purchase_import_leak', { inputTier: 'x' });
  T.resetPurchaseImportTelemetrySink();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].payload, { inputTier: 'order_confirmation', confirmedCountBucket: '2_4', correctionsFit: 1 });
});

test('telemetry: buckets never carry raw values', () => {
  const T = loadModule('services/purchaseImport/purchaseImportTelemetry.ts');
  assert.deepEqual([0, 1, 3, 7, 12].map(T.countBucket), ['0', '1', '2_4', '5_9', '10_plus']);
  assert.deepEqual([0.3, 0.6, 0.8, 0.95].map(T.confidenceBucket), ['below_floor', 'low', 'medium', 'high']);
});

test('telemetry is governed: registered surface, bridged sink, no vendor import in the feature', () => {
  const registry = readRepo('services/analytics/analyticsEventRegistry.ts');
  assert.match(registry, /from '\.\.\/purchaseImport\/purchaseImportTelemetry'/);
  assert.match(readRepo('services/analytics/posthogClient.core.ts'), /setPurchaseImportTelemetrySink/);
  for (const rel of featureFiles()) {
    assert.doesNotMatch(codeOf(rel), /posthog/i, `${rel} must not reach an analytics vendor directly`);
  }
});

// ── Flag (RPI-33) ────────────────────────────────────────────────────────────

function loadFlags(env) {
  const source = ts.transpileModule(readRepo('constants/featureFlags.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(`(function (exports, module, require) {\n${source}\n})`, {
    process: { env },
    __DEV__: false,
  })(mod.exports, mod, () => ({}));
  return mod.exports;
}

test('RPI-33: the flag is OFF unless exactly "true"', () => {
  assert.equal(loadFlags({}).RECEIPT_INTELLIGENCE_V1, false);
  for (const v of ['', 'TRUE', '1', ' true', 'yes', 'on']) {
    assert.equal(loadFlags({ EXPO_PUBLIC_RECEIPT_INTELLIGENCE_V1: v }).RECEIPT_INTELLIGENCE_V1, false, JSON.stringify(v));
  }
  assert.equal(loadFlags({ EXPO_PUBLIC_RECEIPT_INTELLIGENCE_V1: 'true' }).RECEIPT_INTELLIGENCE_V1, true);
});

test('RPI-33: no build profile enables the flag', () => {
  assert.doesNotMatch(readRepo('eas.json'), /RECEIPT_INTELLIGENCE/);
});

test('RPI-33: every entry is gated — the Closet entry, the route and the client', () => {
  const library = readRepo('app/library.tsx');
  assert.match(library, /onImportPurchase=\{\s*RECEIPT_INTELLIGENCE_V1\s*\?/);
  const route = readRepo('app/purchase-import/index.tsx');
  assert.match(route, /if \(!flow\.enabled\) goToCloset\(\)/);
  assert.match(route, /if \(!flow\.enabled\) return null;/);
  assert.match(readRepo('services/purchaseImport/purchaseImportClient.ts'), /if \(!enabled\) return \{ ok: false, errorClass: 'feature_disabled' \}/);
  // And the server has its own default-off kill switch.
  assert.match(
    readRepo('supabase/functions/purchase-import-extract/handler.ts'),
    /PURCHASE_IMPORT_EXTRACT_ENABLED'\) \?\? ''\)\.trim\(\) === 'true'/,
  );
});

// ── No receipt vault (sections 22, 25; RPI-35) ──────────────────────────────

function featureFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(rel);
    }
  };
  walk('services/purchaseImport');
  walk('components/purchase-import');
  walk('app/purchase-import');
  out.push('hooks/usePurchaseImport.ts');
  return out;
}

test('RPI-35: the feature writes no durable storage of its own; the only durable write is the Closet commit', () => {
  for (const rel of featureFiles()) {
    const src = codeOf(rel);
    assert.doesNotMatch(src, /documentDirectory/, `${rel}: no durable document-directory writes`);
    assert.doesNotMatch(src, /writeAsStringAsync|AsyncStorage|SecureStore|MMKV/, `${rel}: no persisted state`);
    // Import declarations are excluded: the review card reads the canonical
    // price FORMATTER from services/dressingRoomCommerce, which writes nothing.
    const body = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
    assert.doesNotMatch(body, /saveScan|recordRecentScan|inspiration|savedLook|dressingRoom/i, `${rel}: never writes other libraries`);
    assert.doesNotMatch(src, /\.from\(['"]|\.storage\b/, `${rel}: no Supabase table or Storage write`);
  }
});

test('the Edge Function writes nothing and logs no content', () => {
  const handler = readRepo('supabase/functions/purchase-import-extract/handler.ts');
  assert.doesNotMatch(handler, /\.from\(['"]|\.insert\(|\.upsert\(|\/storage\/v1/);
  // Every log line carries classes and counts, never the image or the model text.
  const logCalls = handler.match(/logEvent\([\s\S]*?\}\);/g) ?? [];
  for (const call of logCalls) assert.doesNotMatch(call, /imageBase64|providerText|sourceLine|merchant|raw/);
});

test('the reservation fingerprint is derived from the actor and session, never the image', () => {
  const handler = readRepo('supabase/functions/purchase-import-extract/handler.ts');
  assert.match(handler, /computeRequestFingerprint\(\[FUNCTION_NAME, userId, requestId\]\)/);
});

// ── The ownership seam ──────────────────────────────────────────────────────

test('the purchase-import commit is the only new ownership call site', () => {
  const callers = featureFiles().filter((rel) => /\bcreateClosetItem\s*\(/.test(readRepo(rel)));
  assert.deepEqual(callers, ['services/purchaseImport/purchaseImportCommit.ts']);
  assert.doesNotMatch(readRepo('hooks/usePurchaseImport.ts'), /createClosetItem\(/);
});

test('no wardrobe system is wired to receipts directly (section 26)', () => {
  for (const rel of featureFiles()) {
    assert.doesNotMatch(
      codeOf(rel),
      /style-chat|stylechat|packing|concierge|signatureStyle|styleDna|elise/i,
      `${rel}: receipts reach other systems only through the Closet`,
    );
  }
});

// ── Accessibility (section 39) ──────────────────────────────────────────────

test('the review surface labels selection state, uncertainty in words, and announces outcomes', () => {
  const card = readRepo('components/purchase-import/PurchaseCandidateCard.tsx');
  assert.match(card, /accessibilityRole="checkbox"/);
  assert.match(card, /accessibilityState=\{\{ checked: candidate\.selected/);
  assert.match(card, /please check this value/, 'uncertainty is spoken, not only coloured');
  assert.match(card, /⚑ Check/, 'uncertainty is written, not only coloured');
  const crop = readRepo('components/purchase-import/PurchaseCropStep.tsx');
  assert.match(crop, /accessibilityRole="adjustable"/);
  assert.match(crop, /onAccessibilityAction/);
  const route = readRepo('app/purchase-import/index.tsx');
  assert.match(route, /announceForAccessibility/);
  assert.match(route, /accessibilityRole="alert"/);
});
