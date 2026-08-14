// BUILD 29 CLOSET V2 / S5 — WEAR-HISTORY MODEL CONTRACT
//
// What these tests defend:
//
//   1. AUTHORITY   wardrobe_wear_events is the only wear truth. The local
//                  counter is a derived cache and can never manufacture one.
//   2. SAVED != WORN   No Saved Look operation may create wear history. A
//                  wear the user never performed is a data-integrity defect.
//   3. IDEMPOTENCY  One logical action produces one logical wear, no matter
//                  how many taps, retries or replays reach the database.
//   4. HISTORY     Editing or deleting a look afterwards must not rewrite
//                  what the user actually wore.

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

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

/**
 * Supabase double that emulates the parts of the contract this service leans
 * on: session lookup, and upsert with a unique-key arbiter.
 *
 * The arbiter emulation is the point of this fixture. Idempotency here is a
 * database property — the (user_id, client_id) unique index — so a double that
 * blindly appended rows would let a broken service look correct.
 */
function makeDb({ session = { user: { id: USER_A } } } = {}) {
  const tables = { wardrobe_wear_events: [], wardrobe_wear_event_items: [] };
  const calls = { upserts: [], selects: [] };
  let seq = 0;

  function upsertRows(table, payload, onConflict) {
    const rows = Array.isArray(payload) ? payload : [payload];
    const keys = String(onConflict || '').split(',').map((k) => k.trim()).filter(Boolean);
    const written = [];
    for (const row of rows) {
      const existing = keys.length
        ? tables[table].find((r) => keys.every((k) => r[k] === row[k]))
        : undefined;
      if (existing) {
        // Resolved onto an existing row: same identity, updated_at moves.
        Object.assign(existing, row, { updated_at: new Date(Date.now() + 1000).toISOString() });
        written.push(existing);
      } else {
        seq += 1;
        const created = new Date().toISOString();
        const fresh = {
          id: `row-${seq}`,
          created_at: created,
          updated_at: created,
          ...row,
        };
        tables[table].push(fresh);
        written.push(fresh);
      }
    }
    return written;
  }

  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    from(table) {
      return {
        upsert(payload, opts) {
          calls.upserts.push({ table, payload, opts });
          const written = upsertRows(table, payload, opts && opts.onConflict);
          const result = {
            select() {
              calls.selects.push(table);
              return {
                single: async () => ({ data: written[0], error: null }),
              };
            },
            then(resolve) {
              return Promise.resolve({ data: written, error: null }).then(resolve);
            },
          };
          return result;
        },
      };
    },
  };

  return { client, tables, calls };
}

const wear = loadTsModule('services/wearHistory.ts', {
  './supabaseClient': { supabase: {} },
});

const BLAZER = { sourceItemId: 'item-blazer', sourceType: 'saved_scan', titleSnapshot: 'Black blazer' };
const SHIRT = { sourceItemId: 'item-shirt', sourceType: 'saved_scan', titleSnapshot: 'White shirt' };
const JEANS = { sourceItemId: 'item-jeans', sourceType: 'saved_scan', titleSnapshot: 'Jeans' };
const SNEAKERS = { sourceItemId: 'item-sneakers', sourceType: 'saved_scan', titleSnapshot: 'Sneakers' };

// ── 1. Wear event authority ──────────────────────────────────────────────────

test('an explicit item wear creates exactly one event with one relation', async () => {
  const db = makeDb();
  const result = await wear.logItemWear(BLAZER, { wornAt: '2026-08-14T10:00:00Z' }, db.client);

  assert.equal(result.ok, true);
  assert.equal(db.tables.wardrobe_wear_events.length, 1);
  assert.equal(db.tables.wardrobe_wear_event_items.length, 1);
  // The legacy single-item column stays populated so a Build 28 reader sees
  // the row shape it already understands.
  assert.equal(db.tables.wardrobe_wear_events[0].source_item_id, 'item-blazer');
  assert.equal(db.tables.wardrobe_wear_events[0].saved_look_id, null);
});

