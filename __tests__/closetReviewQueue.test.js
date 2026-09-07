// Closet Ownership V1 — the derived review queue (PR A2, sections 48-51).
//
// Runs the real services/closet/closetReview.ts. The controls that matter:
//   - review state is DERIVED: fix the condition and the item leaves, with no
//     store anywhere remembering it was ever flagged
//   - the volume guard actually coalesces, so Closet Home cannot become a pile
//     of individual nags
//   - retryable sync failures are NOT review work
//   - there is no dismissal mechanism to accidentally rely on (DM-03)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runModule(rel) {
  const source = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${source}\n})`, { filename: rel })(
    mod.exports,
    mod,
    () => ({}),
  );
  return mod.exports;
}

const review = runModule('services/closet/closetReview.ts');

let seq = 0;
function item(overrides = {}) {
  seq += 1;
  return {
    id: overrides.id ?? `closet_${seq}`,
    title: 'Navy Wool Coat',
    notes: null,
    origin: 'direct_intake',
    imageUri: null,
    thumbnailUri: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    category: 'Outerwear',
    clothingType: null,
    subtype: null,
    brand: null,
    primaryColor: null,
    secondaryColors: [],
    material: [],
    size: null,
    displaySummary: null,
    taxonomyUnknown: false,
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    state: 'synced',
    serverId: 'srv',
    serverRowVersion: 1,
    factsAttempted: true,
    syncedLocalUpdatedAt: null,
    mediaState: 'ready',
    blockedReason: null,
    attemptCount: 0,
    lastAttemptAt: null,
    lastFailureClass: null,
    conflictExpectedRowVersion: null,
    conflictKind: null,
    cachedMediaUploadedAt: null,
    ...overrides,
  };
}

// ── What counts as reviewable ────────────────────────────────────────────────

test('a complete item is not reviewable', () => {
  const out = review.deriveClosetReview([item()]);
  assert.equal(out.count, 0);
  assert.equal(out.homeMessage, null, 'nothing to say means say nothing');
});

test('a missing category is reviewable', () => {
  const out = review.deriveClosetReview([item({ category: null })]);
  assert.equal(out.count, 1);
  assert.deepEqual(out.items[0].reasons, ['missing_category']);
});

test('the store placeholder title is reviewable; a real name is not', () => {
  assert.equal(review.deriveClosetReview([item({ title: 'Closet item' })]).count, 1);
  assert.equal(review.deriveClosetReview([item({ title: 'Navy Wool Coat' })]).count, 0);
});

test('a user who deliberately typed the placeholder words keeps a fixable condition', () => {
  // Exact match only. If this were case-insensitive or fuzzy, a user who named
  // something "closet item" on purpose could never clear the flag — they would
  // retype the same words and stay flagged forever.
  assert.equal(review.deriveClosetReview([item({ title: 'closet item' })]).count, 0);
  assert.equal(review.deriveClosetReview([item({ title: 'Closet item mk2' })]).count, 0);
});

test('NEGATIVE CONTROL: missing brand/colour/size is NOT review work', () => {
  // Two of the three shipping intake paths populate none of these (see the
  // coverage audit). Flagging them would put most of a Closet into review for
  // something the user never had the chance to supply.
  const out = review.deriveClosetReview([
    item({ brand: null, primaryColor: null, size: null, material: [], secondaryColors: [] }),
  ]);
  assert.equal(out.count, 0, 'absent optional taxonomy is a pipeline finding, not a user task');
});

test('a sync conflict and blocked media are reviewable', () => {
  const conflicted = review.deriveClosetReview([item({ id: 'a' })], {
    a: entry({ lastFailureClass: 'conflict' }),
  });
  assert.deepEqual(conflicted.items[0].reasons, ['sync_conflict']);

  const blocked = review.deriveClosetReview([item({ id: 'b' })], {
    b: entry({ mediaState: 'blocked', blockedReason: 'privacy_block' }),
  });
  assert.deepEqual(blocked.items[0].reasons, ['media_blocked']);
});

test('NEGATIVE CONTROL: a retryable failure is NOT review work', () => {
  for (const failure of ['retryable', 'unexpected_authorization']) {
    const out = review.deriveClosetReview([item({ id: 'a' })], {
      a: entry({ state: 'error', lastFailureClass: failure }),
    });
    assert.equal(
      out.count,
      0,
      `${failure} retries itself — asking the user to look at it is how a review queue loses its meaning`,
    );
  }
});

test('reasons are emitted in a stable order, not discovery order', () => {
  const out = review.deriveClosetReview([item({ id: 'a', category: null, title: 'Closet item' })], {
    a: entry({ lastFailureClass: 'conflict', mediaState: 'blocked' }),
  });
  assert.deepEqual(out.items[0].reasons, [
    'missing_category',
    'placeholder_name',
    'sync_conflict',
    'media_blocked',
  ]);
});

// ── Derived, not stored ───────────────────────────────────────────────────────

test('DERIVED: fixing the condition removes the item, with nothing remembering it', () => {
  const broken = item({ id: 'a', category: null });
  assert.equal(review.deriveClosetReview([broken]).count, 1);

  const fixed = { ...broken, category: 'Outerwear' };
  const after = review.deriveClosetReview([fixed]);
  assert.equal(after.count, 0, 'the item leaves the set the moment the condition is false');
  assert.equal(after.homeMessage, null);
});

test('DERIVED: the deriver is pure — same input, same output, no accumulation', () => {
  const items = [item({ id: 'a', category: null }), item({ id: 'b' })];
  const first = JSON.stringify(review.deriveClosetReview(items));
  const second = JSON.stringify(review.deriveClosetReview(items));
  assert.equal(first, second);
});

test('DM-03: there is no dismissal mechanism at all', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closet/closetReview.ts'), 'utf8');
  for (const banned of ['dismiss', 'Dismiss', 'snooze', 'acknowledged', 'seenAt', 'ignoredAt']) {
    assert.ok(
      !new RegExp(`\\b${banned}\\b`).test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')),
      `derived state cannot remember ${banned} — see DM-03`,
    );
  }
});

test('the review deriver reaches no store, network or durable state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closet/closetReview.ts'), 'utf8');
  for (const banned of ['supabase', 'FileSystem', 'AsyncStorage', 'fetch(', 'writeAsString']) {
    assert.ok(!source.includes(banned), `review must stay derived — found ${banned}`);
  }
});

// ── The volume guard (section 50) ─────────────────────────────────────────────

test('VOLUME GUARD: a small number of issues is stated exactly', () => {
  const items = [item({ id: 'a', category: null }), ...Array.from({ length: 19 }, () => item())];
  const out = review.deriveClosetReview(items);
  assert.equal(out.count, 1);
  assert.equal(out.coalesced, false);
  assert.equal(out.homeMessage, '1 item could use a quick review.');
});

test('VOLUME GUARD: more than 20% of the Closet coalesces', () => {
  // 3 of 10 = 30%, which is over the ratio but under the absolute count.
  const items = [
    ...Array.from({ length: 3 }, (_, i) => item({ id: `bad${i}`, category: null })),
    ...Array.from({ length: 7 }, () => item()),
  ];
  const out = review.deriveClosetReview(items);
  assert.equal(out.count, 3);
  assert.equal(out.coalesced, true);
  assert.equal(out.homeMessage, 'Some items could use a quick review.');
});

test('VOLUME GUARD: more than 10 items coalesces even at a small percentage', () => {
  // 11 of 1000 = 1.1%, well under the ratio, but eleven separate nags is a pile.
  const items = [
    ...Array.from({ length: 11 }, (_, i) => item({ id: `bad${i}`, category: null })),
    ...Array.from({ length: 989 }, () => item()),
  ];
  const out = review.deriveClosetReview(items);
  assert.equal(out.count, 11);
  assert.equal(out.coalesced, true);
  assert.equal(out.homeMessage, 'Some items could use a quick review.');
});

test('VOLUME GUARD: the truthful count survives coalescing', () => {
  const items = Array.from({ length: 40 }, (_, i) => item({ id: `bad${i}`, category: null }));
  const out = review.deriveClosetReview(items);
  assert.equal(out.count, 40, 'the count is never rounded, hidden or capped');
  assert.equal(out.items.length, 40, 'the dedicated list still receives every item');
  assert.equal(out.coalesced, true, 'only the HOME presentation is coalesced');
});

test('an all-broken Closet does not divide by zero or misreport', () => {
  const out = review.deriveClosetReview([]);
  assert.equal(out.count, 0);
  assert.equal(out.coalesced, false);
  assert.equal(out.homeMessage, null);
});

// ── Language ──────────────────────────────────────────────────────────────────

test('review language is customer-facing, never internal vocabulary', () => {
  const strings = [
    ...Object.values(review.CLOSET_REVIEW_REASON_LABELS),
    review.deriveClosetReview([item({ category: null })]).homeMessage,
    review.deriveClosetReview(
      Array.from({ length: 30 }, (_, i) => item({ id: `x${i}`, category: null })),
    ).homeMessage,
  ];
  for (const s of strings) {
    const lower = String(s).toLowerCase();
    for (const banned of ['row_version', 'tombstone', 'sidecar', 'blocked', 'conflict', 'rls', 'null', 'schema']) {
      assert.ok(!lower.includes(banned), `review copy leaked ${banned}: ${s}`);
    }
  }
});

test('robustness: junk items and a missing sidecar do not throw', () => {
  assert.equal(review.deriveClosetReview(null).count, 0);
  assert.equal(review.deriveClosetReview(undefined, undefined).count, 0);
  const out = review.deriveClosetReview([null, undefined, item({ category: null })], undefined);
  assert.equal(out.count, 1, 'a missing sidecar still yields the item-derived reasons');
});
