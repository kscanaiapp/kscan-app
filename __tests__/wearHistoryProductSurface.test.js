// BUILD 29 CLOSET V2 / S6 — WEAR-HISTORY PRODUCT SURFACE
//
// Covers the read contract, the ranking/honesty helpers, and the wiring of the
// two explicit wear actions. The S5 write-model invariants stay in
// wearHistoryContract.test.js; this file must not weaken them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const wear = loadTsModule('services/wearHistory.ts', {
  './supabaseClient': { supabase: {} },
});

const USER_A = '00000000-0000-4000-8000-00000000000a';

/**
 * Query double that records the filters it was given and replays a fixed row
 * set. Ordering and keyset filtering are asserted against the RECORDED calls,
 * because that is where a paging bug actually lives.
 */
function makeReadDb(rows, { session = { user: { id: USER_A } } } = {}) {
  const calls = { order: [], limit: null, or: null, eq: [], is: [] };
  const builder = {
    select() { return this; },
    eq(col, val) { calls.eq.push([col, val]); return this; },
    is(col, val) { calls.is.push([col, val]); return this; },
    order(col, opts) { calls.order.push([col, opts && opts.ascending]); return this; },
    or(expr) { calls.or = expr; return this; },
    limit(n) { calls.limit = n; return this; },
    // The real PostgREST builder is a thenable, so the chain stays mutable
    // right up to the await. A double that resolved at .limit() would break
    // any filter applied afterwards and hide a real query from assertions.
    then(resolve, reject) {
      const n = calls.limit == null ? rows.length : calls.limit;
      return Promise.resolve({ data: rows.slice(0, n), error: null }).then(resolve, reject);
    },
  };
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    from() { return builder; },
  };
  return { client, calls };
}

function eventRow(id, wornAt, items, extra = {}) {
  return {
    id,
    worn_at: wornAt,
    saved_look_id: null,
    saved_look_ref: null,
    source_item_id: null,
    wardrobe_wear_event_items: items.map((i) => ({
      source_item_id: i,
      source_type: 'closet_item',
      title_snapshot: `Title ${i}`,
      category_snapshot: 'Tops',
      deleted_at: null,
    })),
    ...extra,
  };
}

// ── Read contract ────────────────────────────────────────────────────────────

test('history is owner-scoped, bounded, and deterministically ordered', async () => {
  const rows = [eventRow('e3', '2026-08-14T10:00:00Z', ['a'])];
  const db = makeReadDb(rows);
  const result = await wear.getWearHistory({}, db.client);

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(db.calls.eq[0]), ['user_id', USER_A], 'must scope to the session user');
  assert.deepEqual(
    db.calls.order.map((o) => Array.from(o)),
    [['worn_at', false], ['id', false]],
    'ordering must be worn_at DESC then id DESC — the id tie-breaker prevents skipped/duplicated rows',
  );
  assert.equal(
    db.calls.limit,
    wear.WEAR_HISTORY_PAGE_SIZE + 1,
    'one extra row is fetched to detect a further page without a COUNT',
  );
});

test('a caller cannot request an unbounded page', async () => {
  const db = makeReadDb([]);
  await wear.getWearHistory({ pageSize: 100000 }, db.client);
  assert.equal(db.calls.limit, wear.WEAR_HISTORY_MAX_PAGE_SIZE + 1, 'page size must be clamped');

  const db2 = makeReadDb([]);
  await wear.getWearHistory({ pageSize: 0 }, db2.client);
  assert.ok(db2.calls.limit >= 2, 'a zero/negative page size must not produce an empty query');
});

test('the cursor filters strictly past the last row, including the tie-breaker', async () => {
  const db = makeReadDb([]);
  const cursorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await wear.getWearHistory(
    { cursor: { wornAt: '2026-08-14T10:00:00Z', id: cursorId } },
    db.client,
  );
  assert.match(db.calls.or, /worn_at\.lt\.2026-08-14T10:00:00Z/);
  assert.match(
    db.calls.or,
    new RegExp(`and\\(worn_at\\.eq\\.2026-08-14T10:00:00Z,id\\.lt\\.${cursorId}\\)`),
    'rows sharing worn_at must be split by id, or a row is skipped or repeated',
  );
});