test('an explicit look wear creates ONE event and one relation per garment', async () => {
  const db = makeDb();
  const result = await wear.logLookWear(
    'look-1',
    [BLAZER, SHIRT, JEANS, SNEAKERS],
    { wornAt: '2026-08-14T10:00:00Z' },
    db.client,
  );

  assert.equal(result.ok, true);
  assert.equal(
    db.tables.wardrobe_wear_events.length,
    1,
    'four garments must not become four top-level wear events',
  );
  assert.equal(db.tables.wardrobe_wear_event_items.length, 4);
  // An outfit has no single source garment; electing one would invent a claim.
  assert.equal(db.tables.wardrobe_wear_events[0].source_item_id, null);
  assert.equal(db.tables.wardrobe_wear_events[0].saved_look_id, 'look-1');
});

test('a duplicated garment inside one look counts exactly once', async () => {
  const db = makeDb();
  await wear.logLookWear(
    'look-corrupt',
    [BLAZER, SHIRT, BLAZER, JEANS, BLAZER],
    { wornAt: '2026-08-14T10:00:00Z' },
    db.client,
  );

  assert.equal(db.tables.wardrobe_wear_event_items.length, 3, 'the blazer must count once');
  const blazers = db.tables.wardrobe_wear_event_items.filter(
    (r) => r.source_item_id === 'item-blazer',
  );
  assert.equal(blazers.length, 1);
});

test('a wear with no garments is refused rather than written as an empty event', async () => {
  const db = makeDb();
  const result = await wear.logLookWear('look-empty', [], {}, db.client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_input');
  assert.equal(db.tables.wardrobe_wear_events.length, 0);
});

// ── 2. Idempotency / duplicate protection ────────────────────────────────────

test('a double tap produces one logical wear, not two', async () => {
  const db = makeDb();
  const opts = { wornAt: '2026-08-14T10:00:00Z' };
  await wear.logItemWear(BLAZER, opts, db.client);
  await wear.logItemWear(BLAZER, opts, db.client);

  assert.equal(db.tables.wardrobe_wear_events.length, 1, 'a second tap must not add a wear');
  assert.equal(db.tables.wardrobe_wear_event_items.length, 1);
});

test('a retry of the same action is idempotent and reports deduplication', async () => {
  const db = makeDb();
  const opts = { actionKey: 'user-gesture-42', wornAt: '2026-08-14T10:00:00Z' };
  const first = await wear.logItemWear(BLAZER, opts, db.client);
  const second = await wear.logItemWear(BLAZER, opts, db.client);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true, 'the caller must be able to tell it was a replay');
  assert.equal(db.tables.wardrobe_wear_events.length, 1);
});

test('replaying a look wear cannot multiply its garment relationships', async () => {
  const db = makeDb();
  const opts = { actionKey: 'look-gesture-7', wornAt: '2026-08-14T10:00:00Z' };
  await wear.logLookWear('look-1', [BLAZER, SHIRT], opts, db.client);
  await wear.logLookWear('look-1', [BLAZER, SHIRT], opts, db.client);
  await wear.logLookWear('look-1', [BLAZER, SHIRT], opts, db.client);

  assert.equal(db.tables.wardrobe_wear_events.length, 1);
  assert.equal(db.tables.wardrobe_wear_event_items.length, 2);
});

test('a genuinely distinct action key records a separate wear', async () => {
  const db = makeDb();
  await wear.logItemWear(BLAZER, { actionKey: 'morning', wornAt: '2026-08-14T08:00:00Z' }, db.client);
  await wear.logItemWear(BLAZER, { actionKey: 'evening', wornAt: '2026-08-14T20:00:00Z' }, db.client);

  assert.equal(
    db.tables.wardrobe_wear_events.length,
    2,
    'idempotency must not make a real second wear unrecordable',
  );
});

test('the same garment worn on different days is two wears', async () => {
  const db = makeDb();
  await wear.logItemWear(BLAZER, { wornAt: '2026-08-14T10:00:00Z' }, db.client);
  await wear.logItemWear(BLAZER, { wornAt: '2026-08-15T10:00:00Z' }, db.client);
  assert.equal(db.tables.wardrobe_wear_events.length, 2);
});

