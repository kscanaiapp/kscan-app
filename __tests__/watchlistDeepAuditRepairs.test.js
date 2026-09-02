// Build 34 Smart Watchlist — deep-audit repairs WL-01 … WL-08.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, and the Deno tests beside the Edge Function are not part of the
// governed suite. Anything that must hold at release time is asserted here.
//
// Where the logic can be EXECUTED it is executed (watchCurrency.ts,
// changeEngine.ts and watchRefreshObservation.ts are pure and loadable through
// the established loadTsModule/vm seam). index.ts cannot be: importing it runs
// Deno.serve at module load, so its invariants are asserted against source text,
// each paired with a negative control asserting the ABSENCE of the defective
// shape so a revert fails here rather than passing quietly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FN_DIR = 'supabase/functions/commerce-watch-refresh';
const INDEX = read(`${FN_DIR}/index.ts`);
const CONFIG = read(`${FN_DIR}/watchRefreshConfig.ts`);
const OBSERVATION = read(`${FN_DIR}/watchRefreshObservation.ts`);
const MIGRATION = read('supabase/migrations/20260902120000_watchlist_device_route_and_account_state.sql');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    Intl,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    RegExp,
    String,
    globalThis: {},
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const watchCurrency = loadTsModule(`${FN_DIR}/watchCurrency.ts`);
const changeEngine = loadTsModule(`${FN_DIR}/changeEngine.ts`);

/** Exactly how farfetch3Provider.ts / kicksCrewProvider.ts format a price. */
const adapterPrice = (amount, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);

// ══════════════════════════ WL-01 — currency identity ══════════════════════

test('WL-01: every currency the watch adapters can emit is resolved to itself', () => {
  const codes = [
    'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'HKD',
    'SGD', 'MXN', 'BRL', 'CHF', 'SEK', 'CNY', 'KRW', 'TWD',
  ];
  for (const code of codes) {
    assert.equal(
      watchCurrency.resolveObservedCurrency(adapterPrice(1299.99, code)),
      code,
      `${code} formatted as ${JSON.stringify(adapterPrice(1299.99, code))} must resolve to ${code}`,
    );
  }
});