test('a malformed cursor is rejected before it reaches the raw PostgREST filter', async () => {
  const db = makeReadDb([]);
  const result = await wear.getWearHistory(
    {
      cursor: {
        wornAt: '2026-08-14T10:00:00Z),user_id.neq.owner',
        id: 'not-a-uuid',
      },
    },
    db.client,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_input');
  assert.equal(db.calls.or, null, 'untrusted cursor text must never reach .or()');
});

test('one-item history fetches an extra row so hasMore is exact', async () => {
  const rows = [
    {
      wear_event_id: 'e1', source_item_id: 'item-a', source_type: 'closet_item',
      title_snapshot: 'A', category_snapshot: 'Tops',
      wardrobe_wear_events: { id: 'e1', worn_at: '2026-08-14T10:00:00Z', saved_look_id: null, saved_look_ref: null },
    },
    {
      wear_event_id: 'e2', source_item_id: 'item-a', source_type: 'closet_item',
      title_snapshot: 'A', category_snapshot: 'Tops',
      wardrobe_wear_events: { id: 'e2', worn_at: '2026-08-13T10:00:00Z', saved_look_id: null, saved_look_ref: null },
    },
  ];
  const db = makeReadDb(rows);
  const result = await wear.getItemWearHistory('item-a', { limit: 1 }, db.client);
  assert.equal(db.calls.limit, 2);
  assert.equal(result.page.entries.length, 1);
  assert.equal(result.page.hasMore, true);

  const exact = makeReadDb(rows.slice(0, 1));
  const exactResult = await wear.getItemWearHistory('item-a', { limit: 1 }, exact.client);
  assert.equal(exactResult.page.hasMore, false, 'exactly one row is not evidence of another page');
});

test('a full page advertises a next cursor anchored on the last visible row', async () => {
  const rows = [];
  for (let i = 0; i < wear.WEAR_HISTORY_PAGE_SIZE + 1; i += 1) {
    rows.push(eventRow(`e${i}`, `2026-08-${String(14 - (i % 10)).padStart(2, '0')}T10:00:00Z`, ['a']));
  }
  const db = makeReadDb(rows);
  const result = await wear.getWearHistory({}, db.client);

  assert.equal(result.page.entries.length, wear.WEAR_HISTORY_PAGE_SIZE, 'the extra row is not shown');
  assert.equal(result.page.hasMore, true);
  const last = result.page.entries[result.page.entries.length - 1];
  assert.equal(result.page.nextCursor.id, last.id);
  assert.equal(result.page.nextCursor.wornAt, last.wornAt);
});

test('a short page reports no further pages and no cursor', async () => {
  const db = makeReadDb([eventRow('e1', '2026-08-14T10:00:00Z', ['a'])]);
  const result = await wear.getWearHistory({}, db.client);
  assert.equal(result.page.hasMore, false);
  assert.equal(result.page.nextCursor, null);
});

test('an empty history is an empty page, not an error', async () => {
  const db = makeReadDb([]);
  const result = await wear.getWearHistory({}, db.client);
  assert.equal(result.ok, true);
  assert.equal(result.page.entries.length, 0);
  assert.equal(result.page.nextCursor, null);
});

test('an unauthenticated read is refused rather than returning another user data', async () => {
  const db = makeReadDb([eventRow('e1', '2026-08-14T10:00:00Z', ['a'])], { session: null });
  const result = await wear.getWearHistory({}, db.client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthenticated');
});

test('soft-deleted garment relationships are excluded from an entry', async () => {
  const row = eventRow('e1', '2026-08-14T10:00:00Z', ['a', 'b']);
  row.wardrobe_wear_event_items[1].deleted_at = '2026-08-15T00:00:00Z';
  const db = makeReadDb([row]);
  const result = await wear.getWearHistory({}, db.client);
  assert.equal(result.page.entries[0].items.length, 1);
});

test('a deleted look degrades to a dead reference rather than vanishing or faking one', async () => {
  const row = eventRow('e1', '2026-08-14T10:00:00Z', ['a'], {
    saved_look_id: null, // FK nulled by the deletion
    saved_look_ref: 'look-1', // durable identity survives
  });
  const db = makeReadDb([row]);
  const result = await wear.getWearHistory({}, db.client);
  const entry = result.page.entries[0];

  assert.equal(entry.kind, 'saved_look', 'it is still a look wear');
  assert.equal(entry.savedLookRef, 'look-1');
  assert.equal(entry.savedLookLive, false, 'the UI must be able to tell the look is gone');
  assert.equal(entry.items.length, 1, 'the garments worn that day are still readable');
});

test('statistics are a separate bounded query, not a fold over the visible page', async () => {
  const db = makeReadDb([
    { id: 'e1', worn_at: '2026-08-14T10:00:00Z', wardrobe_wear_event_items: [{ source_item_id: 'a', deleted_at: null }] },
  ]);
  const result = await wear.getWearStats({}, db.client);
  assert.equal(result.ok, true);
  assert.equal(db.calls.limit, wear.WEAR_STATS_SCAN_LIMIT + 1);
  assert.equal(result.truncated, false);
});

test('a truncated statistics scan is reported so a sample is not shown as a ranking', async () => {
  const rows = [];
  for (let i = 0; i < wear.WEAR_STATS_SCAN_LIMIT + 1; i += 1) {
    rows.push({
      id: `e${i}`,
      worn_at: '2026-08-14T10:00:00Z',
      wardrobe_wear_event_items: [{ source_item_id: `item-${i}`, deleted_at: null }],
    });
  }
  const db = makeReadDb(rows);
  const result = await wear.getWearStats({}, db.client);
  assert.equal(result.truncated, true);
});

// ── Ranking honesty ──────────────────────────────────────────────────────────

test('ranking ties are stable rather than arbitrary', () => {
  const stats = [
    { sourceItemId: 'c', timesWorn: 2, lastWornAt: null },
    { sourceItemId: 'a', timesWorn: 2, lastWornAt: null },
    { sourceItemId: 'b', timesWorn: 2, lastWornAt: null },
  ];
  const first = wear.rankByWear(stats, 'most', 3).map((s) => s.sourceItemId);
  const again = wear.rankByWear([...stats].reverse(), 'most', 3).map((s) => s.sourceItemId);
  assert.deepEqual(Array.from(first), ['a', 'b', 'c']);
  assert.deepEqual(
    Array.from(again),
    Array.from(first),
    'equally worn garments must not swap places between renders',
  );
});

test('most and least worn are opposite ends of the same data', () => {
  const stats = [
    { sourceItemId: 'a', timesWorn: 9, lastWornAt: null },
    { sourceItemId: 'b', timesWorn: 1, lastWornAt: null },
    { sourceItemId: 'c', timesWorn: 5, lastWornAt: null },
  ];
  assert.equal(wear.rankByWear(stats, 'most', 1)[0].sourceItemId, 'a');
  assert.equal(wear.rankByWear(stats, 'least', 1)[0].sourceItemId, 'b');
});

test('a wardrobe too small to rank is refused a ranking', () => {
  assert.equal(wear.rankingIsMeaningful([]), false);
  assert.equal(wear.rankingIsMeaningful([{ sourceItemId: 'a', timesWorn: 1, lastWornAt: null }]), false);
  assert.equal(
    wear.rankingIsMeaningful([
      { sourceItemId: 'a', timesWorn: 1, lastWornAt: null },
      { sourceItemId: 'b', timesWorn: 1, lastWornAt: null },
      { sourceItemId: 'c', timesWorn: 1, lastWornAt: null },
    ]),
    true,
  );
});

// ── Legacy honesty ───────────────────────────────────────────────────────────

test('a pre-tracking item is never described as never worn', () => {
  const state = wear.describeWearState({
    timesWorn: 0,
    itemAddedAt: '2026-01-01T00:00:00Z',
    trackingStartedAt: wear.WEAR_TRACKING_STARTED_AT,
  });
  assert.equal(
    state,
    'unknown_legacy',
    'the user may well have worn it; absence of a record is not evidence of absence',
  );
});

test('an item added after tracking started can honestly report no wears', () => {
  const state = wear.describeWearState({
    timesWorn: 0,
    itemAddedAt: '2026-08-20T00:00:00Z',
    trackingStartedAt: wear.WEAR_TRACKING_STARTED_AT,
  });
  assert.equal(state, 'none_recorded');
});

test('an item with an unknown added date falls back to the honest label', () => {
  assert.equal(
    wear.describeWearState({
      timesWorn: 0,
      itemAddedAt: null,
      trackingStartedAt: wear.WEAR_TRACKING_STARTED_AT,
    }),
    'unknown_legacy',
  );
});

test('a worn item reports worn regardless of when it was added', () => {
  assert.equal(
    wear.describeWearState({
      timesWorn: 3,
      itemAddedAt: '2020-01-01T00:00:00Z',
      trackingStartedAt: wear.WEAR_TRACKING_STARTED_AT,
    }),
    'worn',
  );
});

// ── Not worn recently ────────────────────────────────────────────────────────

test('the minimum-age guard survives into the product surface', () => {
  const result = wear.itemsNotWornSince(
    [
      { sourceItemId: 'new', addedAt: '2026-08-10T00:00:00Z' },
      { sourceItemId: 'old', addedAt: '2026-01-01T00:00:00Z' },
    ],
    [],
    { since: '2026-07-15T00:00:00Z', minimumAgeDays: 30, now: '2026-08-14T00:00:00Z' },
  );
  assert.deepEqual(Array.from(result), ['old'], 'a four-day-old item is not neglected');
});

// ── UI wiring (source-level) ─────────────────────────────────────────────────

const library = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
const lookDetail = fs.readFileSync(path.join(ROOT, 'app/looks/[id].tsx'), 'utf8');
const historyScreen = fs.readFileSync(path.join(ROOT, 'app/wear-history.tsx'), 'utf8');
const woreThis = fs.readFileSync(path.join(ROOT, 'components/closet/WoreThisButton.tsx'), 'utf8');

test('Closet exposes Wore this and a Wear History entry point', () => {
  assert.match(library, /testID="closet-wore-this"/);
  assert.match(library, /testID="closet-wear-history-button"/);
  assert.match(library, /logItemWear\(/);
});

test('the Wear History entry point never displaces Mirror Selfie', () => {
  const mirrorAt = library.indexOf('closet-mirror-selfie-button');
  const wearAt = library.indexOf('closet-wear-history-button');
  assert.ok(mirrorAt > 0 && wearAt > 0);
  assert.ok(
    mirrorAt < wearAt,
    'Mirror Selfie must remain the first action under the Closet header',
  );
});

test('the Saved Look surface exposes exactly one look-level wear action', () => {
  assert.match(lookDetail, /testID="look-wore-this"/);
  assert.match(lookDetail, /logLookWear\(/);
  assert.equal(
    (lookDetail.match(/logLookWear\(/g) || []).length,
    1,
    'one action, one call site — a second would risk two events for one wear',
  );
});

test('no UI queries the wear tables directly', () => {
  for (const [name, src] of [
    ['library', library],
    ['look detail', lookDetail],
    ['wear history screen', historyScreen],
  ]) {
    assert.doesNotMatch(
      src,
      /from\(['"]wardrobe_wear/,
      `${name} must go through the governed service, not query Supabase directly`,
    );
  }
});

test('no UI reads the legacy local counter as authority', () => {
  for (const src of [library, historyScreen, lookDetail]) {
    assert.doesNotMatch(src, /loadWearTracking|markWornToday|wearCount/);
  }
});

test('the wear action guards against double submission before reaching the service', () => {
  assert.match(woreThis, /inFlight\.current/, 'a ref guard, since state updates are async');
  assert.match(woreThis, /disabled=\{disabled\}/);
  assert.match(woreThis, /accessibilityState=\{\{ disabled, busy: isPending \}\}/);
});

test('the wear action never claims success before the service acknowledges', () => {
  // 'recorded' may only be set after the awaited result reports ok.
  const okBranch = woreThis.slice(woreThis.indexOf('const result = await onLogWear()'));
  const recordedAt = okBranch.indexOf("setStatus(result.deduplicated ? 'already' : 'recorded')");
  const errorReturnAt = okBranch.indexOf('return;');
  assert.ok(recordedAt > errorReturnAt, 'the failure path must exit before any success state');
  assert.match(woreThis, /already: 'Already logged'/, 'a deduplicated retry must read differently');
});

test('the history screen states its limits instead of overstating them', () => {
  assert.match(historyScreen, /wear-stats-insufficient/);
  assert.match(historyScreen, /wear-stats-truncated/);
  assert.match(historyScreen, /A look you no longer have/);
});

test('private wear state is actor-and-epoch stamped before it can render', () => {
  for (const src of [library, historyScreen]) {
    assert.match(src, /createActorRequest\(/);
    assert.match(src, /isActorRequestCurrent\(/);
  }
  assert.match(historyScreen, /stateActorStamp === actorStamp/);
  assert.match(historyScreen, /requestSequenceRef\.current/);
  assert.match(library, /actorEpoch/);
  assert.match(library, /wearStatsRequestSeqRef\.current/);
});

test('history entries render the point-in-time snapshot, not current contents', () => {
  assert.match(historyScreen, /titleSnapshot/);
  assert.doesNotMatch(
    historyScreen,
    /getLookDetail|loadClosetTyped/,
    'resolving the live object would let a later edit rewrite history',
  );
});

test('the actions and history rows carry accessible roles and labels', () => {
  assert.match(woreThis, /accessibilityRole="button"/);
  assert.match(woreThis, /accessibilityLabel=/);
  assert.match(woreThis, /minHeight: 44/, 'accessible hit target');
  assert.match(historyScreen, /accessibilityRole="text"/);
  assert.match(historyScreen, /accessibilityLabel=\{`\$\{formatWornAt/);
  assert.match(library, /accessibilityLabel="See what you have worn and when"/);
});

test('user-facing copy stays fashion-oriented, not database-oriented', () => {
  // Comments are stripped first: internal vocabulary is allowed to be
  // technical, and only what a user can actually read is under test.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const src of [woreThis, historyScreen]) {
    const visible = stripComments(src);
    assert.doesNotMatch(visible, /['"`][^'"`]*wear event[^'"`]*['"`]/i);
    assert.doesNotMatch(visible, /['"`][^'"`]*wardrobe_wear[^'"`]*['"`]/i);
    assert.doesNotMatch(visible, /['"`][^'"`]*event log[^'"`]*['"`]/i);
  }
  assert.match(woreThis, /idle: 'Wore this'/);
});

test('Cost Per Wear is absent from every S6 surface', () => {
  for (const src of [library, lookDetail, historyScreen, woreThis]) {
    assert.doesNotMatch(src, /costPerWear|CostPerWear|cost per wear/i);
  }
});