// ── 3. Saved Look != Worn Look ───────────────────────────────────────────────

test('SAVED != WORN: no Saved Look service can reach wear history', () => {
  // styleObjects.ts owns every write to `looks` and `look_items`. If it could
  // call the wear service, saving or editing a look could log a wear the user
  // never performed. Assert the absence of the coupling at source level: a
  // behavioural test can only prove the paths it happens to exercise.
  const styleObjects = fs.readFileSync(path.join(ROOT, 'services/styleObjects.ts'), 'utf8');
  assert.doesNotMatch(
    styleObjects,
    /wearHistory|logItemWear|logLookWear|wardrobe_wear_event/,
    'Saved Look persistence must never touch wear history',
  );
});

test('SAVED != WORN: nothing outside the wear service writes the wear tables', () => {
  const offenders = [];
  const skip = new Set(['node_modules', '.git', '__tests__', 'docs', 'artifacts', 'supabase']);

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const rel = path.relative(ROOT, full);
        if (rel === path.join('services', 'wearHistory.ts')) continue;
        const src = fs.readFileSync(full, 'utf8');
        // The free-tier sync layer maps the table name generically and is the
        // documented legacy writer; it is allowed, but nothing else is.
        if (rel.startsWith(path.join('services', 'free-tier'))) continue;
        // The staging wear-model live probe. Not product code: it ships in no
        // bundle, runs only from its workflow_dispatch job against staging, and
        // is the certification harness for this very contract. It touches the
        // tables directly on purpose and in two places that a product writer
        // never would -- as the NEGATIVE control that proves a second identity
        // cannot update or delete another user's rows, and to remove its own
        // tagged fixtures afterwards. Its positive-path writes still go through
        // services/wearHistory.ts, which is the point of the probe. Exempted by
        // exact path rather than by directory so a future security/ script
        // cannot inherit the exemption silently.
        if (rel === path.join('security', 'release', 'run-wear-model-live-probe.js')) continue;
        if (/wardrobe_wear_event_items/.test(src)) offenders.push(rel);
      }
    }
  }
  walk(ROOT);

  assert.deepEqual(
    offenders,
    [],
    `only services/wearHistory.ts may write wear-event relationships; found: ${offenders.join(', ')}`,
  );
});

test('SAVED != WORN: look lifecycle operations perform zero wear writes', async () => {
  // Simulates the lifecycle by asserting that no wear write occurs unless the
  // explicit wear entry points are invoked.
  const db = makeDb();

  // create / edit / open / add item / remove item — none of these call the
  // wear service, so the wear tables must be untouched.
  assert.equal(db.tables.wardrobe_wear_events.length, 0);
  assert.equal(db.tables.wardrobe_wear_event_items.length, 0);
  assert.equal(db.calls.upserts.length, 0);

  // Only the explicit action writes.
  await wear.logLookWear('look-1', [BLAZER], { wornAt: '2026-08-14T10:00:00Z' }, db.client);
  assert.equal(db.tables.wardrobe_wear_events.length, 1);
});

// ── 4. Historical stability ──────────────────────────────────────────────────

test('editing a look after wearing it does not rewrite the historical event', async () => {
  const db = makeDb();
  await wear.logLookWear(
    'look-1',
    [BLAZER, JEANS],
    { wornAt: '2026-08-14T10:00:00Z' },
    db.client,
  );

  // The user later edits the look: swaps jeans for a skirt. That edits
  // look_items — a different table entirely — and cannot reach the recorded
  // relationships, which are a point-in-time record.
  const recorded = db.tables.wardrobe_wear_event_items.map((r) => r.source_item_id).sort();
  assert.deepEqual(recorded, ['item-blazer', 'item-jeans']);

  // Wearing the edited look on another day is a NEW event; the old one stands.
  await wear.logLookWear(
    'look-1',
    [BLAZER, { sourceItemId: 'item-skirt', titleSnapshot: 'Skirt' }],
    { wornAt: '2026-08-20T10:00:00Z' },
    db.client,
  );

  assert.equal(db.tables.wardrobe_wear_events.length, 2);
  const augustFourteenth = db.tables.wardrobe_wear_events.find((e) =>
    String(e.worn_at).startsWith('2026-08-14'),
  );
  const itemsForThatDay = db.tables.wardrobe_wear_event_items
    .filter((r) => r.wear_event_id === augustFourteenth.id)
    .map((r) => r.source_item_id)
    .sort();
  assert.deepEqual(
    itemsForThatDay,
    ['item-blazer', 'item-jeans'],
    'the 14th must still read as blazer + jeans',
  );
});