test('WL-01 NEGATIVE CONTROL: the previous { $, £, €, ¥ } rule really did misread these', () => {
  // The defect, replicated exactly as canonicalCommerce.parseOfferPrice decides
  // currency. If this control ever stops finding mislabels, the repair above is
  // no longer testing anything and this file must be revisited.
  const legacyResolve = (text) => {
    for (const [symbol, code] of Object.entries({ $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' })) {
      if (text.includes(symbol)) return code;
    }
    const iso = text.match(/\b(USD|GBP|EUR|JPY|CAD|AUD)\b/i);
    return iso ? iso[1].toUpperCase() : null;
  };
  const mislabelled = ['CAD', 'AUD', 'NZD', 'HKD', 'MXN', 'BRL', 'CNY', 'CHF', 'SGD'].filter(
    (code) => legacyResolve(adapterPrice(1299.99, code)) !== code,
  );
  assert.deepEqual(
    mislabelled,
    ['CAD', 'AUD', 'NZD', 'HKD', 'MXN', 'BRL', 'CNY', 'CHF', 'SGD'],
    'the old rule must be shown to mislabel every one of these — that is the defect being repaired',
  );
  // And the repair must fix every single one of them.
  for (const code of mislabelled) {
    assert.equal(watchCurrency.resolveObservedCurrency(adapterPrice(1299.99, code)), code);
  }
});

test('WL-01: an unidentifiable currency resolves to null, never to a guess', () => {
  for (const text of ['1299.99', '', '   ', 'Price on request', null, undefined, 42]) {
    assert.equal(watchCurrency.resolveObservedCurrency(text), null, JSON.stringify(text));
  }
});

test('WL-01: unknown currency is NOT a match for the watch currency', () => {
  assert.equal(watchCurrency.observationMatchesWatchCurrency('1299.99', 'USD'), false);
  assert.equal(watchCurrency.observationMatchesWatchCurrency(adapterPrice(10, 'CAD'), 'USD'), false);
  assert.equal(watchCurrency.observationMatchesWatchCurrency(adapterPrice(10, 'USD'), 'USD'), true);
});

test('WL-01: the longer display prefix wins over the bare sigil', () => {
  assert.equal(watchCurrency.resolveObservedCurrency('CA$1,299.99'), 'CAD');
  assert.equal(watchCurrency.resolveObservedCurrency('A$1,299.99'), 'AUD');
  assert.equal(watchCurrency.resolveObservedCurrency('$1,299.99'), 'USD');
  // The adapters' non-Intl fallback shape, "1299.99 CAD", must read as CAD too.
  assert.equal(watchCurrency.resolveObservedCurrency('1299.99 CAD'), 'CAD');
});

test('WL-01: a foreign-currency observation reaches the change engine as currency_mismatch', () => {
  const observationModule = loadTsModule(`${FN_DIR}/watchRefreshObservation.ts`, {
    '../scan-identify/farfetch3Provider.ts': {
      enrichFarfetchProductByUrl: async () => ({ product: { price: adapterPrice(400, 'CAD') } }),
    },
    '../scan-identify/kicksCrewProvider.ts': { enrichKicksCrewProductByUrl: async () => ({ product: null }) },
    '../scan-identify/canonicalCommerce.ts': {
      parseOfferPrice: () => ({ value: 400, currency: 'USD' }), // the shared parser's wrong answer
    },
    './watchCurrency.ts': watchCurrency,
  });

  return observationModule
    .refreshWatchObservation({ source: 'farfetch', canonicalUrl: 'https://x', currency: 'USD' })
    .then((outcome) => {
      assert.equal(
        outcome.observation.status,
        'currency_mismatch',
        'a CAD answer to a USD watch must never be compared as USD',
      );
      // …and the engine must then change nothing and announce nothing.
      const result = changeEngine.evaluateWatchRefresh(
        {
          currency: 'USD',
          currentPriceAmount: 500,
          targetPriceAmount: 450,
          watchIntent: 'buy_under',
          targetReachedAt: null,
          lastStatus: 'available',
          consecutiveFailures: 0,
        },
        outcome.observation,
        { unavailableAfterFailures: 5, observedAt: '2026-09-02T00:00:00.000Z' },
      );
      assert.equal(result.event, null, 'no event may be raised from a cross-currency reading');
      assert.equal(result.newCurrentPriceAmount, 500, 'the stored price must not move');
      assert.equal(result.newTargetReachedAt, null, 'the target must not be marked reached');
    });
});

test('WL-01: an unreadable currency is a mismatch, not an assumed match', () => {
  const observationModule = loadTsModule(`${FN_DIR}/watchRefreshObservation.ts`, {
    '../scan-identify/farfetch3Provider.ts': {
      enrichFarfetchProductByUrl: async () => ({ product: { price: '1299.99' } }),
    },
    '../scan-identify/kicksCrewProvider.ts': { enrichKicksCrewProductByUrl: async () => ({ product: null }) },
    '../scan-identify/canonicalCommerce.ts': { parseOfferPrice: () => ({ value: 1299.99, currency: null }) },
    './watchCurrency.ts': watchCurrency,
  });
  return observationModule
    .refreshWatchObservation({ source: 'farfetch', canonicalUrl: 'https://x', currency: 'USD' })
    .then((outcome) => {
      assert.equal(outcome.observation.status, 'currency_mismatch');
      assert.equal(outcome.metadata.errorCode, 'unresolved_currency');
    });
});

test('WL-01 NEGATIVE CONTROL: the "?? watch.currency" fallback must not come back', () => {
  assert.doesNotMatch(
    OBSERVATION,
    /parsed\.currency\s*\?\?\s*watch\.currency/,
    'assuming the watch currency when the observed one is unreadable defeats the mismatch guard entirely',
  );
  assert.match(OBSERVATION, /resolveObservedCurrency\(result\.product\.price\)/);
  assert.match(INDEX, /resolveObservedCurrency\(listing\.price\)/, 'creation must store a resolved currency too');
  assert.doesNotMatch(INDEX, /p_currency:\s*parsedPrice\.currency/, 'the shared parser must not decide stored currency');
});

// ═══════════════ WL-02 / WL-03 — deletion race, event & push idempotency ═══

test('WL-02: the observation write cannot touch a deleted Watch', () => {
  assert.match(
    INDEX,
    /user_commerce_watches\?id=eq\.\$\{row\.id\}&user_id=eq\.\$\{row\.user_id\}&deleted_at=is\.null/,
    'the refresh PATCH must exclude tombstoned rows',
  );
});

test('WL-02 NEGATIVE CONTROL: the unfiltered PATCH shape must not return', () => {
  const patchTarget = INDEX.slice(INDEX.indexOf('const patchResponse'), INDEX.indexOf("method: 'PATCH'"));
  assert.ok(patchTarget.includes('deleted_at=is.null'), 'a PATCH without the tombstone filter mutates deleted watches');
});

test('WL-02: a push is sent only when the event was actually recorded', () => {
  assert.match(
    INDEX,
    /if \(eventRecorded\) \{\s*await deliverPushIfArmed\(row, result\.event\);/,
    'append refuses (P0002) for a deleted watch, so the append result is also the liveness check',
  );
  // The control that bites on a revert: the delivery call must be reachable
  // ONLY through the eventRecorded guard. An unconditional call is the defect —
  // it alerts on a Watch the user deleted while the provider call was in flight.
  const cycle = INDEX.slice(INDEX.indexOf('/** One refresh cycle'), INDEX.indexOf('// ── Tier 2'));
  const calls = cycle.match(/deliverPushIfArmed\(row, result\.event\)/g) ?? [];
  assert.equal(calls.length, 1, 'exactly one delivery call site in the refresh cycle');
  const guardAt = cycle.indexOf('if (eventRecorded) {');
  assert.ok(guardAt >= 0, 'the delivery must be guarded on the event having been recorded');
  assert.ok(
    guardAt < cycle.indexOf('deliverPushIfArmed(row, result.event)'),
    'the guard must precede the only call site',
  );
});

test('WL-03: a failed observation write ends the cycle without event or push', () => {
  const cycle = INDEX.slice(INDEX.indexOf('const patchResponse'), INDEX.indexOf('// ── Tier 2'));
  const guardAt = cycle.indexOf('if (!patchResponse.ok)');
  const appendAt = cycle.indexOf("rpc('append_user_commerce_watch_event'");
  const pushAt = cycle.indexOf('deliverPushIfArmed');
  assert.ok(guardAt >= 0, 'the failed-write guard must exist');
  assert.ok(guardAt < appendAt && guardAt < pushAt, 'it must precede both the event append and the push');
  const guardBody = cycle.slice(guardAt, appendAt);
  assert.match(guardBody, /return \{/, 'the cycle must RETURN on a failed write, not merely log and continue');
  assert.match(guardBody, /event: null/, 'and must report no event for that cycle');
});

test('WL-03: dedupe still rests on the state advance, so the guard is load-bearing', () => {
  // Same observed transition twice: the second pass must raise nothing once the
  // first pass' price has been committed. This is the ONLY dedupe mechanism —
  // there is no idempotency key on user_commerce_watch_events — which is why a
  // failed write must abort rather than announce.
  const base = {
    currency: 'USD',
    targetPriceAmount: 80,
    watchIntent: 'buy_under',
    targetReachedAt: null,
    lastStatus: 'available',
    consecutiveFailures: 0,
  };
  const observation = { status: 'resolved', priceAmount: 90, currency: 'USD' };
  const opts = { unavailableAfterFailures: 5, observedAt: '2026-09-02T00:00:00.000Z' };

  const first = changeEngine.evaluateWatchRefresh({ ...base, currentPriceAmount: 100 }, observation, opts);
  assert.equal(first.event.type, 'price_decreased');

  const second = changeEngine.evaluateWatchRefresh(
    { ...base, currentPriceAmount: first.newCurrentPriceAmount },
    observation,
    opts,
  );
  assert.equal(second.event, null, 'the same transition must not re-fire once the state advanced');

  // …and if the advance never committed, it DOES re-fire — the exact duplicate
  // event + duplicate push the guard exists to prevent.
  const repeatWithoutAdvance = changeEngine.evaluateWatchRefresh(
    { ...base, currentPriceAmount: 100 },
    observation,
    opts,
  );
  assert.equal(repeatWithoutAdvance.event.type, 'price_decreased');
});

test('WL-03: target_price_reached fires exactly once', () => {
  const opts = { unavailableAfterFailures: 5, observedAt: '2026-09-02T00:00:00.000Z' };
  const first = changeEngine.evaluateWatchRefresh(
    {
      currency: 'USD',
      currentPriceAmount: 100,
      targetPriceAmount: 80,
      watchIntent: 'buy_under',
      targetReachedAt: null,
      lastStatus: 'available',
      consecutiveFailures: 0,
    },
    { status: 'resolved', priceAmount: 75, currency: 'USD' },
    opts,
  );
  assert.equal(first.event.type, 'target_price_reached');
  const second = changeEngine.evaluateWatchRefresh(
    {
      currency: 'USD',
      currentPriceAmount: 75,
      targetPriceAmount: 80,
      watchIntent: 'buy_under',
      targetReachedAt: first.newTargetReachedAt,
      lastStatus: 'available',
      consecutiveFailures: 0,
    },
    { status: 'resolved', priceAmount: 70, currency: 'USD' },
    opts,
  );
  assert.notEqual(second.event?.type, 'target_price_reached', 'a further drop must not re-announce the target');
});

// ═════════════════ WL-04 — one live push route per physical device ═════════

test('WL-04: the device invariant is structural, not merely procedural', () => {
  assert.match(
    MIGRATION,
    /create unique index if not exists user_device_push_tokens_live_device_uidx\s+on public\.user_device_push_tokens \(device_id\)\s+where revoked_at is null/,
    'at most one live route per physical device must be unrepresentable',
  );
  // Pre-existing duplicates must be retired BEFORE the index is created, or the
  // migration cannot be applied to a database already carrying the bad state.
  assert.ok(
    MIGRATION.indexOf('set revoked_at = now()') < MIGRATION.indexOf('user_device_push_tokens_live_device_uidx'),
    'duplicates must be retired before the unique index is created',
  );
});

test('WL-04: the legitimate writers still retire competing rows before inserting', () => {
  // If either writer stopped retiring first, the new index would start rejecting
  // ordinary sign-ins instead of only the bad state.
  const registration = read('supabase/migrations/20260830190000_watchlist_push_token_actor_isolation.sql');
  assert.match(registration, /update public\.user_device_push_tokens\s+set revoked_at = now\(\)/);
  assert.match(registration, /device_id = p_device_id or push_token = p_push_token/);
  const claim = read('supabase/migrations/20260831120000_watchlist_device_ownership_claim.sql');
  assert.match(claim, /and device_id = p_device_id\s+and user_id <> p_user_id/);
});

// ══════════════ WL-05 — no response before the request body is drained ═════

test('WL-05: every path that answers without reading the body drains it first', () => {
  assert.match(INDEX, /async function drainRequestBody\(req: Request\)/);
  const entry = INDEX.slice(INDEX.indexOf('Deno.serve('));
  const methodGuard = entry.slice(entry.indexOf("req.method !== 'POST'"), entry.indexOf('requireWorkerSecret(req)'));
  assert.match(methodGuard, /drainRequestBody\(req\)/, '405 answers without reading a body');

  const workerBranch = entry.slice(entry.indexOf('requireWorkerSecret(req)'), entry.indexOf('let authUser'));
  assert.match(workerBranch, /drainRequestBody\(req\)/, 'the sweep is header-selected and never reads the body');

  const authBranch = entry.slice(entry.indexOf('let authUser'), entry.indexOf('let body:'));
  assert.match(authBranch, /drainRequestBody\(req\)/, 'the 401 path is the unauthenticated one and matters most');
});

test('WL-05: the drain discards rather than buffers, and never changes the answer', () => {
  const drain = INDEX.slice(INDEX.indexOf('async function drainRequestBody'), INDEX.indexOf('// ── Small bounded'));
  assert.match(drain, /getReader\(\)/);
  assert.match(drain, /MAX_DRAIN_BYTES/, 'the drain must be bounded');
  assert.match(drain, /catch \{/, 'a drain failure must never alter the response');
  assert.doesNotMatch(drain, /await req\.(json|text|arrayBuffer)\(\)/, 'the body must not be buffered into memory');
});

// ═══════════════════ WL-06 — the mutual-exclusion window has a floor ═══════

test('WL-06: MIN_REFRESH_INTERVAL_MS cannot be tuned below a provider cycle', () => {
  assert.match(
    CONFIG,
    /export const MIN_REFRESH_INTERVAL_MS = Math\.max\(\s*PROVIDER_CALL_CEILING_MS,/,
    'the claim window is the only stale-overwrite protection; it must not be collapsible by env var',
  );
  const ceiling = CONFIG.match(/const PROVIDER_CALL_CEILING_MS = ([^;]+);/);
  assert.ok(ceiling, 'the floor must be a named, reviewable constant');
  // The adapters abort at 4000ms; the floor must comfortably exceed that.
  const value = Number(eval(ceiling[1])); // eslint-disable-line no-eval -- a literal arithmetic expression from our own source
  assert.ok(value >= 4000 * 2, `the floor (${value}ms) must exceed the adapters' 4000ms deadline with headroom`);
});

test('WL-06: the adapters really do enforce the deadline the floor is reasoned against', () => {
  for (const rel of [
    'supabase/functions/scan-identify/farfetch3Provider.ts',
    'supabase/functions/scan-identify/kicksCrewProvider.ts',
  ]) {
    const src = read(rel);
    assert.match(src, /const PROVIDER_TIMEOUT_MS = 4_?000;/, `${rel} must carry the timeout the floor assumes`);
    assert.match(src, /controller\.abort\(\)/, `${rel} must actually abort on it`);
  }
});

test('WL-06: the unused deadline constant is labelled as inert, not as a control', () => {
  assert.match(CONFIG, /DOCUMENTATION, not an enforced control/,
    'REFRESH_CALL_DEADLINE_MS is imported by nothing; an operator must not mistake it for a live knob');
  const importedByFunction = INDEX.includes('REFRESH_CALL_DEADLINE_MS') || OBSERVATION.includes('REFRESH_CALL_DEADLINE_MS');
  assert.equal(importedByFunction, false, 'if it ever becomes live, this note must be removed');
});

// ═══════════ WL-07 — no background premium work for a deleting account ═════

test('WL-07: both claim RPCs require the owner account to be active', () => {
  assert.match(MIGRATION, /create or replace function public\.watchlist_actor_is_active\(p_user_id uuid\)/);
  const tier2 = MIGRATION.slice(MIGRATION.indexOf('function public.claim_watchable_commerce_watches'));
  const tier1 = MIGRATION.slice(MIGRATION.indexOf('function public.claim_user_commerce_watches_for_refresh'));
  assert.match(tier2, /public\.watchlist_actor_is_active\(user_id\)/, 'the background sweep must check it');
  assert.match(tier1, /public\.watchlist_actor_is_active\(p_user_id\)/, 'user-open refresh must check it too');
});

test('WL-07: the active test mirrors is_active_account and stays service-role only', () => {
  for (const status of ['pending', 'processing', 'completed', 'deactivated', 'purging', 'legal_hold', 'failed']) {
    assert.ok(MIGRATION.includes(`'${status}'`), `blocking deletion state ${status} must be covered`);
  }
  assert.match(MIGRATION, /coalesce\(p\.account_status, 'active'\) = 'active'/);
  assert.match(MIGRATION, /p\.account_locked_at is null/);
  assert.match(MIGRATION, /revoke all on function public\.watchlist_actor_is_active\(uuid\) from public, anon, authenticated/);
  assert.match(MIGRATION, /grant execute on function public\.watchlist_actor_is_active\(uuid\) to service_role/);
});

test('WL-07: deactivation suspends refresh — it never deletes Watch data', () => {
  assert.doesNotMatch(MIGRATION, /delete from public\.user_commerce_watch/i,
    'suspending background work must not destroy a restorable account\'s Watches');
  assert.doesNotMatch(MIGRATION, /update public\.user_commerce_watches\s+set (status|deleted_at)/i);
});

// ═════════════════════ WL-08 — bounded provider exposure ═══════════════════

test('WL-08: an actor cannot hold an unbounded number of refreshable Watches', () => {
  assert.match(CONFIG, /export const MAX_ACTIVE_WATCHES_PER_ACTOR = readIntEnv\(/);
  assert.match(INDEX, /MAX_ACTIVE_WATCHES_PER_ACTOR/, 'the ceiling must be enforced, not merely declared');
  assert.match(INDEX, /watch_limit_reached/, 'and refused truthfully');
  const create = INDEX.slice(INDEX.indexOf('async function handleCreate'), INDEX.indexOf('async function handleLifecycleAction'));
  assert.ok(
    create.indexOf('MAX_ACTIVE_WATCHES_PER_ACTOR') < create.indexOf("rpc('create_user_commerce_watch'"),
    'the ceiling must be checked BEFORE the row is created',
  );
});

test('WL-08: the ceiling counts only NEW rows, so re-watching stays idempotent', () => {
  const create = INDEX.slice(INDEX.indexOf('async function handleCreate'), INDEX.indexOf('async function handleLifecycleAction'));
  assert.match(
    create,
    /canonical_url=neq\./,
    'a user at the ceiling must still be able to retarget a listing they already watch',
  );
  assert.match(create, /deleted_at=is\.null/, 'deleted watches must not count toward a live ceiling');
});

test('WL-08: the ceiling is an operational control, not an invented product limit', () => {
  assert.match(CONFIG, /cost ceiling, not a product limit/i);
  const declared = CONFIG.match(/MAX_ACTIVE_WATCHES_PER_ACTOR = readIntEnv\('[^']+', (\d+)\)/);
  assert.ok(declared, 'the default must be readable');
  assert.ok(Number(declared[1]) >= 100, 'the default must sit far above any plausible real Watchlist');
});
