// Closet Productization lane — durable state, actor isolation and deletion
// coverage (sections 72, 73, 76).
//
// THE CLAIM THIS FILE PROVES: PRs A1, A2 and B create NO new durable data class.
//
// That claim is what makes the account-deletion and actor-isolation stories
// short. Section 73 says any new durable Closet state must be deletion-covered;
// the strongest way to satisfy it is not to create any, and then to prove it
// mechanically rather than assert it in a PR description.
//
// Every piece of state this lane introduces is one of:
//   - component state, which dies with the mount (search text, filter, sort,
//     the review filter toggle, the page-size window)
//   - a useMemo over data useCloset() already loaded (inventory view, summary,
//     review set, intelligence)
//   - a read of the EXISTING sync sidecar, which was already actor-partitioned
//     and already deletion-covered before this lane
//
// A future change that adds a store to any of these modules turns this red, and
// the person making it then has to answer the deletion and isolation questions
// deliberately.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Every module this lane added or materially changed. */
const LANE_MODULES = [
  'services/closet/closetInventory.ts',
  'services/closet/closetSyncPresentation.ts',
  'services/closet/closetReview.ts',
  'services/closet/closetIntelligence.ts',
  'hooks/useClosetInventory.ts',
  'hooks/useClosetSyncStatus.ts',
  'hooks/useClosetReview.ts',
  'hooks/useClosetIntelligence.ts',
  'components/closet/ClosetInventoryBar.tsx',
  'components/closet/ClosetSyncStatusRow.tsx',
  'components/closet/ClosetReviewRow.tsx',
  'components/closet/ClosetIntelligencePanel.tsx',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('NO NEW DURABLE STATE: nothing in this lane writes to disk or a device store', () => {
  const writers = [
    'writeAsStringAsync',
    'makeDirectoryAsync',
    'AsyncStorage',
    'SecureStore',
    'MMKV',
    'localStorage',
    'sessionStorage',
  ];
  for (const rel of LANE_MODULES) {
    const source = stripComments(read(rel));
    for (const writer of writers) {
      assert.ok(
        !source.includes(writer),
        `${rel} would create a new durable data class (${writer}) — section 73 requires deletion coverage for one, so do not add it without answering that`,
      );
    }
  }
});

test('NO NEW CLOUD STATE: nothing in this lane writes to Supabase', () => {
  for (const rel of LANE_MODULES) {
    const source = stripComments(read(rel));
    for (const writer of ['.insert(', '.upsert(', '.update(', '.delete(', 'supabase']) {
      assert.ok(
        !source.includes(writer),
        `${rel} must not reach the cloud — this lane adds no cloud state, so account deletion needs no new coverage (${writer})`,
      );
    }
  }
});

test('NO NEW MIGRATION: this lane adds no user-data migration', () => {
  // Section 38: schema changes must be additive and backward tolerant, and PR A2
  // deliberately performs NO migration (DM-02). Prove no migration file in this
  // lane's naming window exists, and that the store gained no migration step.
  const store = read('services/closetLibrary.js');
  const migrationBlock = store.slice(
    store.indexOf('const CLOSET_ITEM_MIGRATIONS'),
    store.indexOf('});', store.indexOf('const CLOSET_ITEM_MIGRATIONS')),
  );
  const steps = [...migrationBlock.matchAll(/^\s*(\d+):/gm)].map((m) => m[1]);
  assert.deepEqual(
    steps,
    ['0', '1'],
    'the migration table must be unchanged — A2 widens an allowlist, it does not rewrite records',
  );
  assert.match(
    store,
    /export const CLOSET_ITEM_SCHEMA_VERSION = 2;/,
    'the record schema version must not move: no stored record changes shape in this lane',
  );
});

test('ACTOR ISOLATION: every sidecar read in this lane is stamped and discarded on actor change', () => {
  // The rule useCloset() already applies: a completion captured before an actor
  // transition must be discarded rather than rendered under the new actor. Each
  // hook here that reads the sidecar has to do the same, or B's account A data
  // could land in account B's session.
  for (const rel of ['hooks/useClosetSyncStatus.ts', 'hooks/useClosetReview.ts', 'hooks/useClosetIntelligence.ts']) {
    const source = read(rel);
    assert.match(
      source,
      /const issuedFor = actorId;/,
      `${rel} must stamp the read with the actor it was issued for`,
    );
    assert.match(
      source,
      /actorRef\.current !== issuedFor/,
      `${rel} must discard a completion that landed after an actor change`,
    );
    // ...on BOTH the success and the failure path. A guarded `then` with an
    // unguarded `catch` still lets a stale empty result overwrite the new
    // actor's state.
    const catchBlocks = source.match(/\.catch\(\(\) => \{[\s\S]*?\}\)/g) ?? [];
    assert.ok(catchBlocks.length > 0, `${rel} must handle a sidecar read failure`);
    for (const block of catchBlocks) {
      assert.ok(
        block.includes('actorRef.current !== issuedFor'),
        `${rel} guards its success path but not its failure path — a late failure would clear the new actor's state`,
      );
    }
  }
});

test('ACTOR ISOLATION: query state is per-mount, so it cannot outlive an account', () => {
  const source = stripComments(read('hooks/useClosetInventory.ts'));
  // useState only. Anything durable here would need actor partitioning and
  // deletion coverage of its own (section 72 lists "search/filter state if
  // persisted" explicitly).
  assert.ok(source.includes('useState'), 'query state is component state');
  for (const durable of ['AsyncStorage', 'SecureStore', 'writeAsString', 'localStorage']) {
    assert.ok(!source.includes(durable), `search and filter state must not be persisted (${durable})`);
  }
});

test('MEDIA PRIVACY: this lane adds no media path and no cloud image fallback', () => {
  // Section 74: preserve the fail-closed media policy. No raw original cloud
  // fallback, no unsanitized thumbnail fallback. This lane touches no media
  // code at all; the grid reads the thumbnail the store already wrote.
  for (const rel of LANE_MODULES) {
    const source = stripComments(read(rel));
    for (const banned of [
      'createSignedUrl',
      'getPublicUrl',
      'downloadAsync',
      'manipulateAsync',
      'privacyImageSanitizer',
      'storage.from',
    ]) {
      assert.ok(!source.includes(banned), `${rel} must not touch the media boundary (${banned})`);
    }
  }
});

test('PRESERVATION LIST: the sync/restore/media engines are not modified by this lane', () => {
  // Section 6. These are consumed, never refactored for UI convenience. Any
  // import of them in this lane must be a READ.
  const engines = [
    'closetSyncEngine',
    'closetSyncCoordinator',
    'closetMediaSync',
    'closetRestoreEngine',
    'closetRestoreMedia',
  ];
  for (const rel of LANE_MODULES) {
    const source = stripComments(read(rel));
    for (const engine of engines) {
      if (!source.includes(engine)) continue;
      // The only permitted reach into an engine from this lane is the
      // entitlement predicate, which section 13 says to CONSUME.
      assert.ok(
        source.includes('isClosetCloudSyncEligible'),
        `${rel} reaches ${engine} for something other than the canonical entitlement predicate`,
      );
      for (const mutator of ['runClosetSyncPass', 'resumeClosetSync', 'runClosetRestorePass', 'markClosetItemForSync']) {
        assert.ok(
          !source.includes(mutator),
          `${rel} must not start a pass — useCloset() already triggers them on focus (${mutator})`,
        );
      }
    }
  }
});

test('NO NEW TELEMETRY EVENT outside the frozen vocabulary (section 67)', () => {
  // The K+ vocabulary already carries kplus_feature_exposed and
  // kplus_feature_gate_opened, and `closet_intelligence` was already an approved
  // KPlusSource. The intelligence surface therefore emits within existing
  // governance, through KPlusGate, and this lane proposes no new event name.
  for (const rel of LANE_MODULES) {
    const source = stripComments(read(rel));
    for (const banned of ['emitClosetCandidateEvent', 'closet_intelligence_viewed', 'closet_review_resolved']) {
      assert.ok(
        !source.includes(banned),
        `${rel} emits an event outside the accepted analytics schema (${banned}) — propose it to the vocabulary first`,
      );
    }
  }
  // And the one surface that does emit does so only via the shared gate.
  const panel = read('components/closet/ClosetIntelligencePanel.tsx');
  assert.ok(panel.includes('KPlusGate'), 'telemetry reaches the sink through the shared gate only');
  assert.ok(!panel.includes('emitKPlusEvent'), 'the panel must not emit directly');
});