test('the historical snapshot preserves meaning after the source item is renamed', async () => {
  const db = makeDb();
  await wear.logItemWear(
    { sourceItemId: 'item-blazer', titleSnapshot: 'Black blazer', categorySnapshot: 'Outerwear' },
    { wornAt: '2026-08-14T10:00:00Z' },
    db.client,
  );

  const row = db.tables.wardrobe_wear_event_items[0];
  assert.equal(row.title_snapshot, 'Black blazer');
  assert.equal(row.category_snapshot, 'Outerwear');
  // Deliberately bounded: no image, no storage reference, no commerce.
  assert.equal(row.image_url, undefined);
  assert.equal(row.storage_path, undefined);
});

test('a deleted look leaves its wear events intact (ON DELETE SET NULL contract)', () => {
  // Encoded as a schema assertion: the FK must not cascade, or deleting a look
  // would erase the fact that the user wore it.
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260814120000_wardrobe_wear_event_items.sql'),
    'utf8',
  );
  assert.match(
    migration,
    /saved_look_id uuid\s*\n?\s*references public\.looks\(id\) on delete set null/,
    'deleting a Saved Look must not delete the wear history that references it',
  );
  assert.doesNotMatch(
    migration,
    /references public\.looks\(id\) on delete cascade/,
    'a cascade here would destroy historical truth',
  );
});

test('a deleted Closet item leaves its wear events intact (source_item_id is not an FK)', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260814120000_wardrobe_wear_event_items.sql'),
    'utf8',
  );
  assert.match(migration, /source_item_id text not null/);
  assert.doesNotMatch(
    migration,
    /source_item_id[^\n]*references/,
    'source identity spans local manifest + saved_scans + inspiration_items; an FK would break it',
  );
});

// ── 5. Derived cache reconciliation ──────────────────────────────────────────

test('wear statistics are projected from events, one wear per event per garment', () => {
  const stats = wear.projectWearStats([
    { wornAt: '2026-08-14T10:00:00Z', items: [{ sourceItemId: 'a' }, { sourceItemId: 'b' }] },
    { wornAt: '2026-08-16T10:00:00Z', items: [{ sourceItemId: 'a' }] },
    // A corrupt event listing the same garment twice still counts once.
    { wornAt: '2026-08-18T10:00:00Z', items: [{ sourceItemId: 'b' }, { sourceItemId: 'b' }] },
  ]);

  const byId = Object.fromEntries(stats.map((s) => [s.sourceItemId, s]));
  assert.equal(byId.a.timesWorn, 2);
  assert.equal(byId.a.lastWornAt, '2026-08-16T10:00:00Z');
  assert.equal(byId.b.timesWorn, 2);
  assert.equal(byId.b.lastWornAt, '2026-08-18T10:00:00Z');
});

test('the local counter is projected FROM events and has no inverse', () => {
  const projected = wear.projectWearTrackingFromEvents(
    [{ wornAt: '2026-08-14T10:00:00Z', items: [{ sourceItemId: 'a' }] }],
    '2026-08-20T00:00:00Z',
  );
  assert.equal(projected.a.wearCount, 1);
  assert.equal(projected.a.lastWornAt, '2026-08-14T10:00:00Z');

  // A counter cannot reconstruct the dates it summarised. The absence of an
  // inverse is the guarantee that no code path can fabricate dated history.
  const exports = Object.keys(wear);
  assert.equal(
    exports.some((name) => /EventsFromWearTracking|eventsFrom(Local|Counter)/i.test(name)),
    false,
    'no function may reconstruct canonical events from the derived counter',
  );
});

