#!/usr/bin/env node
/**
 * Checkpoint 4 — DEVELOPMENT-ONLY inspection surface for the advisory
 * similar-item engine.
 *
 * WHAT THIS IS
 *
 * Runs a fixed set of representative scan/existing-item pairs through the
 * real `classifyPair` engine (`supabase/functions/product-match/
 * closetSimilarity.ts`) and the real client-side action-eligibility rules
 * (`services/similarItemActions.ts`), then renders what a calibration
 * reviewer needs to see for each one: both sides of the comparison, which
 * source it came from, every evidence reason AND every conflict, the
 * internal threshold classification (NO_NOTICE / POTENTIAL / STRONG) with
 * the exact numbers behind it, which of the six actions would be eligible in
 * a plausible record state, and how long retrieval + scoring took.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BENCHMARK
 *
 * `scripts/product-match-benchmark.js` replays sealed commerce-matching
 * fixtures and reports pass/fail against labelled expectations — it is a
 * regression gate. This script is a REVIEW SURFACE: it makes no pass/fail
 * claim, seals nothing, and is meant to be read by a person deciding whether
 * a threshold change looks right, not asserted on by CI.
 *
 * WHY "DEVELOPMENT-ONLY" IS STRUCTURAL, NOT A COMMENT
 *
 * This script is never imported by any Edge Function, any Node service
 * entrypoint, or any client bundle — `require`d only by itself, run only from
 * a terminal. The `internal` scoring block it prints is the SAME shape as
 * `PotentialSimilarItem.internal` in the real contract, which is itself only
 * ever populated when a caller opts in via `debugSimilarity`. Nothing here
 * can leak into production user copy because nothing here runs in production.
 *
 * NO NETWORK, NO DATABASE. Fixtures are inline literals; the engine takes
 * plain objects. Offline and deterministic by construction, like the
 * benchmark it sits beside.
 *
 * Usage:
 *   node scripts/similarity-inspector.js            human-readable console report
 *   node scripts/similarity-inspector.js --json      machine-readable report
 *   node scripts/similarity-inspector.js --html out.html   also writes a static page
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const PRODUCT_MATCH_DIR = path.join(ROOT, 'supabase', 'functions', 'product-match');

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const htmlFlagIndex = args.indexOf('--html');
const HTML_OUT = htmlFlagIndex >= 0 ? (args[htmlFlagIndex + 1] || 'similarity-inspector-report.html') : null;

// ── Deno/TS module loading (same technique as product-match-benchmark.js) ───

const moduleCache = new Map();

function loadModule(absolutePath) {
  const resolved = absolutePath.endsWith('.ts') ? absolutePath : `${absolutePath}.ts`;
  if (moduleCache.has(resolved)) return moduleCache.get(resolved);

  const source = fs.readFileSync(resolved, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  moduleCache.set(resolved, mod.exports);

  const sandbox = {
    console, exports: mod.exports, module: mod,
    URL, URLSearchParams,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    Promise, Date, Math, JSON, Number, Object, Array, Set, Map, String, Boolean,
    Error, TypeError, RegExp, isNaN, parseInt, parseFloat, performance: globalThis.performance,
    // No `fetch`, no `Deno.env` value. See the header — offline is structural.
    Deno: { env: { get: () => undefined } },
    require: (specifier) => {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return loadModule(path.resolve(path.dirname(resolved), specifier));
      }
      throw new Error(`inspector sandbox refuses non-local import '${specifier}'`);
    },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(transpiled, sandbox, { filename: resolved });
  moduleCache.set(resolved, mod.exports);
  return mod.exports;
}

/** The client action-eligibility module is plain TS with no RN import — safe
 *  to load through the same sandbox as the backend modules. */
