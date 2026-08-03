#!/usr/bin/env node
/**
 * Governed offline Product Match Benchmark runner.
 *
 * Replays frozen provider fixtures through the real matching pipeline
 * (normalize → dedupe → evidence → tier) and reports accuracy against
 * hand-labelled expectations, plus the latency shape the recorded delays imply.
 *
 * WHAT IT WILL NOT DO
 *   - call a provider (it imports no provider module and reads no credential)
 *   - read or write the database
 *   - report an accuracy number for a case that has no label
 *   - run at all if the sealed case set has been modified without resealing
 *
 * The pipeline modules are Deno TypeScript with `.ts` import specifiers, so
 * they are transpiled in-process and evaluated in a `vm` sandbox — the same
 * technique `__tests__/scanCommerceRouter.test.js` already uses to exercise
 * Edge Function modules from Node. The sandbox is given no `fetch` at all,
 * which is what makes "no network" a structural property rather than a promise.
 *
 * Usage:
 *   node scripts/product-match-benchmark.js
 *   node scripts/product-match-benchmark.js --json
 *   node scripts/product-match-benchmark.js --reseal
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const BENCH_DIR = path.join(ROOT, 'tools', 'product-match-benchmark');
const CASES_DIR = path.join(BENCH_DIR, 'cases');
const MANIFEST_PATH = path.join(CASES_DIR, 'manifest.json');
const FUNCTION_DIR = path.join(ROOT, 'supabase', 'functions', 'product-match');

const args = new Set(process.argv.slice(2));
const AS_JSON = args.has('--json');
const RESEAL = args.has('--reseal');

// ── Deno module loading ──────────────────────────────────────────────────────

const moduleCache = new Map();

/**
 * Loads a `.ts` Edge module and its local `.ts` imports.
 *
 * The sandbox deliberately omits `fetch`, `Deno.env` values and every network
 * primitive. A module that reached for one would throw rather than silently
 * succeed, which is the behaviour we want from a benchmark that claims to be
 * offline.
 */
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
    console,
    exports: mod.exports,
    module: mod,
    URL,
    URLSearchParams,
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Promise,
    Date,
    Math,
    JSON,
    Number,
    Object,
    Array,
    Set,
    Map,
    String,
    Boolean,
    Error,
    TypeError,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    // Intentionally no `fetch`. See the header.
    Deno: { env: { get: () => undefined } },
    require: (specifier) => {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return loadModule(path.resolve(path.dirname(resolved), specifier));
      }
      throw new Error(`benchmark sandbox refuses non-local import '${specifier}'`);
    },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(transpiled, sandbox, { filename: resolved });
  moduleCache.set(resolved, mod.exports);
  return mod.exports;
}

// ── Sealing ──────────────────────────────────────────────────────────────────

function listCaseFiles() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
}

/**
 * Hashes case content with normalized line endings.
 *
 * The CRLF normalization is load-bearing on Windows checkouts: a seal computed
 * over raw bytes breaks the moment Git hands the same file back with different
 * line endings, and a seal that breaks for a non-reason gets resealed reflexively
 * — which is exactly how a real edit slips through unnoticed.
 */