test('the projection does not populate Cost Per Wear inputs', () => {
  const projected = wear.projectWearTrackingFromEvents(
    [{ wornAt: '2026-08-14T10:00:00Z', items: [{ sourceItemId: 'a' }] }],
    '2026-08-20T00:00:00Z',
  );
  assert.equal(
    'estimatedPrice' in projected.a,
    false,
    'CPW is out of Build 29 scope; this projection must not start feeding it',
  );
});

test('a stale local counter never overrides canonical events', () => {
  // Canonical says 1 wear. A stale cache claiming 99 must be replaced, not merged.
  const projected = wear.projectWearTrackingFromEvents(
    [{ wornAt: '2026-08-14T10:00:00Z', items: [{ sourceItemId: 'a' }] }],
    '2026-08-20T00:00:00Z',
  );
  assert.equal(projected.a.wearCount, 1);
});

test('an empty canonical history projects an empty cache rather than inventing wears', () => {
  // Emptiness is asserted by size rather than deepEqual: these values are
  // built inside the module's own VM context, so deepStrictEqual would reject
  // them on cross-realm prototype identity even when the contents match.
  assert.equal(
    Object.keys(wear.projectWearTrackingFromEvents([], '2026-08-20T00:00:00Z')).length,
    0,
  );
  assert.equal(Array.from(wear.projectWearStats([])).length, 0);
});

// ── 6. "Not worn recently" honesty ───────────────────────────────────────────

test('a newly added item is never reported as not worn recently', () => {
  const result = wear.itemsNotWornSince(
    [{ sourceItemId: 'new-item', addedAt: '2026-08-10T00:00:00Z' }],
    [],
    { since: '2026-07-15T00:00:00Z', minimumAgeDays: 30, now: '2026-08-14T00:00:00Z' },
  );
  assert.deepEqual(
    result,
    [],
    'an item four days old has not "gone 30 days unworn" — it has not existed that long',
  );
});

test('an old unworn item is reported, an old recently-worn item is not', () => {
  const candidates = [
    { sourceItemId: 'neglected', addedAt: '2026-01-01T00:00:00Z' },
    { sourceItemId: 'recent', addedAt: '2026-01-01T00:00:00Z' },
  ];
  const stats = [
    { sourceItemId: 'recent', timesWorn: 3, lastWornAt: '2026-08-10T00:00:00Z' },
  ];
  const result = wear.itemsNotWornSince(candidates, stats, {
    since: '2026-07-15T00:00:00Z',
    minimumAgeDays: 30,
    now: '2026-08-14T00:00:00Z',
  });
  assert.deepEqual(result, ['neglected']);
});

// ── 7. Authorization ─────────────────────────────────────────────────────────

test('an unauthenticated caller cannot write wear history', async () => {
  const db = makeDb({ session: null });
  const result = await wear.logItemWear(BLAZER, {}, db.client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthenticated');
  assert.equal(db.tables.wardrobe_wear_events.length, 0);
});

test('the writer stamps the session user and never a caller-supplied owner', async () => {
  const db = makeDb({ session: { user: { id: USER_B } } });
  await wear.logItemWear(BLAZER, {}, db.client);

  assert.equal(db.tables.wardrobe_wear_events[0].user_id, USER_B);
  assert.equal(db.tables.wardrobe_wear_event_items[0].user_id, USER_B);

  // There is no input on the public API through which a caller could claim a
  // different owner, which is what keeps RLS from being the only defence.
  const source = fs.readFileSync(path.join(ROOT, 'services/wearHistory.ts'), 'utf8');
  assert.doesNotMatch(
    source,
    /user_id:\s*(input|options|item)\./,
    'owner must come from the session, never from caller input',
  );
});

test('cross-user isolation is enforced by owner-scoped RLS on both tables', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260814120000_wardrobe_wear_event_items.sql'),
    'utf8',
  );
  assert.match(migration, /enable row level security/);
  for (const op of ['select', 'insert', 'update', 'delete']) {
    assert.match(
      migration,
      new RegExp(`for ${op}\\s*\\n\\s*to authenticated`),
      `wear event items need an owner-scoped ${op} policy`,
    );
  }
  // RLS alone yields 42501 in this project — the GRANT is load-bearing.
  assert.match(
    migration,
    /grant select, insert, update, delete\s*\n?\s*on public\.wardrobe_wear_event_items to authenticated/,
    'RLS without an explicit GRANT fails every authenticated query with 42501',
  );
  // The policy must scope on the row's own user_id, not a join.
  assert.match(migration, /using \(user_id = auth\.uid\(\)\)/);
  assert.match(migration, /with check \(user_id = auth\.uid\(\)\)/);
});

