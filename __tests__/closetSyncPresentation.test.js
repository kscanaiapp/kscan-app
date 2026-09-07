// Closet Experience V1 — sync/restore visibility (PR A1, sections 31/32).
//
// Two rules are mechanically locked here:
//
//   1. RESOLVING IS NOT INACTIVE (section 12). While the entitlement authority
//      has not answered, the surface must say NOTHING — no pill, no locked
//      claim, no Early Access pitch.
//   2. NO INTERNAL VOCABULARY EVER REACHES A USER (section 32). The banned-word
//      sweep below runs over EVERY string this module can produce, across every
//      reachable state, not over a hand-picked sample.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function runModule(rel) {
  const source = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${source}\n})`, { filename: rel })(
    mod.exports,
    mod,
    () => ({}),
  );
  return mod.exports;
}

const presentation = runModule('services/closet/closetSyncPresentation.ts');

function entry(overrides = {}) {
  return {
    state: 'synced',
    serverId: 'srv-1',
    serverRowVersion: 3,
    factsAttempted: true,
    syncedLocalUpdatedAt: '2026-01-01T00:00:00.000Z',
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

const ELIGIBLE = { eligible: true, resolving: false, entries: {} };

// ── Section 12: the three-state rule ──────────────────────────────────────────

test('RESOLVING renders NOTHING — never a locked claim, never a pitch', () => {
  const out = presentation.presentClosetSyncStatus({
    eligible: false,
    resolving: true,
    entries: { a: entry({ state: 'pending' }) },
  });
  assert.equal(out, null, 'a resolving entitlement must produce no status at all');
});

test('NEGATIVE CONTROL: resolving is not collapsed into inactive', () => {
  // Same input except for `resolving`. If these two ever produce the same
  // non-null result, RESOLVING has been treated as a resolved state.
  const resolving = presentation.presentClosetSyncStatus({ eligible: true, resolving: true, entries: {} });
  const active = presentation.presentClosetSyncStatus({ eligible: true, resolving: false, entries: {} });
  assert.equal(resolving, null);
  assert.notEqual(active, null);
});

test('an ineligible actor gets no status row — availability messaging is not this pill', () => {
  assert.equal(
    presentation.presentClosetSyncStatus({ eligible: false, resolving: false, entries: {} }),
    null,
  );
});

// ── State selection ───────────────────────────────────────────────────────────

test('a fully synced Closet reads "Up to date"', () => {
  const out = presentation.presentClosetSyncStatus({ ...ELIGIBLE, entries: { a: entry() } });
  assert.equal(out.id, 'up_to_date');
  assert.equal(out.tone, 'neutral');
});

test('pending outbound work reads "Syncing" and counts items', () => {
  const out = presentation.presentClosetSyncStatus({
    ...ELIGIBLE,
    entries: { a: entry({ state: 'pending' }), b: entry({ state: 'pending' }), c: entry() },
  });
  assert.equal(out.id, 'syncing');
  assert.ok(out.detail.includes('2 items'), out.detail);
});

test('a permanent refusal or a conflict escalates to "needs attention"', () => {
  for (const failure of ['permanent', 'conflict']) {
    const out = presentation.presentClosetSyncStatus({
      ...ELIGIBLE,
      entries: { a: entry({ state: 'error', lastFailureClass: failure }) },
    });
    assert.equal(out.id, 'needs_attention', `${failure} must need attention`);
    assert.equal(out.tone, 'attention');
  }
});

test('retryable and authorization-race failures are ordinary in-flight work, not alarms', () => {
  for (const failure of ['retryable', 'unexpected_authorization']) {
    const out = presentation.presentClosetSyncStatus({
      ...ELIGIBLE,
      entries: { a: entry({ state: 'error', lastFailureClass: failure }) },
    });
    assert.equal(out.id, 'syncing', `${failure} retries itself and must not alarm the user`);
  }
});

test('"Up to date" is unreachable while anything is unresolved', () => {
  const unresolved = [
    entry({ state: 'pending' }),
    entry({ state: 'pending_delete' }),
    entry({ state: 'error', lastFailureClass: 'permanent' }),
    entry({ mediaState: 'pending' }),
    entry({ mediaState: 'blocked', blockedReason: 'privacy_block' }),
  ];
  for (const e of unresolved) {
    const out = presentation.presentClosetSyncStatus({ ...ELIGIBLE, entries: { a: e } });
    assert.notEqual(out.id, 'up_to_date', `state ${JSON.stringify(e.state)}/${e.mediaState} must not read as up to date`);
  }
});

test('offline is only claimed when the caller actually knows — never guessed', () => {
  const entries = { a: entry({ state: 'pending' }) };
  assert.equal(presentation.presentClosetSyncStatus({ ...ELIGIBLE, entries }).id, 'syncing');
  assert.equal(
    presentation.presentClosetSyncStatus({ ...ELIGIBLE, entries, online: undefined }).id,
    'syncing',
    'unknown connectivity must not read as offline',
  );
  assert.equal(presentation.presentClosetSyncStatus({ ...ELIGIBLE, entries, online: false }).id, 'offline');
});

test('restore in flight outranks ordinary outbound work', () => {
  const out = presentation.presentClosetSyncStatus({
    ...ELIGIBLE,
    entries: { a: entry({ state: 'pending' }) },
    restoreInFlight: true,
  });
  assert.equal(out.id, 'restoring');
});

// ── Restore outcome ───────────────────────────────────────────────────────────

test('restore outcome maps counters to customer language', () => {
  const p = presentation.presentClosetRestoreOutcome;
  assert.equal(p({ ran: false, materialized: 0, updated: 0, deleted: 0, conflicts: 0, failed: 0 }), null);
  assert.equal(p({ ran: true, materialized: 0, updated: 0, deleted: 0, conflicts: 0, failed: 0 }).id, 'nothing_new');
  assert.equal(p({ ran: true, materialized: 2, updated: 1, deleted: 0, conflicts: 0, failed: 0 }).label, 'Restored 3 items');
  assert.equal(p({ ran: true, materialized: 1, updated: 0, deleted: 0, conflicts: 0, failed: 0 }).label, 'Restored 1 item');
  assert.equal(p({ ran: true, materialized: 5, updated: 0, deleted: 0, conflicts: 1, failed: 0 }).id, 'needs_attention');
  assert.equal(p({ ran: true, materialized: 5, updated: 0, deleted: 0, conflicts: 0, failed: 2 }).id, 'needs_attention');
});

// ── Section 32: the vocabulary lock ───────────────────────────────────────────

/** Every string this module can emit, over every reachable state. */
function allEmittedStrings() {
  const out = [];
  const push = (v) => {
    if (!v) return;
    out.push(v.label);
    if (v.detail) out.push(v.detail);
  };

  const failures = [null, 'retryable', 'permanent', 'conflict', 'unexpected_authorization'];
  const states = ['pending', 'synced', 'blocked', 'error', 'pending_delete'];
  const media = ['none', 'pending', 'ready', 'blocked'];

  for (const resolving of [true, false]) {
    for (const eligible of [true, false]) {
      for (const online of [true, false, undefined]) {
        for (const restoreInFlight of [true, false]) {
          for (const state of states) {
            for (const mediaState of media) {
              for (const lastFailureClass of failures) {
                push(
                  presentation.presentClosetSyncStatus({
                    resolving,
                    eligible,
                    online,
                    restoreInFlight,
                    entries: { a: entry({ state, mediaState, lastFailureClass }) },
                  }),
                );
              }
            }
          }
          push(presentation.presentClosetSyncStatus({ resolving, eligible, online, restoreInFlight, entries: {} }));
        }
      }
    }
  }

  for (const ran of [true, false]) {
    for (const n of [0, 1, 2]) {
      const r = presentation.presentClosetRestoreOutcome({
        ran,
        materialized: n,
        updated: n,
        deleted: n,
        conflicts: n,
        failed: n,
      });
      if (r) out.push(r.label);
    }
  }
  return out;
}

test('SECTION 32 LOCK: no internal vocabulary reaches any user-facing string', () => {
  const strings = allEmittedStrings();
  assert.ok(strings.length > 50, `the sweep must actually cover the state space (got ${strings.length})`);

  const banned = [
    'row_version',
    'rowversion',
    'tombstone',
    'pagination',
    'paginate',
    'PRE-B2B',
    'sidecar',
    'pending_delete',
    'local_only',
    'unexpected_authorization',
    'retryable',
    'blockedReason',
    'client_id',
    'serverId',
    'RLS',
    'upsert',
    'B2B',
    'B2C',
    'schema_version',
    'deleted_at',
    'supabase',
  ];

  for (const s of strings) {
    const lower = s.toLowerCase();
    for (const word of banned) {
      assert.ok(
        !lower.includes(word.toLowerCase()),
        `user-facing string leaked internal vocabulary ${JSON.stringify(word)}: ${JSON.stringify(s)}`,
      );
    }
  }
});

test('SECTION 11 LOCK: the status surface never uses commerce language', () => {
  for (const s of allEmittedStrings()) {
    const lower = s.toLowerCase();
    for (const word of ['subscribe', 'upgrade', 'buy ', 'purchase', 'renew', 'price', '$']) {
      assert.ok(!lower.includes(word), `status strings must not sell: ${JSON.stringify(s)}`);
    }
  }
});

test('every attention message reassures that the local Closet is unaffected', () => {
  const out = presentation.presentClosetSyncStatus({
    ...ELIGIBLE,
    entries: { a: entry({ state: 'error', lastFailureClass: 'permanent' }) },
  });
  assert.match(out.detail, /unaffected/i, 'local-first must be stated, not implied');
});

test('STRUCTURAL: presentation performs no I/O and starts no sync pass', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closet/closetSyncPresentation.ts'), 'utf8');
  for (const banned of ['supabase', 'runClosetSyncPass', 'resumeCloset', 'FileSystem', 'fetch(', 'listClosetSyncEntries']) {
    assert.ok(!source.includes(banned), `presentation must not act — found ${banned}`);
  }
});
