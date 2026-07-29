const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relPath, mocks = {}) {
  const filename = path.join(ROOT, relPath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.ts`)) resolved = `${resolved}.ts`;
      const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
      return loadModule(rel, mocks);
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInNewContext(
    output,
    {
      module: mod,
      exports: mod.exports,
      require: localRequire,
      console,
      Date,
      Math,
      Number,
      Array,
      Object,
      JSON,
      Uint8Array,
      globalThis: { crypto: undefined },
    },
    { filename },
  );
  return mod.exports;
}

const schema = loadModule('services/privateDressingRoomSessionSchema.ts', {
  'expo-crypto': { getRandomBytes: (n) => new Uint8Array(n).fill(7) },
});
const types = loadModule('types/privateDressingRoomSession.ts');

// ── Session id ───────────────────────────────────────────────────────────────

test('session ids are opaque, prefixed, and unique across a same-tick burst', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(schema.createPrivateDressingRoomSessionId());
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^drsession_[0-9a-z]+_[0-9a-z]+_[0-9a-f]+$/);
});

test('session id never embeds the actor id', () => {
  const actorId = 'user-super-secret-0001';
  const session = schema.buildPrivateDressingRoomSession({ actorId });
  assert.ok(!session.sessionId.includes(actorId));
  assert.ok(!session.sessionId.includes('user-'));
});

// ── Construction ─────────────────────────────────────────────────────────────

test('a new session is active, timestamped, and schema-versioned', () => {
  const now = '2026-07-28T12:00:00.000Z';
  const session = schema.buildPrivateDressingRoomSession({ actorId: 'user-1', now });
  assert.equal(session.status, 'active');
  assert.equal(session.actorId, 'user-1');
  assert.equal(session.createdAt, now);
  assert.equal(session.updatedAt, now);
  assert.equal(session.schemaVersion, 1);
  assert.equal(session.anchorClosetItemId, null);
  assert.equal(session.occasion, null);
});

test('a new session carries an anchor and occasion when supplied', () => {
  const session = schema.buildPrivateDressingRoomSession({
    actorId: 'user-1',
    anchorClosetItemId: 'closet-1',
    occasion: 'Dinner',
  });
  assert.equal(session.anchorClosetItemId, 'closet-1');
  assert.equal(session.occasion, 'Dinner');
});

test('signed-out (null) actor is a real partition, not an error', () => {
  const session = schema.buildPrivateDressingRoomSession({ actorId: null });
  assert.equal(session.actorId, null);
  assert.equal(session.status, 'active');
});

test('the session persists no Closet metadata and no Phase 2 fields', () => {
  const session = schema.buildPrivateDressingRoomSession({
    actorId: 'user-1',
    anchorClosetItemId: 'closet-1',
  });
  assert.deepEqual(Object.keys(session).sort(), [...types.PRIVATE_DRESSING_ROOM_SESSION_FIELDS].sort());
  for (const forbidden of [
    'lookId',
    'savedLookId',
    'items',
    'outfitItems',
    'swapHistory',
    'commerce',
    'receipt',
    'conversation',
    'title',
    'imageUri',
    'category',
    'brand',
    'actorEpoch',
  ]) {
    assert.equal(forbidden in session, false, `session must not persist ${forbidden}`);
  }
});

test('occasion and ids are bounded', () => {
  const session = schema.buildPrivateDressingRoomSession({
    actorId: 'user-1',
    anchorClosetItemId: 'c'.repeat(500),
    occasion: 'o'.repeat(500),
  });
  assert.equal(session.occasion.length, types.PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.occasion);
  assert.equal(
    session.anchorClosetItemId.length,
    types.PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.anchorClosetItemId,
  );
});

// ── Revision ─────────────────────────────────────────────────────────────────

test('revision advances updatedAt and never touches createdAt', () => {
  const created = schema.buildPrivateDressingRoomSession({
    actorId: 'user-1',
    now: '2026-07-28T12:00:00.000Z',
  });
  const revised = schema.revisePrivateDressingRoomSession(
    created,
    { occasion: 'Wedding' },
    '2026-07-28T13:00:00.000Z',
  );
  assert.equal(revised.createdAt, created.createdAt);
  assert.equal(revised.updatedAt, '2026-07-28T13:00:00.000Z');
  assert.equal(revised.occasion, 'Wedding');
});

test('revision cannot re-home a session to another actor or change its id', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  const revised = schema.revisePrivateDressingRoomSession(created, {
    actorId: 'user-2',
    sessionId: 'attacker-chosen',
    createdAt: '1999-01-01T00:00:00.000Z',
  });
  assert.equal(revised.actorId, 'user-1');
  assert.equal(revised.sessionId, created.sessionId);
  assert.equal(revised.createdAt, created.createdAt);
});

test('an unpatched field is preserved; an explicit null clears it', () => {
  const created = schema.buildPrivateDressingRoomSession({
    actorId: 'user-1',
    anchorClosetItemId: 'closet-1',
    occasion: 'Dinner',
  });
  const onlyOccasion = schema.revisePrivateDressingRoomSession(created, { occasion: 'Brunch' });
  assert.equal(onlyOccasion.anchorClosetItemId, 'closet-1');

  const cleared = schema.revisePrivateDressingRoomSession(created, { anchorClosetItemId: null });
  assert.equal(cleared.anchorClosetItemId, null);
  assert.equal(cleared.occasion, 'Dinner');
});

test('discard is a status transition, not a deletion', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  const discarded = schema.revisePrivateDressingRoomSession(created, { status: 'discarded' });
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.sessionId, created.sessionId);
});

test('an unknown status is refused in favour of the previous one', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  const revised = schema.revisePrivateDressingRoomSession(created, { status: 'archived' });
  assert.equal(revised.status, 'active');
});

// ── Validation / allowlisted reconstruction ──────────────────────────────────

test('a valid stored record round-trips', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  const result = schema.migratePrivateDressingRoomSessionRecord(JSON.parse(JSON.stringify(created)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record, created);
});

test('unknown fields are stripped by allowlisted reconstruction', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  const tampered = { ...created, lookId: 'look-1', injected: true, __proto__mark: 'x' };
  const result = schema.migratePrivateDressingRoomSessionRecord(tampered);
  assert.equal(result.ok, true);
  assert.equal('lookId' in result.record, false);
  assert.equal('injected' in result.record, false);
  assert.deepEqual(
    Object.keys(result.record).sort(),
    [...types.PRIVATE_DRESSING_ROOM_SESSION_FIELDS].sort(),
  );
});

test('a future schema version is refused, not downgraded', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  const result = schema.migratePrivateDressingRoomSessionRecord({ ...created, schemaVersion: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'session_store_future_schema');
});

test('structurally invalid records fail closed as corrupt', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  const cases = [
    null,
    undefined,
    'nope',
    42,
    [],
    {},
    { ...created, schemaVersion: 0 },
    { ...created, schemaVersion: 'one' },
    { ...created, sessionId: '' },
    { ...created, sessionId: 123 },
    { ...created, status: 'bogus' },
    { ...created, createdAt: 'not-a-date' },
    { ...created, updatedAt: null },
  ];
  for (const raw of cases) {
    const result = schema.migratePrivateDressingRoomSessionRecord(raw);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(raw)}`);
    assert.ok(
      ['session_store_corrupt', 'session_store_future_schema'].includes(result.errorCode),
      `unexpected code ${result.errorCode}`,
    );
  }
});