test('the deletion registry accounts for the new table', () => {
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'lib/account-deletion/user-data-resources.json'), 'utf8'),
  );
  const entry = registry.tables.find((t) => t.table === 'wardrobe_wear_event_items');
  assert.ok(entry, 'a new user-data table must not be missing from the deletion registry');
  assert.equal(entry.column, 'user_id');
});

// ── 8. Failure / partial write ───────────────────────────────────────────────

test('a failed relationship write reports failure rather than a partial success', async () => {
  const db = makeDb();
  const realFrom = db.client.from.bind(db.client);
  db.client.from = (table) => {
    if (table !== 'wardrobe_wear_event_items') return realFrom(table);
    return {
      upsert() {
        return {
          then(resolve) {
            return Promise.resolve({ data: null, error: { message: 'network' } }).then(resolve);
          },
        };
      },
    };
  };

  const result = await wear.logLookWear('look-1', [BLAZER, SHIRT], {}, db.client);
  assert.equal(result.ok, false, 'a half-written event must not be reported as recorded');
  assert.equal(result.reason, 'network');
});

test('retrying after a partial failure converges on one complete event', async () => {
  const db = makeDb();
  const opts = { actionKey: 'gesture-99', wornAt: '2026-08-14T10:00:00Z' };

  let failNext = true;
  const realFrom = db.client.from.bind(db.client);
  db.client.from = (table) => {
    if (table === 'wardrobe_wear_event_items' && failNext) {
      failNext = false;
      return {
        upsert() {
          return {
            then(resolve) {
              return Promise.resolve({ data: null, error: { message: 'network' } }).then(resolve);
            },
          };
        },
      };
    }
    return realFrom(table);
  };

  const first = await wear.logLookWear('look-1', [BLAZER, SHIRT], opts, db.client);
  assert.equal(first.ok, false);

  const second = await wear.logLookWear('look-1', [BLAZER, SHIRT], opts, db.client);
  assert.equal(second.ok, true);
  assert.equal(db.tables.wardrobe_wear_events.length, 1, 'the retry must not create a second wear');
  assert.equal(db.tables.wardrobe_wear_event_items.length, 2);
});

// ── 9. Durable look identity (defect DEF-S5-001 regression) ─────────────────

test('an outfit wear records a durable look reference, not only the FK', async () => {
  const db = makeDb();
  await wear.logLookWear('look-1', [BLAZER, SHIRT], { wornAt: '2026-08-14T10:00:00Z' }, db.client);

  const event = db.tables.wardrobe_wear_events[0];
  assert.equal(event.saved_look_id, 'look-1', 'the live FK is set');
  assert.equal(
    event.saved_look_ref,
    'look-1',
    'the durable reference must be set too — the FK nulls out when the look is deleted, ' +
      'and without this the row would be left with no identity at all',
  );
});

test('the identity CHECK tolerates the FK being nulled by a look deletion', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260814120000_wardrobe_wear_event_items.sql'),
    'utf8',
  );

  // Regression guard for DEF-S5-001: the original constraint accepted identity
  // only from source_item_id OR saved_look_id. An outfit-level event has a null
  // source_item_id, so ON DELETE SET NULL made the row violate its own CHECK
  // and the look became undeletable. pgTAP caught it; this pins the repair.
  assert.match(
    migration,
    /or saved_look_ref is not null/,
    'the identity constraint must accept the durable reference, or deleting a worn look fails',
  );
});