function computeSeal(fileNames) {
  const hash = crypto.createHash('sha256');
  for (const name of fileNames) {
    const content = fs.readFileSync(path.join(CASES_DIR, name), 'utf8').replace(/\r\n/g, '\n');
    hash.update(`${name}:${crypto.createHash('sha256').update(content).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function writeManifest(fileNames) {
  const manifest = {
    manifestVersion: 'product-match-benchmark-v1',
    caseCount: fileNames.length,
    cases: fileNames,
    sealHash: computeSeal(fileNames),
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

// ── Replay ───────────────────────────────────────────────────────────────────

function buildNormalizer(normalize) {
  return (source, raw, hints) => {
    if (source === 'farfetch' || source === 'kickscrew') {
      return normalize.normalizeRetailerProduct(raw, source, hints);
    }
    if (source === 'catalog') {
      return normalize.isTestCatalogRow(raw) ? null : normalize.normalizeCatalogRow(raw, hints);
    }
    return normalize.normalizeRecommendedProduct(raw, source === 'brave' ? 'brave' : 'serper', hints);
  };
}

async function runCase(testCase, pipeline) {
  const { orchestrator, normalize, config } = pipeline;
  const normalizeOne = buildNormalizer(normalize);
  const hints = {
    brand: testCase.query.visibleBrandText || testCase.query.brand || null,
    canonicalCategory: testCase.query.canonicalCategory || null,
    color: testCase.query.color || null,
  };

  const deadlines = config.PRODUCT_MATCH_DEFAULT_DEADLINES;

  // Recorded seconds are replayed as milliseconds-scale virtual time. Ordering
  // and every relationship to the deadlines is preserved exactly; only the wall
  // clock is compressed, so a benchmark run costs a few milliseconds rather
  // than measuring the runner's willingness to sleep.
  const TIME_SCALE = 0.02;

  // Recorded delays are replayed as a virtual clock rather than as real sleeps:
  // the benchmark must be fast enough to run in CI, and a real 3.4s sleep would
  // measure the runner's patience rather than the orchestrator's behaviour.
  const providers = testCase.providers.map((recorded) => ({
    source: recorded.source,
    enabled: recorded.status !== 'disabled',
    run: () =>
      new Promise((resolve, reject) => {
        const virtualDelay = Math.max(1, Math.round(recorded.delayMs * TIME_SCALE));
        setTimeout(() => {
          if (recorded.status === 'error') {
            reject(new TypeError('recorded provider error'));
            return;
          }
          const rows = (recorded.products || [])
            .map((raw) => normalizeOne(recorded.source, raw, hints))
            .filter(Boolean);
          resolve(rows);
        }, virtualDelay);
      }),
  }));

  const scaledDeadlines = {
    perProviderMs: Math.max(1, Math.round(deadlines.perProviderMs * TIME_SCALE)),
    totalMs: Math.max(2, Math.round(deadlines.totalMs * TIME_SCALE)),
    firstUsefulTargetMs: Math.max(1, Math.round(deadlines.firstUsefulTargetMs * TIME_SCALE)),
  };

  const { response } = await orchestrator.orchestrateProductMatch({
    query: testCase.query,
    providers,
    options: { deadlines: scaledDeadlines },
  });

  const checks = [];
  if (typeof testCase.expectedTier === 'string') {
    checks.push({ name: 'tier', expected: testCase.expectedTier, actual: response.tier });
  }
  if (typeof testCase.expectedFamilyCount === 'number') {
    checks.push({ name: 'familyCount', expected: testCase.expectedFamilyCount, actual: response.families.length });
  }
  if (typeof testCase.expectedListingCount === 'number') {
    checks.push({ name: 'listingCount', expected: testCase.expectedListingCount, actual: response.listings.length });
  }

  const labelled = checks.length > 0;
  const failures = checks.filter((check) => check.expected !== check.actual);

  return {
    id: testCase.id,
    labelled,
    passed: labelled && failures.length === 0,
    failures,
    tier: response.tier,
    familyCount: response.families.length,
    listingCount: response.listings.length,
    // Recorded provider timings, un-scaled: this is the latency shape the case
    // captured, and it is the only latency number here worth reading.
    recordedFirstUsefulMs: firstUsefulRecorded(testCase, response),
    // The recorded wall clock a parallel orchestrator would have produced:
    // the slowest provider that was still inside the real total deadline.
    recordedCompleteMs: recordedCompleteMsFor(testCase, deadlines),
    partial: response.timings.partial,
    deadlineExceeded: response.timings.deadlineExceeded,
  };
}

/**
 * Wall clock a parallel orchestrator would report for this case: the slowest
 * provider still inside the total deadline, or the deadline itself when at
 * least one provider ran past it.
 *
 * Stated separately from the sum of the delays on purpose — the sum is what the
 * deployed sequential cascade would have cost, and the gap between the two is
 * the entire point of the orchestration change.
 */
function recordedCompleteMsFor(testCase, deadlines) {
  const delays = testCase.providers.map((provider) => provider.delayMs);
  if (delays.length === 0) return 0;
  const withinDeadline = delays.filter((delay) => delay <= deadlines.perProviderMs);
  const slowestUsable = withinDeadline.length > 0 ? Math.max(...withinDeadline) : 0;
  const anyOverran = delays.some((delay) => delay > deadlines.perProviderMs);
  return anyOverran ? Math.min(deadlines.totalMs, Math.max(slowestUsable, deadlines.perProviderMs)) : slowestUsable;
}

/**
 * The recorded delay of the earliest provider that both completed and could
 * have contributed a useful match. Null when the case produced none.
 */
function firstUsefulRecorded(testCase, response) {
  if (response.timings.firstUsefulMatchMs === null) return null;
  const contributing = testCase.providers
    .filter((provider) => provider.status === 'completed' && (provider.products || []).length > 0)
    .map((provider) => provider.delayMs)
    .sort((a, b) => a - b);
  return contributing.length > 0 ? contributing[0] : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const caseFiles = listCaseFiles();

  if (RESEAL) {
    const manifest = writeManifest(caseFiles);
    console.log(`Resealed ${manifest.caseCount} case(s). sealHash=${manifest.sealHash}`);
    return 0;
  }

  let manifest = readManifest();
  if (!manifest) {
    manifest = writeManifest(caseFiles);
    console.log(`No manifest found — created one over ${manifest.caseCount} case(s).`);
  }

  const actualSeal = computeSeal(caseFiles);
  if (actualSeal !== manifest.sealHash) {
    console.error('BENCHMARK REFUSED: the sealed case set has changed.');
    console.error(`  expected sealHash ${manifest.sealHash}`);
    console.error(`  actual   sealHash ${actualSeal}`);
    console.error('  Re-run with --reseal only if the case edit was intended.');
    return 2;
  }

  const pipeline = {
    orchestrator: loadModule(path.join(FUNCTION_DIR, 'orchestrator.ts')),
    normalize: loadModule(path.join(FUNCTION_DIR, 'normalize.ts')),
    config: loadModule(path.join(FUNCTION_DIR, 'config.ts')),
  };

  const results = [];
  for (const fileName of caseFiles) {
    const testCase = JSON.parse(fs.readFileSync(path.join(CASES_DIR, fileName), 'utf8'));
    results.push(await runCase(testCase, pipeline));
  }

  const labelled = results.filter((result) => result.labelled);
  const passed = labelled.filter((result) => result.passed);
  const unlabelled = results.length - labelled.length;

  const summary = {
    manifestVersion: manifest.manifestVersion,
    sealHash: manifest.sealHash,
    caseCount: results.length,
    labelledCount: labelled.length,
    unlabelledCount: unlabelled,
    passedCount: passed.length,
    // Explicitly null rather than 0 or 1 when nothing was labelled: an accuracy
    // of "0 of 0" is not an accuracy, and printing a number there is how a
    // scaffold gets mistaken for a baseline.
    accuracy: labelled.length > 0 ? Number((passed.length / labelled.length).toFixed(4)) : null,
    results,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('Product Match Benchmark — offline replay');
    console.log(`  seal        ${manifest.sealHash.slice(0, 16)}…`);
    console.log(`  cases       ${summary.caseCount} (${summary.labelledCount} labelled, ${summary.unlabelledCount} unlabelled)`);
    console.log(`  accuracy    ${summary.accuracy === null ? 'not measured (no labelled cases)' : `${passed.length}/${labelled.length}`}`);
    console.log('');
    for (const result of results) {
      const status = !result.labelled ? 'UNLABELLED' : result.passed ? 'PASS' : 'FAIL';
      console.log(`  [${status}] ${result.id}  tier=${result.tier} families=${result.familyCount} listings=${result.listingCount}${result.partial ? ' partial' : ''}`);
      for (const failure of result.failures) {
        console.log(`      ${failure.name}: expected ${failure.expected}, got ${failure.actual}`);
      }
      if (result.recordedFirstUsefulMs !== null) {
        console.log(`      recorded first-useful provider latency: ${result.recordedFirstUsefulMs}ms`);
      }
    }
    console.log('');
    console.log('  NOTE: recorded latencies are replayed fixture values, not a production measurement.');
  }

  const failed = labelled.filter((result) => !result.passed);
  return failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Benchmark runner failed:', error);
    process.exit(3);
  });