test('a null actorId record is valid; a malformed one normalizes to null', () => {
  const created = schema.buildPrivateDressingRoomSession({ actorId: null });
  assert.equal(schema.migratePrivateDressingRoomSessionRecord(created).ok, true);

  const malformed = schema.migratePrivateDressingRoomSessionRecord({
    ...schema.buildPrivateDressingRoomSession({ actorId: 'user-1' }),
    actorId: { not: 'a string' },
  });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.record.actorId, null);
});

test('the contract declares exactly two statuses and one supported version', () => {
  assert.deepEqual([...types.PRIVATE_DRESSING_ROOM_SESSION_STATUSES], ['active', 'discarded']);
  assert.equal(types.PRIVATE_DRESSING_ROOM_SESSION_SCHEMA_VERSION, 1);
  assert.equal(types.PRIVATE_DRESSING_ROOM_SESSION_MAX_SUPPORTED_SCHEMA_VERSION, 1);
});

test('the private domain reuses no collaborative-room field on its record', () => {
  // Asserted against the persisted FIELD SURFACE, not the file text: the module
  // prose names the collaborative product precisely in order to disclaim it.
  const session = schema.buildPrivateDressingRoomSession({ actorId: 'user-1' });
  for (const collaborative of [
    'roomId',
    'dressingRoomId',
    'membership',
    'members',
    'shareToken',
    'reactions',
    'votes',
    'ownerUserId',
  ]) {
    assert.equal(collaborative in session, false, `must not reuse ${collaborative}`);
    assert.equal(
      types.PRIVATE_DRESSING_ROOM_SESSION_FIELDS.includes(collaborative),
      false,
      `must not allowlist ${collaborative}`,
    );
  }
});

test('the private domain declares its own type names, not collaborative ones', () => {
  const exported = Object.keys(types);
  for (const name of exported) {
    assert.match(
      name,
      /^PRIVATE_DRESSING_ROOM_SESSION/,
      `unexpected export ${name} in the private session contract`,
    );
  }
});
