'use strict';

/**
 * Offline guards for the live Scanner certification harness (security/release/scanner-live-certification).
 *
 * Everything here is deterministic and costs nothing. It proves the harness cannot
 * overspend, cannot leave Staging, cannot read an excluded image, scores against the
 * predeclared truth, and that the predeclared thresholds were not edited after the
 * protocol was written. It says nothing about the real scan-identify function.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const KIT = path.join(ROOT, 'security', 'release', 'scanner-live-certification');
const corpus = require(path.join(KIT, 'corpus.json'));
const { createBudget, BudgetExceededError, classifyRequest, COMMERCE_ONLY, IMAGE_MODE } = require(path.join(KIT, 'lib', 'budget.js'));
const { assertTarget, createLiveEdge, createRecorder, LiveEdgeError } = require(path.join(KIT, 'lib', 'liveEdge.js'));
const { resolveApprovedFixture, FixtureError } = require(path.join(KIT, 'lib', 'fixtures.js'));
const scoring = require(path.join(KIT, 'lib', 'scoring.js'));
const report = require(path.join(KIT, 'lib', 'report.js'));
const { REGIONS } = require(path.join(KIT, 'lib', 'kit.js'));
const { buildLedgerQuery, decodeJwtSub, mergePrior } = require(path.join(KIT, 'lib', 'campaignUsage.js'));
const runner = require(path.join(KIT, 'run.js'));

const LIMITS = {
  imageModeTotal: corpus.budget.imageModeRequestsTotal,
  commerceOnlyTotal: corpus.budget.commerceOnlyRequestsTotal,
  imageModePerActorPerUtcDay: corpus.budget.imageModeRequestsPerActorPerUtcDay,
};

// ── Predeclared protocol cannot drift silently ──────────────────────────────

const stable = (v) => (Array.isArray(v)
  ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v));

test('thresholds and budget match the digest declared in the protocol document', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'build35', 'scanner', 'LIVE_CERTIFICATION_PROTOCOL.md'), 'utf8');
  const declared = doc.match(/thresholds\+budget sha256: ([0-9a-f]{64})/)?.[1];
  assert.ok(declared, 'the protocol must declare the digest');
  const actual = crypto.createHash('sha256').update(stable({ thresholds: corpus.thresholds, budget: corpus.budget })).digest('hex');
  assert.equal(actual, declared, 'thresholds/budget changed without the protocol document changing in the same commit');
});

test('the owner-approved caps are exactly the ones encoded', () => {
  assert.deepEqual(LIMITS, { imageModeTotal: 56, commerceOnlyTotal: 40, imageModePerActorPerUtcDay: 28 });
});

// ── Budget guard ────────────────────────────────────────────────────────────

test('MODE B is commerce-only and everything else is image-mode', () => {
  assert.equal(classifyRequest({ requestMode: 'commerce_only' }), COMMERCE_ONLY);
  for (const body of [{ requestMode: 'multi_item_detection' }, { requestMode: 'selected_item' }, {}, null]) {
    assert.equal(classifyRequest(body), IMAGE_MODE);
  }
});

test('budget refuses the request after each ceiling and records every refusal', () => {
  const day = () => new Date('2026-10-10T12:00:00Z');
  const budget = createBudget({ limits: { imageModeTotal: 3, commerceOnlyTotal: 1, imageModePerActorPerUtcDay: 2 }, clock: day });
  budget.reserve({ kind: IMAGE_MODE, actor: 'A' });
  budget.reserve({ kind: IMAGE_MODE, actor: 'A' });
  assert.throws(() => budget.reserve({ kind: IMAGE_MODE, actor: 'A' }), (e) => e instanceof BudgetExceededError && /per_actor_per_day/.test(e.message));
  budget.reserve({ kind: IMAGE_MODE, actor: 'B' });
  assert.throws(() => budget.reserve({ kind: IMAGE_MODE, actor: 'B' }), /image_mode_total/);
  budget.reserve({ kind: COMMERCE_ONLY, actor: 'A' });
  assert.throws(() => budget.reserve({ kind: COMMERCE_ONLY, actor: 'A' }), /commerce_only_total/);
  assert.equal(budget.tripped, true);
  assert.equal(budget.snapshot().refused.length, 3);
  assert.deepEqual(budget.snapshot().usedThisRun.imageMode, 3);
});

test('what the campaign already spent counts against every ceiling', () => {
  const budget = createBudget({
    limits: LIMITS,
    prior: { imageMode: 55, commerceOnly: 39, imageModePerActorToday: { A: 27 } },
    clock: () => new Date('2026-10-10T00:00:00Z'),
  });
  budget.reserve({ kind: IMAGE_MODE, actor: 'A' }); // 56th total, 28th for A today
  assert.throws(() => budget.reserve({ kind: IMAGE_MODE, actor: 'A' }), BudgetExceededError);
  budget.reserve({ kind: COMMERCE_ONLY, actor: 'A' }); // 40th
  assert.throws(() => budget.reserve({ kind: COMMERCE_ONLY, actor: 'A' }), BudgetExceededError);
});

test('limits must be explicit integers', () => {
  assert.throws(() => createBudget({ limits: { imageModeTotal: 'many' } }), TypeError);
  assert.throws(() => createBudget({}), TypeError);
});

test('a refused request never reaches the network', async () => {
  let networkCalls = 0;
  const budget = createBudget({ limits: { imageModeTotal: 1, commerceOnlyTotal: 1, imageModePerActorPerUtcDay: 1 } });
  const recorder = createRecorder();
  const edge = createLiveEdge({
    baseUrl: 'http://127.0.0.1:1', publishableKey: 'k', getToken: async () => 't', actor: 'A', budget, recorder,
    fetchImpl: async () => { networkCalls += 1; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ status: 'completed' }) }; },
  });
  const body = { requestMode: 'multi_item_detection', imageBase64: 'AAAA' };
  const first = await edge.supabase.functions.invoke('scan-identify', { body });
  const second = await edge.supabase.functions.invoke('scan-identify', { body });
  assert.equal(first.error, null);
  assert.equal(second.data, null);
  assert.equal(second.error?.name, 'FunctionsFetchError');
  assert.equal(networkCalls, 1, 'the second request was refused before fetch');
  assert.equal(recorder.entries.at(-1).outcome, 'budget_refused');
});

test('an injected failure is free: it never reserves budget or sends', async () => {
  let networkCalls = 0;
  const budget = createBudget({ limits: LIMITS });
  const recorder = createRecorder();
  const edge = createLiveEdge({
    baseUrl: 'http://127.0.0.1:1', publishableKey: 'k', getToken: async () => 't', actor: 'A', budget, recorder,
    hooks: { beforeSend: async () => ({ fail: true }) },
    fetchImpl: async () => { networkCalls += 1; throw new Error('must not be called'); },
  });
  const out = await edge.supabase.functions.invoke('scan-identify', { body: { requestMode: 'selected_item' } });
  assert.equal(out.error.name, 'FunctionsFetchError');
  assert.equal(networkCalls, 0);
  assert.equal(budget.snapshot().usedThisRun.imageMode, 0);
});

test('only scan-identify may be invoked', async () => {
  const edge = createLiveEdge({
    baseUrl: 'http://127.0.0.1:1', publishableKey: 'k', getToken: async () => 't', actor: 'A', budget: createBudget({ limits: LIMITS }),
    recorder: createRecorder(), fetchImpl: async () => { throw new Error('must not be called'); },
  });
  const out = await edge.supabase.functions.invoke('some-other-function', { body: {} });
  assert.equal(out.data, null);
  assert.ok(out.error);
});

// ── Staging only ────────────────────────────────────────────────────────────

test('only the Staging project may be targeted; loopback only when explicitly allowed', () => {
  const staging = 'https://yzqjvdfgefveprobvvyw.supabase.co';
  assert.deepEqual(assertTarget({ baseUrl: staging, projectRef: 'yzqjvdfgefveprobvvyw' }), { mode: 'staging' });
  assert.throws(() => assertTarget({ baseUrl: 'https://wyyuqfdxucjksghsmhry.supabase.co', projectRef: 'wyyuqfdxucjksghsmhry' }), (e) => e instanceof LiveEdgeError && e.code === 'PRODUCTION');
  assert.throws(() => assertTarget({ baseUrl: staging, projectRef: 'wyyuqfdxucjksghsmhry' }), /production/);
  assert.throws(() => assertTarget({ baseUrl: 'https://example.com', projectRef: 'yzqjvdfgefveprobvvyw' }), /host/);
  assert.throws(() => assertTarget({ baseUrl: 'https://yzqjvdfgefveprobvvyw.supabase.co', projectRef: 'abcdefghijklmnopqrst' }), /not the staging/);
  assert.throws(() => assertTarget({ baseUrl: 'http://127.0.0.1:1234', projectRef: 'yzqjvdfgefveprobvvyw' }), LiveEdgeError);
  assert.deepEqual(assertTarget({ baseUrl: 'http://127.0.0.1:1234', projectRef: 'x', allowLoopback: true }), { mode: 'loopback' });
});

test('live mode refuses to spend without the typed confirmation and before any network call', async () => {
  const env = {
    SUPABASE_STAGING_PROJECT_REF: 'yzqjvdfgefveprobvvyw', SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
    SUPABASE_STAGING_PUBLISHABLE_KEY: 'k', STAGING_SYNTHETIC_ACTIVE_EMAIL: 'a@b.invalid', STAGING_SYNTHETIC_ACTIVE_PASSWORD: 'x',
  };
  await assert.rejects(runner.main(['--phase', 'P1'], env), (e) => e.code === 'CONFIRM');
  await assert.rejects(runner.main(['--phase', 'P1'], { ...env, SCANNER_LIVE_CONFIRM: 'yes' }), (e) => e.code === 'CONFIRM');
  await assert.rejects(runner.main(['--phase', 'P1'], {}), (e) => e.code === 'ENV');
  assert.throws(() => runner.parseArgs(['--phase', 'P9']), /--phase/);
  assert.throws(() => runner.parseArgs(['--phase', 'P1', '--bogus']), /unknown argument/);
});

// ── Image safety ────────────────────────────────────────────────────────────

test('the excluded fixture can never be resolved, and every approved fixture exists', () => {
  assert.throws(() => resolveApprovedFixture(corpus, 'bottom_skirt.jpg'), (e) => e instanceof FixtureError && e.code === 'FIXTURE_EXCLUDED');
  assert.throws(() => resolveApprovedFixture(corpus, '../package.json'), (e) => e.code === 'FIXTURE_PATH');
  assert.throws(() => resolveApprovedFixture(corpus, 'dress_copy.jpg'), (e) => e.code === 'FIXTURE_NOT_APPROVED');
  for (const image of corpus.images) {
    assert.ok(fs.existsSync(resolveApprovedFixture(corpus, image.file)), image.file);
  }
  assert.equal(corpus.images.some((i) => i.file === 'bottom_skirt.jpg'), false, 'the excluded image is not in the corpus');
  const source = fs.readdirSync(path.join(KIT, 'lib')).map((f) => fs.readFileSync(path.join(KIT, 'lib', f), 'utf8')).join('\n');
  assert.equal(/bottom_skirt/.test(source), false, 'harness code never names the excluded image');
});

// ── Evidence privacy ────────────────────────────────────────────────────────

test('the report guard rejects image bytes, tokens, emails and uuids', () => {
  // Secret-shaped samples are assembled at runtime so no committed line resembles a
  // real credential (and secret scanners have nothing to flag in this file).
  const jwtShape = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTYifQ', 'signaturepart'].join('.');
  const patShape = `sb${'p'}_${'0123456789abcdef'.repeat(3).slice(0, 40)}`;
  const bad = [
    'data:image/jpeg;base64,AAAA',
    jwtShape,
    'someone@example.com',
    '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    'A'.repeat(300),
    patShape,
    `${'Bear'}er abcdefghijklmnop`,
  ];
  for (const value of bad) assert.throws(() => report.assertEvidencePrivacy({ nested: [value] }), report.EvidencePrivacyError, value.slice(0, 24));
  assert.doesNotThrow(() => report.assertEvidencePrivacy({ title: 'Black leather biker jacket', host: 'shop.example.com', n: 3 }));
});

test('offers are reduced to bounded public fields and destinations lose their query strings', () => {
  const offer = report.sanitizeOffer({
    title: 'Jacket', retailer: 'Shop', price: 19.99, currency: 'USD',
    productUrl: 'https://shop.example.com/p/jacket?utm_source=x&token=secret', internalScore: 9, imageBase64: 'zzz',
  }, 1);
  assert.deepEqual(Object.keys(offer).sort(), ['confidenceTier', 'currency', 'destination', 'matchScore', 'price', 'provider', 'rank', 'retailer', 'title']);
  assert.equal(offer.destination.path, '/p/jacket');
  assert.equal(JSON.stringify(offer).includes('secret'), false);
});

test('percentiles use nearest rank and never average', () => {
  assert.equal(report.percentile([1, 2, 3, 4, 100], 50), 3);
  assert.equal(report.percentile([1, 2, 3, 4, 100], 95), 100);
  assert.deepEqual(report.summarize([]), { n: 0, min: null, p50: null, p95: null, max: null });
});

// ── Scoring against the predeclared truth ───────────────────────────────────

const imageOf = (id) => corpus.images.find((i) => i.id === id);

test('a jacket described as a dress is a critical misidentification', () => {
  const o = imageOf('O');
  const wrong = scoring.scoreIdentification(o, o.expectedGarments[0], {
    identification: { item_type: 'dress', subtype: 'midi dress', primary_color: 'black', confidence_score: 0.95 },
    attributes: { category: 'dress' },
  });
  assert.equal(wrong.critical, true);
  assert.equal(wrong.categoryCorrect, false);
  assert.equal(wrong.overconfidentWrong, true);
  const right = scoring.scoreIdentification(o, o.expectedGarments[0], {
    identification: { item_type: 'jacket', subtype: 'leather biker jacket', primary_color: 'black', material_estimate: 'leather' },
    attributes: { category: 'outerwear' },
  });
  assert.equal(right.critical, false);
  assert.equal(right.categoryCorrect && right.subtypeAcceptable && right.colorAcceptable, true);
});

test('brand claims must be grounded in visible text from the ground truth', () => {
  const t = imageOf('T');
  const hoodie = t.expectedGarments[0];
  const grounded = scoring.scoreIdentification(t, hoodie, { identification: { subtype: 'hoodie', primary_color: 'white', visible_brand_text: 'COQ', brand_guess: 'Coq' }, attributes: {} });
  assert.deepEqual(grounded.ungroundedBrandClaims, []);
  const invented = scoring.scoreIdentification(t, hoodie, { identification: { subtype: 'hoodie', primary_color: 'white', brand_guess: 'Balenciaga' }, attributes: {} });
  assert.deepEqual(invented.ungroundedBrandClaims, ['Balenciaga']);
  const none = scoring.scoreIdentification(t, hoodie, { identification: { subtype: 'hoodie', primary_color: 'white', brand_guess: 'unknown' }, attributes: {} });
  assert.deepEqual(none.ungroundedBrandClaims, []);
  const wrongFixtureBrand = scoring.scoreIdentification(imageOf('O'), imageOf('O').expectedGarments[0], { identification: { subtype: 'jacket', brand_guess: 'Coq' }, attributes: {} });
  assert.deepEqual(wrongFixtureBrand.ungroundedBrandClaims, ['Coq'], 'a brand grounded on one fixture is not grounded on another');
});

test('the book in the accessory photo is a distractor, never a garment', () => {
  const a = imageOf('A');
  const score = scoring.scoreDetection(a, [
    { candidateId: 'g1', label: 'crossbody bag', category: 'bag', subtype: 'crossbody' },
    { candidateId: 'g2', label: 'aviator sunglasses', category: 'eyewear', subtype: 'aviator' },
    { candidateId: 'g3', label: 'book', category: 'accessory', subtype: 'paperback book' },
  ]);
  assert.equal(score.distractorAsGarment, 1);
  assert.equal(score.requiredDetected, 2);
  assert.equal(score.extraFalseCandidates, 0);
});

test('a non-fashion image with any candidate is a false-candidate failure', () => {
  const n = imageOf('N');
  assert.equal(scoring.scoreDetection(n, []).nonFashionFalseCandidates, 0);
  assert.equal(scoring.scoreDetection(n, [{ candidateId: 'g1', label: 'cup', category: 'accessory', subtype: 'mug' }]).nonFashionFalseCandidates, 1);
});

test('required garments that are not detected are reported by name', () => {
  const j = imageOf('J');
  const score = scoring.scoreDetection(j, [{ candidateId: 'g1', label: 'jeans', category: 'bottoms', subtype: 'jeans' }]);
  assert.deepEqual(score.missedRequired, []);
  const missed = scoring.scoreDetection(imageOf('A'), [{ candidateId: 'g1', label: 'crossbody bag', category: 'bag', subtype: 'crossbody' }]);
  assert.deepEqual(missed.missedRequired, ['aviators']);
});

test('candidate/identity drift catches garment N inheriting another garment label', () => {
  const drift = scoring.candidateIdentityDrift(
    { label: 'sunglasses', category: 'eyewear', subtype: 'aviator' },
    { identification: { item_type: 'crossbody bag', subtype: 'bag' }, attributes: { category: 'bag' }, displayed: { title: 'Blue Crossbody Bag' } },
  );
  assert.equal(drift.drift, true);
  assert.equal(scoring.candidateIdentityDrift({ label: 'jeans', category: 'bottoms', subtype: 'jeans' }, { identification: { item_type: 'jeans' }, attributes: {}, displayed: {} }).drift, false);
});

test('commerce metrics follow the rubric thresholds exactly', () => {
  const metrics = scoring.commerceMetrics([
    { garmentKey: 'a', scores: [3, 2, 1, 0, 2] },
    { garmentKey: 'b', scores: [0, 1, 1, 2, 2] },
    { garmentKey: 'c', scores: [2, 2, 2, 3, 3] },
  ]);
  assert.equal(metrics.garmentsGraded, 3);
  assert.equal(metrics.hitAt3, 2 / 3);
  assert.equal(Number(metrics.meanTop3Precision.toFixed(4)), Number(((2 / 3 + 0 + 1) / 3).toFixed(4)));
  assert.deepEqual(metrics.top1Unrelated, ['b']);
  assert.equal(scoring.commerceMetrics([]).hitAt3, null);
});

test('offer prechecks flag probable mismatches without scoring them', () => {
  const jacket = imageOf('O').expectedGarments[0];
  assert.deepEqual(scoring.offerPrecheck(jacket, { title: 'Black Leather Biker Jacket' }), { titleMatchesCategory: true, titleIncompatible: false });
  assert.deepEqual(scoring.offerPrecheck(jacket, { title: 'Floral Midi Dress' }), { titleMatchesCategory: false, titleIncompatible: true });
  assert.equal(scoring.destinationValid({ destination: { https: true, host: 'shop.example.com' } }), true);
  assert.equal(scoring.destinationValid({ destination: { https: false, host: 'shop.example.com' } }), false);
  assert.equal(scoring.priceSane({ price: 19.99, currency: 'USD' }), true);
  assert.equal(scoring.priceSane({ price: -4, currency: 'USD' }), false);
  assert.equal(scoring.priceSane({ price: 12 }), false, 'a numeric price with no currency is not sane');
});

// ── Ledger ──────────────────────────────────────────────────────────────────

test('the usage ledger query is fixed, validated and read-only', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const sql = buildLedgerQuery([id], '2026-10-09');
  assert.match(sql, /^select user_id::text/);
  assert.equal(/;|insert|update|delete|drop/i.test(sql), false);
  assert.throws(() => buildLedgerQuery(["x'; drop table t;--"], '2026-10-09'), TypeError);
  assert.throws(() => buildLedgerQuery([id], "2026-10-09' or 1=1"), TypeError);
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.s`;
  assert.equal(decodeJwtSub(jwt), id);
  assert.equal(decodeJwtSub('not.a.jwt'), null);
});

test('the larger of explicit and ledger counts always wins; no ledger falls back to explicit', () => {
  const explicit = { imageMode: 10, commerceOnly: 4, imageModePerActorToday: { A: 5 } };
  const merged = mergePrior(explicit, { ok: true, imageMode: 12, commerceOnly: 3, imageModePerActorToday: { A: 4, B: 2 } });
  assert.deepEqual([merged.imageMode, merged.commerceOnly, merged.imageModePerActorToday.A, merged.imageModePerActorToday.B], [12, 4, 5, 2]);
  assert.equal(mergePrior(explicit, { ok: false }).source, 'explicit_only');
});

// ── The real client regions still exist in app.js ───────────────────────────

test('every app.js region the live harness executes still matches its markers', () => {
  for (const [name, get] of Object.entries(REGIONS)) {
    const code = get();
    assert.ok(code.length > 40, `${name} region is empty`);
  }
  assert.match(REGIONS.commerce(), /hydrateSelectedBatchCommerce\(item, \{/, 'the extracted commerce region is the selected-item hydrator');
  assert.match(REGIONS.attachEffect(), /attachScanPurchaseOptions\(savedId/, 'the extracted effect attaches late offers to a saved scan');
});

// ── Workflow hygiene ────────────────────────────────────────────────────────

test('the live workflow can only spend on an explicit, confirmed, staging dispatch', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'staging-scanner-live-certification.yml'), 'utf8');
  assert.match(yml, /if: github\.event_name == 'workflow_dispatch'/, 'a push may register the workflow but must never run the job');
  assert.match(yml, /environment: staging/);
  assert.match(yml, /permissions:\n  contents: read/);
  assert.match(yml, /push:\n    branches:\n      - test\/build35-scanner-live-certification-v1\n    paths:\n      - \.github\/workflows\/staging-scanner-live-certification\.yml/);
  assert.equal(/pull_request_target/.test(yml), false);
  assert.match(yml, /SCANNER_LIVE_CONFIRM: \$\{\{ inputs\.confirm \}\}/);
  assert.equal(/\$\{\{ inputs\.(phase|actor|confirm|prior_[a-z_]+) \}\}[^\n]*\n\s+(run|node)/.test(yml), false);
  for (const line of yml.split('\n').filter((l) => /uses: /.test(l))) {
    assert.match(line, /@[0-9a-f]{40} # v/, `action must be pinned by SHA: ${line.trim()}`);
  }
  assert.equal(/SERVICE_ROLE|service_role/i.test(yml), false, 'the workflow never touches a service-role key');
  assert.equal(/echo .*secrets\./.test(yml), false);
});

// ── A timed-out commerce request is retried once per garment and never re-spends Gemini ──

test('a first-attempt commerce timeout is retried once, without a selected-item request', { timeout: 120_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-live-retry-'));
  const { report: r } = await runner.main(['--phase', 'P2', '--dry-local', '--mock-timeout-first', '1', '--out', path.join(out, 'P2.json')], {});
  assert.equal(r.aborted, null);
  assert.deepEqual(r.summary.findings, [], JSON.stringify(r.summary.findings));
  const flow = r.results[0];
  assert.deepEqual(flow.commerce.retries.attempted.length, 1, 'exactly the one timed-out garment is retried');
  assert.equal(flow.commerce.retries.selectedItemRequestsDuringRetry, 0, 'a commerce retry must not re-spend identification');
  const retried = flow.items.filter((i) => i.commerce.attempts.length === 2);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].commerce.attempts[0].errorType, 'timeout');
  assert.equal(retried[0].commerce.attempts[0].offerCount, 0);
  assert.equal(retried[0].offers.length > 0, true, 'the retry recovered the shelf');
  assert.equal(flow.items.every((i) => i.commerce.uiStatus === 'success'), true);
  assert.equal(r.summary.requests.commerceOnly, 3, 'two garments + one retry');
  fs.rmSync(out, { recursive: true, force: true });
});

// ── Paired commerce replay: selects exactly the garments that timed out, spends no Gemini ──

test('the replay phase re-sends MODE B only for first-attempt timeouts recorded in the committed P1 evidence', { timeout: 120_000 }, async () => {
  const p1 = require(path.join(ROOT, 'docs', 'build35', 'scanner', 'evidence', 'P1-report.json'));
  const expected = require(path.join(KIT, 'lib', 'phases.js')).replayEvidenceFromReport(p1);
  assert.equal(expected.length, 4, 'P1 recorded exactly four first-attempt timeouts');
  assert.deepEqual(expected.map((e) => e.key).sort(), ['D:gown', 'O:unbound', 'T:hoodie', 'X:hoodie_left']);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-live-replay-'));
  const { report: r } = await runner.main(['--phase', 'R1', '--dry-local', '--out', path.join(out, 'R1.json')], {});
  assert.equal(r.aborted, null);
  assert.deepEqual(r.summary.findings, []);
  assert.equal(r.summary.requests.imageMode, 0, 'a commerce replay never spends identification');
  assert.equal(r.summary.requests.commerceOnly, 4);
  assert.equal(r.results[0].replayed.length, 4);
  assert.equal(r.results[0].replayed.every((x) => x.outcome === 'success' && x.offerCount > 0), true);
  fs.rmSync(out, { recursive: true, force: true });
});

// ── The whole six-phase plan fits the approved budget, dry-run against the mock ──

test('the planned phases fit the approved caps and the per-day ceiling', { timeout: 240_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-live-dry-'));
  const results = {};
  for (const phase of Object.keys(runner.PHASE_FIXTURES)) {
    const argv = ['--phase', phase, '--dry-local', '--out', path.join(out, `${phase}.json`), ...(phase === 'P5' ? ['--mock-funnel-off'] : [])];
    const { report: r } = await runner.main(argv, {});
    assert.equal(r.runMode, 'DRY_LOCAL_MOCK_NOT_EVIDENCE');
    assert.equal(r.aborted, null, `${phase} aborted`);
    assert.deepEqual(r.summary.findings, [], `${phase} produced integrity findings against the mock`);
    assert.equal(r.summary.requests.budgetRefused, 0);
    results[phase] = r.summary.requests;
  }
  const sum = (key) => Object.values(results).reduce((n, r) => n + r[key], 0);
  assert.ok(sum('imageMode') <= corpus.budget.imageModeRequestsTotal, `image-mode ${sum('imageMode')}`);
  assert.ok(sum('commerceOnly') <= corpus.budget.commerceOnlyRequestsTotal, `commerce-only ${sum('commerceOnly')}`);
  const day1 = results.P1.imageMode + results.P2.imageMode;
  const day2 = results.P3.imageMode + results.P4.imageMode + results.P5.imageMode + results.P6.imageMode; // 24; P7 (optional variance) is not on the critical path
  assert.ok(day1 <= corpus.budget.imageModeRequestsPerActorPerUtcDay, `day 1 uses ${day1}`);
  assert.ok(day2 <= corpus.budget.imageModeRequestsPerActorPerUtcDay, `day 2 uses ${day2}`);
  // The documented plan, so a phase edit that changes spend must change this test.
  assert.deepEqual(
    Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [v.imageMode, v.commerceOnly]])),
    { P1: [20, 12], P2: [4, 2], P3: [10, 5], P4: [7, 2], P5: [4, 0], P6: [3, 2], P7: [4, 1], R1: [0, 4] },
  );
  fs.rmSync(out, { recursive: true, force: true });
});