function loadClientModule(relativePath) {
  return loadModule(path.join(ROOT, relativePath));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// Deliberately the same representative scenarios as the governed directional
// suite (`similarityDirectional.test.ts`), so a reviewer who reads a failing
// assertion there can immediately find the matching row here to LOOK at.

const FIXTURES = [
  {
    id: 'same-product-same-colour',
    label: 'Same exact product and colour (Closet)',
    newScanImageUri: 'file:///scan/af1-white.jpg',
    newScanLabel: 'Scanned white sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing: {
      id: 'closet-af1', source: 'closet', label: 'White AF1', imageUri: 'file:///closet/af1.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'same-product-different-colour',
    label: 'Same product, different colour (Closet)',
    newScanImageUri: 'file:///scan/af1-black.jpg',
    newScanLabel: 'Scanned black sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'black' },
    existing: {
      id: 'closet-af1', source: 'closet', label: 'White AF1', imageUri: 'file:///closet/af1.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'uniform-basic-moderate',
    label: 'Two plain white tees, no distinguishing model (uniform/basic)',
    newScanImageUri: 'file:///scan/tee.jpg',
    newScanLabel: 'Scanned white tee',
    query: { brand: 'Uniqlo', visibleBrandText: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', material: 'cotton' },
    existing: {
      id: 'closet-tee', source: 'closet', label: 'White tee', imageUri: 'file:///closet/tee.jpg',
      brand: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', material: 'cotton',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'replacement-purchase-recent',
    label: 'Replacement purchase, same product (Recent Scans)',
    newScanImageUri: 'file:///scan/af1-2.jpg',
    newScanLabel: 'Scanned sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing: {
      id: 'recent-af1', source: 'recent_scan', label: 'Sneaker scan', imageUri: 'file:///recent/af1.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: true, hasCommerceCandidates: true },
  },
  {
    id: 'different-brand-similar-look',
    label: 'Visually similar, different brand',
    newScanImageUri: 'file:///scan/sneaker.jpg',
    newScanLabel: 'Scanned sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', canonicalCategory: 'footwear', color: 'white', silhouette: 'low-top' },
    existing: {
      id: 'closet-adidas', source: 'closet', label: 'White sneaker', imageUri: 'file:///closet/adidas.jpg',
      brand: 'Adidas', canonicalCategory: 'footwear', color: 'white', silhouette: 'low-top',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'same-category-different-silhouette',
    label: 'Same category, conflicting silhouette',
    newScanImageUri: 'file:///scan/lowtop.jpg',
    newScanLabel: 'Scanned low-top',
    query: { brand: 'Nike', visibleBrandText: 'Nike', canonicalCategory: 'footwear', color: 'white', silhouette: 'low-top' },
    existing: {
      id: 'closet-hightop', source: 'closet', label: 'High-top', imageUri: 'file:///closet/hightop.jpg',
      brand: 'Nike', canonicalCategory: 'footwear', color: 'white', silhouette: 'high-top',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'unrelated-same-colour',
    label: 'Same colour, unrelated products',
    newScanImageUri: 'file:///scan/dress.jpg',
    newScanLabel: 'Scanned dress',
    query: { canonicalCategory: 'dress', color: 'red' },
    existing: {
      id: 'closet-shoe', source: 'closet', label: 'Red shoe', imageUri: 'file:///closet/shoe.jpg',
      canonicalCategory: 'footwear', color: 'red',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'strong-identifier-plus-attributes',
    label: 'STRONG band: authoritative identifier + brand + model + colour + category',
    newScanImageUri: 'file:///scan/af1-strong.jpg',
    newScanLabel: 'Scanned white sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    scanIdentity: { authoritativeId: 'CW2288-111' },
    existing: {
      id: 'closet-af1-strong', source: 'closet', label: 'White AF1', imageUri: 'file:///closet/af1.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      authoritativeId: 'CW2288-111',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'strong-attribute-only',
    label: 'STRONG band: near-total attribute agreement, no identifier',
    newScanImageUri: 'file:///scan/af1-full.jpg',
    newScanLabel: 'Scanned white sneaker',
    query: {
      brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', material: 'leather', silhouette: 'low-top', pattern: 'solid',
    },
    existing: {
      id: 'closet-af1-full', source: 'closet', label: 'White AF1', imageUri: 'file:///closet/af1-full.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', material: 'leather', silhouette: 'low-top', pattern: 'solid',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'basics-identifier-match',
    label: 'Basics ladder: a plain tee DOES notice once an identifier agrees',
    newScanImageUri: 'file:///scan/tee2.jpg',
    newScanLabel: 'Scanned white tee',
    query: { brand: 'Uniqlo', visibleBrandText: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white' },
    scanIdentity: { authoritativeId: 'UNI-TEE-001' },
    existing: {
      id: 'closet-tee-id', source: 'closet', label: 'White tee', imageUri: 'file:///closet/tee.jpg',
      brand: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', authoritativeId: 'UNI-TEE-001',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'pattern-conflict',
    label: 'Pattern conflict: same brand/colour/material, floral vs striped',
    newScanImageUri: 'file:///scan/floral.jpg',
    newScanLabel: 'Scanned floral dress',
    query: { brand: 'Acne', visibleBrandText: 'Acne', canonicalCategory: 'dress', color: 'blue', pattern: 'floral', material: 'silk' },
    existing: {
      id: 'closet-striped', source: 'closet', label: 'Striped dress', imageUri: 'file:///closet/striped.jpg',
      brand: 'Acne', canonicalCategory: 'dress', color: 'blue', pattern: 'striped', material: 'silk',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'existing-item-archived',
    label: 'Action eligibility: the existing record is archived / soft-deleted',
    newScanImageUri: 'file:///scan/af1-5.jpg',
    newScanLabel: 'Scanned sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing: {
      id: 'closet-archived', source: 'closet', label: 'White AF1 (archived)', imageUri: 'file:///closet/af1-arch.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
    },
    recordState: {
      existingItemExists: true, existingItemArchived: true,
      newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true,
    },
  },
  {
    id: 'new-scan-already-in-closet',
    label: 'Action eligibility: the new scan is already saved to the Closet',
    newScanImageUri: 'file:///scan/af1-6.jpg',
    newScanLabel: 'Scanned sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing: {
      id: 'closet-af1-dup', source: 'closet', label: 'White AF1', imageUri: 'file:///closet/af1.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
    },
    recordState: {
      existingItemExists: true, newItemSavedToCloset: true, newItemInRecentScans: true, hasCommerceCandidates: false,
    },
  },
  {
    id: 'identifier-match',
    label: 'Authoritative identifier agrees, little else known',
    newScanImageUri: 'file:///scan/mystery.jpg',
    newScanLabel: 'Scanned item',
    query: { canonicalCategory: 'footwear' },
    scanIdentity: { authoritativeId: 'CW2288-111' },
    existing: {
      id: 'closet-id-match', source: 'closet', label: 'Boxed sneaker', imageUri: 'file:///closet/box.jpg',
      canonicalCategory: 'footwear', authoritativeId: 'CW2288-111',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'identifier-conflict',
    label: 'Identifiers DISAGREE despite matching attributes (known risk case)',
    newScanImageUri: 'file:///scan/af1-3.jpg',
    newScanLabel: 'Scanned sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    scanIdentity: { authoritativeId: 'SKU-000' },
    existing: {
      id: 'closet-af1-2', source: 'closet', label: 'White AF1', imageUri: 'file:///closet/af1-2.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white', authoritativeId: 'SKU-999',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'missing-images',
    label: 'Missing images on both sides, strong attribute evidence',
    newScanImageUri: null,
    newScanLabel: 'Scanned sneaker',
    scanIdentity: { imageQuality: 'missing' },
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing: {
      id: 'closet-noimg', source: 'closet', label: 'Sneaker (no photo)', imageUri: null,
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white', imageQuality: 'missing',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: false },
  },
  {
    id: 'incomplete-metadata',
    label: 'Incomplete metadata — category and colour only, thin coverage',
    newScanImageUri: 'file:///scan/thin.jpg',
    newScanLabel: 'Scanned item',
    query: { canonicalCategory: 'footwear', color: 'white' },
    existing: {
      id: 'closet-thin', source: 'closet', label: 'White shoe', imageUri: 'file:///closet/thin.jpg',
      canonicalCategory: 'footwear', color: 'white',
    },
    recordState: { existingItemExists: true, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
  {
    id: 'existing-item-already-gone',
    label: 'Action eligibility: the existing record no longer exists',
    newScanImageUri: 'file:///scan/af1-4.jpg',
    newScanLabel: 'Scanned sneaker',
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing: {
      id: 'closet-gone', source: 'closet', label: 'White AF1', imageUri: 'file:///closet/af1-gone.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
    },
    recordState: { existingItemExists: false, newItemSavedToCloset: false, newItemInRecentScans: false, hasCommerceCandidates: true },
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────

function main() {
  const closetSimilarity = loadModule(path.join(PRODUCT_MATCH_DIR, 'closetSimilarity.ts'));
  const actions = loadClientModule('services/similarItemActions.ts');

  const rows = FIXTURES.map((fixture) => {
    const startedAt = process.hrtime.bigint();
    const pair = closetSimilarity.classifyPair(fixture.query, fixture.existing, fixture.scanIdentity || {});
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const eligibility = actions.evaluateSimilarItemActions(fixture.recordState);

    return {
      id: fixture.id,
      label: fixture.label,
      newScan: { imageUri: fixture.newScanImageUri, label: fixture.newScanLabel },
      existingItem: {
        id: fixture.existing.id,
        source: fixture.existing.source,
        imageUri: fixture.existing.imageUri,
        label: fixture.existing.label,
      },
      classification: pair.classification,
      reasons: pair.reasons,
      conflicts: pair.conflicts,
      structuralVeto: pair.structuralVeto,
      internal: {
        thresholdVersion: pair.thresholdVersion,
        evidenceMode: pair.evidenceMode,
        categoryFamily: pair.categoryFamily,
        coverage: pair.coverage,
        imageAvailability: pair.imageAvailability,
        netScore: pair.netScore,
        potentialAt: pair.potentialAt,
        strongAt: pair.strongAt,
        distinctPositiveClasses: pair.distinctPositiveClasses,
        minDistinctPositiveClasses: pair.minDistinctPositiveClasses,
        adjustmentsApplied: pair.adjustmentsApplied,
      },
      eligibleActions: eligibility.filter((entry) => entry.eligible).map((entry) => entry.action),
      ineligibleActions: eligibility.filter((entry) => !entry.eligible),
      // Surfaced so a reviewer can see at a glance that the destructive
      // actions are gated and de-emphasised in EVERY row, not just the ones
      // someone remembered to check.
      confirmationRequired: eligibility
        .filter((entry) => entry.eligible && entry.requiresConfirmation)
        .map((entry) => entry.action),
      emphasis: Object.fromEntries(eligibility.map((entry) => [entry.action, entry.emphasis])),
      timingMs: Number(elapsedMs.toFixed(4)),
    };
  });

  const summary = {
    generatedBy: 'scripts/similarity-inspector.js (DEV ONLY — never called from production code)',
    candidateCount: rows.length,
    noticeCount: rows.filter((r) => r.classification !== 'NO_NOTICE').length,
    totalTimingMs: Number(rows.reduce((sum, r) => sum + r.timingMs, 0).toFixed(4)),
    rows,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printConsoleReport(summary);
  }

  if (HTML_OUT) {
    const htmlPath = path.isAbsolute(HTML_OUT) ? HTML_OUT : path.join(ROOT, HTML_OUT);
    fs.writeFileSync(htmlPath, renderHtml(summary), 'utf8');
    console.log(`\nWrote ${path.relative(ROOT, htmlPath)}`);
  }
}

function printConsoleReport(summary) {
  console.log('─'.repeat(78));
  console.log('Potential Similar-Item Engine — development inspection surface');
  console.log('DEV ONLY. Not a benchmark. Not asserted on. Read by a person, not CI.');
  console.log('─'.repeat(78));
  console.log(`fixtures: ${summary.candidateCount}   notices produced: ${summary.noticeCount}   total scoring time: ${summary.totalTimingMs}ms`);
  console.log('');

  for (const row of summary.rows) {
    console.log(`[${row.classification}] ${row.id}`);
    console.log(`  ${row.label}`);
    console.log(`  new scan      : ${row.newScan.imageUri || '(no image)'}  "${row.newScan.label || ''}"`);
    console.log(`  existing item : ${row.existingItem.imageUri || '(no image)'}  "${row.existingItem.label || ''}"  [${row.existingItem.source}]`);
    console.log(`  reasons       : ${row.reasons.join(', ') || '(none)'}`);
    console.log(`  conflicts     : ${row.conflicts.join(', ') || '(none)'}${row.structuralVeto ? `  STRUCTURAL VETO: ${row.structuralVeto}` : ''}`);
    console.log(
      `  internal      : ${row.internal.evidenceMode} / ${row.internal.categoryFamily} / ${row.internal.coverage} coverage / ${row.internal.imageAvailability} images`,
    );
    console.log(
      `                  score=${row.internal.netScore} needs>=${row.internal.potentialAt} (strong>=${row.internal.strongAt}), classes=${row.internal.distinctPositiveClasses}/${row.internal.minDistinctPositiveClasses}`,
    );
    console.log(`                  threshold version: ${row.internal.thresholdVersion}`);
    console.log(`  eligible      : ${row.eligibleActions.join(', ') || '(none)'}`);
    const ineligible = row.ineligibleActions.filter((e) => !e.eligible);
    if (ineligible.length > 0) {
      console.log(`  ineligible    : ${ineligible.map((e) => `${e.action} (${e.reason})`).join(', ')}`);
    }
    console.log(`  confirm req'd : ${row.confirmationRequired.join(', ') || '(none)'}`);
    console.log(`  timing        : ${row.timingMs}ms`);
    console.log('');
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml(summary) {
  const rowsHtml = summary.rows.map((row) => `
    <section class="card ${esc(row.classification)}">
      <header>
        <span class="badge ${esc(row.classification)}">${esc(row.classification)}</span>
        <h2>${esc(row.label)}</h2>
        <code>${esc(row.id)}</code>
      </header>
      <div class="panes">
        <div class="pane">
          <h3>Just scanned</h3>
          <div class="imgbox">${row.newScan.imageUri ? esc(row.newScan.imageUri) : 'no image'}</div>
          <p>${esc(row.newScan.label)}</p>
        </div>
        <div class="pane">
          <h3>${row.existingItem.source === 'closet' ? 'In your Closet' : 'In Recent Scans'}</h3>
          <div class="imgbox">${row.existingItem.imageUri ? esc(row.existingItem.imageUri) : 'no image'}</div>
          <p>${esc(row.existingItem.label)} <code>${esc(row.existingItem.id)}</code></p>
        </div>
      </div>
      <div class="evidence">
        <div><strong>Reasons:</strong> ${row.reasons.map(esc).join(', ') || '<em>none</em>'}</div>
        <div><strong>Conflicts:</strong> ${row.conflicts.map(esc).join(', ') || '<em>none</em>'}${row.structuralVeto ? ` &mdash; <strong>structural veto: ${esc(row.structuralVeto)}</strong>` : ''}</div>
      </div>
      <details>
        <summary>Internal scoring detail (dev only)</summary>
        <pre>${esc(JSON.stringify(row.internal, null, 2))}</pre>
      </details>
      <div class="actions">
        <strong>Eligible actions:</strong> ${row.eligibleActions.map((a) => (row.emphasis[a] === 'destructive' ? `<span class="destructive">${esc(a)}</span>` : esc(a))).join(', ') || '<em>none</em>'}<br/>
        ${row.ineligibleActions.filter((e) => !e.eligible).map((e) => `<span class="ineligible">${esc(e.action)} (${esc(e.reason)})</span>`).join(' ')}
        <div class="confirm"><strong>Requires explicit confirmation:</strong> ${row.confirmationRequired.map(esc).join(', ') || '<em>none</em>'}</div>
      </div>
      <div class="timing">scored in ${row.timingMs}ms</div>
    </section>`).join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Similarity Engine Inspector (dev only)</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 2rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.2rem; }
  .warn { padding: .5rem 1rem; background: #7a5b00; color: #fff; border-radius: 6px; display: inline-block; margin-bottom: 1rem; }
  .card { border: 1px solid #8888; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
  .card header { display: flex; align-items: baseline; gap: .5rem; }
  .badge { font-size: .7rem; padding: .15rem .5rem; border-radius: 999px; color: #000; }
  .badge.NO_NOTICE { background: #ccc; }
  .badge.POTENTIAL_SIMILAR_ITEM { background: #ffd479; }
  .badge.STRONG_SIMILARITY { background: #ff9d5c; }
  .panes { display: flex; gap: 1rem; margin: .5rem 0; }
  .pane { flex: 1; }
  .imgbox { border: 1px dashed #8888; border-radius: 6px; padding: .75rem; font-size: .75rem; word-break: break-all; opacity: .8; }
  .evidence { margin: .5rem 0; font-size: .9rem; }
  pre { overflow-x: auto; font-size: .8rem; }
  .ineligible { opacity: .6; font-size: .85rem; }
  .destructive { color: #c0392b; font-weight: 600; }
  .confirm { font-size: .85rem; margin-top: .35rem; opacity: .9; }
  .timing { font-size: .8rem; opacity: .7; margin-top: .5rem; }
</style></head>
<body>
  <div class="warn">DEVELOPMENT ONLY — generated by scripts/similarity-inspector.js. Never shipped to users.</div>
  <h1>Potential Similar-Item Engine — inspection report</h1>
  <p>${summary.candidateCount} fixtures, ${summary.noticeCount} produced a notice, ${summary.totalTimingMs}ms total scoring time.</p>
  ${rowsHtml}
</body></html>`;
}

main();
