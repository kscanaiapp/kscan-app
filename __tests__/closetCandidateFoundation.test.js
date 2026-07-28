// Closet candidate FOUNDATION suite — contracts, state machine, error registry,
// schema migration, identifiers, telemetry scrubbing, connectivity port.
//
// Every module under test here is PURE, so these run against the REAL
// implementations with no permissive doubles. The only shimmed dependency is
// expo-crypto, which has no JS implementation outside the native runtime.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

/** Deterministic expo-crypto double. Real randomness is not what is under test. */
function cryptoShim() {
  let seq = 0;
  return {
    getRandomBytes(n) {
      seq += 1;
      return Uint8Array.from({ length: n }, (_, i) => (seq * 31 + i * 7) % 256);
    },
    randomUUID: () => {
      seq += 1;
      const hex = seq.toString(16).padStart(12, '0');
      return `00000000-0000-4000-8000-${hex}`;
    },
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    async digestStringAsync(_algo, data) {
      // Deterministic, collision-free-enough stand-in for a real digest. What the
      // production code must guarantee is that EQUAL BYTES produce EQUAL digests
      // and different bytes do not — that property is what these tests exercise.
      let h1 = 0x811c9dc5;
      let h2 = 0x01000193;
      for (let i = 0; i < data.length; i += 1) {
        h1 = ((h1 ^ data.charCodeAt(i)) * 16777619) >>> 0;
        h2 = ((h2 + data.charCodeAt(i) * (i + 1)) * 2654435761) >>> 0;
      }
      return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.repeat(4);
    },
  };
}

const types = runModule('types/closetCandidate.ts', () => ({}));
const stateMachine = runModule('services/closetCandidateStateMachine.ts', (spec) => {
  if (spec === '../types/closetCandidate') return types;
  return {};
});
const errors = runModule('services/closetCandidateErrors.ts', (spec) => {
  if (spec === '../types/closetCandidate') return types;
  return {};
});
const schema = runModule('services/closetCandidateSchema.js', (spec) => {
  if (spec === 'expo-crypto') return cryptoShim();
  if (spec === '../types/closetCandidate') return types;
  if (spec === './closetCandidateErrors') return errors;
  if (spec === './closetCandidateStateMachine') return stateMachine;
  return {};
});
const telemetry = runModule('services/closetTelemetry.ts', () => ({}));
const connectivity = runModule('services/closetConnectivity.js', () => ({}));

// ── Canonical contract ───────────────────────────────────────────────────────

test('candidate schema version is 3 and does not depend on a feature flag', () => {
  assert.equal(types.CLOSET_CANDIDATE_SCHEMA_VERSION, 3);
  assert.equal(types.CLOSET_CANDIDATE_MAX_SUPPORTED_SCHEMA_VERSION, 3);
});

test('the exact-hash version names normalized bytes, not perceptual similarity', () => {
  assert.equal(types.CLOSET_CANDIDATE_CONTENT_HASH_VERSION, 'sha256-normalized-v1');
  // Build 1 implements ONLY exact signals. A perceptual or embedding algorithm
  // appearing in this vocabulary would be a scope breach, not a feature.
  assert.deepEqual(
    [...types.CLOSET_CANDIDATE_DUPLICATE_ALGORITHMS],
    ['source-lineage-v1', 'sha256-normalized-v1'],
  );
  for (const algorithm of types.CLOSET_CANDIDATE_DUPLICATE_ALGORITHMS) {
    assert.ok(!/percept|phash|embed|similar|vector/i.test(algorithm));
  }
});

test('limits and lifetime match the specified policy', () => {
  assert.equal(types.CLOSET_CANDIDATE_MAX_UNRESOLVED, 40);
  assert.equal(types.CLOSET_CANDIDATE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(types.CLOSET_CANDIDATE_MAX_AUTOMATIC_RETRIES, 2);
  assert.equal(types.CLOSET_CANDIDATE_MAX_TOTAL_ATTEMPTS, 3);
  assert.equal(types.CLOSET_CANDIDATE_MAX_INTERRUPTIONS, 2);
  assert.equal(types.CLOSET_CANDIDATE_MAX_CONCURRENT_CLASSIFICATIONS, 2);
});

// ── State machine ────────────────────────────────────────────────────────────

test('every allowed transition in the specified chain is legal', () => {
  const allowed = [
    ['queued', 'preparing'],
    ['preparing', 'waiting_for_network'],
    ['preparing', 'classifying'],
    ['waiting_for_network', 'classifying'],
    ['waiting_for_network', 'queued'],
    ['classifying', 'ready_for_review'],
    ['classifying', 'needs_manual_classification'],
    ['classifying', 'failed'],
    ['failed', 'queued'],
    ['needs_manual_classification', 'ready_for_review'],
    ['ready_for_review', 'rejected'],
    ['duplicate', 'rejected'],
    // Representable for Build 2, unreachable from Build 1 UI.
    ['ready_for_review', 'saving'],
    ['saving', 'saved'],
    // Phase 3 promotion: ONE durable step, taken only after the committed item
    // has been written and read back. The in-flight state is an overlay.
    ['ready_for_review', 'saved'],
  ];
  for (const [from, to] of allowed) {
    assert.equal(stateMachine.canTransition(from, to), true, `${from} -> ${to}`);
  }
});

test('forbidden transitions are rejected with candidate_invalid_transition', () => {
  const forbidden = [
    ['queued', 'ready_for_review'],
    ['queued', 'saved'],
    ['queued', 'saving'],
    ['duplicate', 'classifying'],
    ['duplicate', 'ready_for_review'],
    ['needs_manual_classification', 'classifying'],
    ['ready_for_review', 'classifying'],
    ['failed', 'ready_for_review'],
    ['saved', 'queued'],
    ['saved', 'rejected'],
    ['rejected', 'queued'],
    ['classifying', 'saved'],
  ];
  for (const [from, to] of forbidden) {
    const evaluated = stateMachine.evaluateTransition(from, to);
    assert.equal(evaluated.kind, 'rejected', `${from} -> ${to} must be rejected`);
    assert.equal(evaluated.reason, 'candidate_invalid_transition');
  }
});

test('a self-transition is rejected rather than treated as progress', () => {
  for (const status of types.CLOSET_CANDIDATE_STATUSES) {
    assert.equal(stateMachine.canTransition(status, status), false, status);
  }
});

test('unknown and malformed statuses fail closed', () => {
  for (const bad of [null, undefined, '', 'QUEUED', 'promoted', 42, {}, []]) {
    assert.equal(stateMachine.canTransition(bad, 'queued'), false);
    assert.equal(stateMachine.canTransition('queued', bad), false);
    assert.equal(stateMachine.isClosetCandidateStatus(bad), false);
  }
});

test('only queued and duplicate are legal initial statuses', () => {
  for (const status of types.CLOSET_CANDIDATE_STATUSES) {
    const expected = status === 'queued' || status === 'duplicate';
    assert.equal(stateMachine.isLegalInitialStatus(status), expected, status);
  }
});

test('saved and rejected are terminal and count as resolved', () => {
  assert.deepEqual([...types.CLOSET_CANDIDATE_TERMINAL_STATUSES], ['saved', 'rejected']);
  for (const status of types.CLOSET_CANDIDATE_STATUSES) {
    const terminal = status === 'saved' || status === 'rejected';
    assert.equal(stateMachine.isTerminalStatus(status), terminal, status);
    assert.equal(stateMachine.isUnresolvedStatus(status), !terminal, status);
    if (terminal) {
      assert.deepEqual([...stateMachine.CLOSET_CANDIDATE_TRANSITIONS[status]], []);
    }
  }
});

test('rejection is reachable from every non-terminal state', () => {
  for (const status of types.CLOSET_CANDIDATE_STATUSES) {
    if (stateMachine.isTerminalStatus(status) || status === 'saving') continue;
    assert.equal(stateMachine.canTransition(status, 'rejected'), true, status);
  }
});

test('UI metadata is derived per status and fails closed on an unknown one', () => {
  for (const status of types.CLOSET_CANDIDATE_STATUSES) {
    const meta = stateMachine.statusUIMetadata(status);
    assert.equal(typeof meta.progressLabel, 'string');
    assert.ok(meta.progressLabel.length > 0);
    for (const key of ['isActionable', 'canRetry', 'canEditMetadata', 'canReject']) {
      assert.equal(typeof meta[key], 'boolean', `${status}.${key}`);
    }
  }
  assert.equal(stateMachine.statusUIMetadata('needs_manual_classification').canEditMetadata, true);
  assert.equal(stateMachine.statusUIMetadata('failed').canRetry, true);
  assert.equal(stateMachine.statusUIMetadata('classifying').canRetry, false);
  const unknown = stateMachine.statusUIMetadata('some_future_status');
  assert.equal(unknown.isActionable, false);
  assert.equal(unknown.canRetry, false);
});

// ── Error registry ───────────────────────────────────────────────────────────

test('every declared error code has exactly one registry entry', () => {
  for (const code of types.CLOSET_CANDIDATE_ERROR_CODES) {
    const spec = errors.closetCandidateErrorSpec(code);
    assert.ok(spec, `missing registry entry: ${code}`);
    assert.equal(typeof spec.retryable, 'boolean');
    assert.equal(typeof spec.message, 'string');
    assert.ok(spec.message.length > 0);
    assert.ok(errors.CLOSET_CANDIDATE_ERROR_CATEGORIES.includes(spec.category), code);
    assert.ok(errors.CLOSET_CANDIDATE_RECOVERY_ACTIONS.includes(spec.recovery), code);
    if (spec.transition !== null) {
      assert.ok(stateMachine.isClosetCandidateStatus(spec.transition), code);
    }
  }
  assert.equal(
    Object.keys(errors.__closetCandidateErrorRegistry).length,
    types.CLOSET_CANDIDATE_ERROR_CODES.length,
  );
});

test('the registry contains every code the build specification requires', () => {
  const required = [
    'candidate_limit_reached',
    'candidate_storage_insufficient',
    'candidate_media_unreadable',
    'candidate_media_unsupported',
    'candidate_media_normalization_failed',
    'candidate_hash_failed',
    'duplicate_active_candidate',
    'already_in_closet',
    'candidate_invalid_transition',
    'candidate_expired',
    'candidate_actor_stale',
    'candidate_actor_required',
    'candidate_request_aborted',
    'candidate_offline',
    'classification_timeout',
    'classification_rate_limited',
    'classification_quota_exhausted',
    'classification_auth_failed',
    'classification_malformed_response',
    'classification_requires_manual_category',
    'classification_interrupted',
    'classification_interrupted_repeatedly',
    'candidate_store_corrupt',
    'candidate_persist_failed',
    'candidate_cleanup_failed',
  ];
  for (const code of required) {
    assert.ok(types.CLOSET_CANDIDATE_ERROR_CODES.includes(code), `missing code: ${code}`);
  }
});

test('non-retryable codes are never automatically retried', () => {
  const mustNotAutoRetry = [
    'candidate_media_unreadable',
    'candidate_media_unsupported',
    'candidate_media_normalization_failed',
    'classification_auth_failed',
    'candidate_actor_stale',
    'candidate_actor_required',
    'candidate_expired',
    'candidate_store_corrupt',
    'classification_requires_manual_category',
    'candidate_storage_insufficient',
    'classification_interrupted_repeatedly',
    'classification_quota_exhausted',
    'classification_contract_rejected',
  ];
  for (const code of mustNotAutoRetry) {
    assert.equal(errors.isAutomaticallyRetryable(code), false, code);
  }
  for (const code of ['candidate_offline', 'classification_timeout', 'classification_rate_limited']) {
    assert.equal(errors.isAutomaticallyRetryable(code), true, code);
  }
});

test('manual classification is not modelled as a technical failure', () => {
  const spec = errors.closetCandidateErrorSpec('classification_requires_manual_category');
  assert.equal(spec.transition, 'needs_manual_classification');
  assert.equal(spec.recovery, 'choose_category');
  assert.equal(spec.retryable, false);
});

test('an unknown code yields the generic message and no fabricated spec', () => {
  assert.equal(errors.closetCandidateErrorSpec('not_a_code'), null);
  assert.equal(errors.closetCandidateErrorMessage('not_a_code'), errors.CLOSET_CANDIDATE_GENERIC_MESSAGE);
  assert.equal(errors.isAutomaticallyRetryable('not_a_code'), false);
});

test('no user-facing message leaks a raw backend or provider shape', () => {
  for (const code of types.CLOSET_CANDIDATE_ERROR_CODES) {
    const message = errors.closetCandidateErrorMessage(code);
    assert.ok(!/https?:\/\//i.test(message), code);
    assert.ok(!/file:\/\/|content:\/\/|ph:\/\//i.test(message), code);
    assert.ok(!/base64|token|supabase|gemini|llama/i.test(message), code);
  }
});

// ── Identifiers ──────────────────────────────────────────────────────────────

test('candidate and batch identifiers are unique and correctly prefixed', () => {
  const candidateIds = new Set();
  const batchIds = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const candidateId = schema.createClosetCandidateId();
    const batchId = schema.createClosetBatchId();
    assert.ok(candidateId.startsWith('candidate_'), candidateId);
    assert.ok(batchId.startsWith('batch_'), batchId);
    candidateIds.add(candidateId);
    batchIds.add(batchId);
  }
  assert.equal(candidateIds.size, 2000);
  assert.equal(batchIds.size, 2000);
});

test('identifiers combine timestamp, counter and randomness — not one of them', () => {
  const id = schema.createClosetCandidateId();
  const parts = id.split('_');
  // candidate + timestamp + counter + random
  assert.equal(parts.length, 4);
  assert.ok(parts[1].length > 0, 'timestamp component');
  assert.ok(parts[2].length > 0, 'counter component');
  assert.ok(parts[3].length >= 8, 'random component must not be trivial');
});

test('identifiers minted concurrently do not collide', async () => {
  const ids = await Promise.all(
    Array.from({ length: 500 }, async () => schema.createClosetCandidateId()),
  );
  assert.equal(new Set(ids).size, 500);
});

// ── Record construction and migration ────────────────────────────────────────

test('the record builder is an allowlist: unknown keys are dropped', () => {
  const now = new Date('2026-07-28T00:00:00.000Z').toISOString();
  const record = schema.buildClosetCandidateRecord(
    {
      sourceType: 'gallery',
      category: 'Jacket',
      // Everything below is hostile and must not survive.
      purchaseOptions: [{ url: 'https://retailer.example/p/1' }],
      recommendedProducts: [{ price: 100 }],
      retailerUrl: 'https://retailer.example',
      signedUrl: 'https://storage.example/signed',
      providerPayload: { raw: 'x' },
      imageBase64: 'AAAA',
      ownerId: 'attacker',
      accessToken: 'secret',
    },
    'owner-1',
    now,
  );
  for (const forbidden of [
    'purchaseOptions',
    'recommendedProducts',
    'retailerUrl',
    'signedUrl',
    'providerPayload',
    'imageBase64',
    'accessToken',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(record, forbidden),
      false,
      `leaked field: ${forbidden}`,
    );
  }
  // Ownership comes from resolved authority, never from the draft.
  assert.equal(record.ownerId, 'owner-1');
  assert.equal(record.category, 'Jacket');
});

test('expiresAt is createdAt + 7 days and is stamped once', () => {
  const createdAt = '2026-07-01T00:00:00.000Z';
  const record = schema.buildClosetCandidateRecord({}, 'owner-1', createdAt, { createdAt });
  assert.equal(
    Date.parse(record.expiresAt) - Date.parse(record.createdAt),
    types.CLOSET_CANDIDATE_TTL_MS,
  );
});

test('a greenfield v3 record round-trips through migration unchanged in identity', () => {
  const now = '2026-07-28T00:00:00.000Z';
  const original = schema.buildClosetCandidateRecord(
    { sourceType: 'camera', category: 'Shirt' },
    'owner-1',
    now,
    { batchPosition: 2 },
  );
  const migrated = schema.migrateClosetCandidateRecord(original);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migratedFrom, 3);
  assert.equal(migrated.record.candidateId, original.candidateId);
  assert.equal(migrated.record.batchId, original.batchId);
  assert.equal(migrated.record.batchPosition, 2);
  assert.equal(migrated.record.ownerId, 'owner-1');
  assert.equal(migrated.record.createdAt, original.createdAt);
  assert.equal(migrated.record.expiresAt, original.expiresAt);
});

test('a Build 1 record without batch position remains readable as unordered', () => {
  const migrated = schema.migrateClosetCandidateRecord({
    schemaVersion: 1,
    candidateId: 'candidate_build_1',
    batchId: 'batch_build_1',
    ownerId: 'owner-1',
    sourceType: 'gallery',
    status: 'queued',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.record.batchPosition, null);
});

test('the v0 -> v1 migration mechanism actually runs', () => {
  const raw = {
    candidateId: 'candidate_x',
    batchId: 'batch_x',
    ownerId: 'owner-1',
    sourceType: 'gallery',
    status: 'queued',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
    // no schemaVersion => treated as v0
  };
  const frozenCopy = JSON.parse(JSON.stringify(raw));
  const migrated = schema.migrateClosetCandidateRecord(raw);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migratedFrom, 0);
  assert.equal(migrated.record.schemaVersion, 3);
  // The raw record must never be mutated in place.
  assert.deepEqual(raw, frozenCopy);
});

test('the v2 -> v3 migration adds an empty promotion tombstone, never a fabricated one', () => {
  const migrated = schema.migrateClosetCandidateRecord({
    schemaVersion: 2,
    candidateId: 'candidate_v2',
    batchId: 'batch_v2',
    batchPosition: 1,
    ownerId: 'owner-1',
    sourceType: 'gallery',
    status: 'ready_for_review',
    category: 'Outerwear',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.record.schemaVersion, 3);
  assert.equal(migrated.record.promotedClosetItemId, null);
  assert.equal(migrated.record.promotedAt, null);
  // Everything the record already carried survives the step untouched.
  assert.equal(migrated.record.status, 'ready_for_review');
  assert.equal(migrated.record.batchPosition, 1);
  assert.equal(migrated.record.category, 'Outerwear');
});

test('a promotion tombstone survives reconstruction through the allowlist', () => {
  const migrated = schema.migrateClosetCandidateRecord({
    schemaVersion: 3,
    candidateId: 'candidate_promoted',
    batchId: 'batch_promoted',
    batchPosition: 0,
    ownerId: 'owner-1',
    sourceType: 'gallery',
    status: 'saved',
    category: 'Outerwear',
    candidateImageUri: '/doc/kscan_closet_candidates/images/a.jpg',
    promotedClosetItemId: 'closet_abc',
    promotedAt: '2026-07-02T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.record.promotedClosetItemId, 'closet_abc');
  assert.equal(migrated.record.promotedAt, '2026-07-02T00:00:00.000Z');
  assert.equal(migrated.record.status, 'saved');
  // The tombstone keeps pointing at its own candidate media, which is what keeps
  // the orphan collector away from those files until Phase 4 owns cleanup.
  assert.equal(
    migrated.record.candidateImageUri,
    '/doc/kscan_closet_candidates/images/a.jpg',
  );
});

test('an unsupported FUTURE schema version is rejected, never reinterpreted', () => {
  const result = schema.migrateClosetCandidateRecord({
    schemaVersion: 99,
    candidateId: 'candidate_future',
    batchId: 'batch_future',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
  });
  assert.equal(result.ok, false);
  // Reported DISTINCTLY from corruption. A newer build wrote this record; it is
  // intact, unreadable by us, and must never be treated as damaged data that a
  // write may discard.
  assert.equal(result.errorCode, 'candidate_store_future_schema');
});

test('malformed records are rejected with a stable recovery code and never throw', () => {
  const bad = [
    null,
    undefined,
    42,
    'string',
    [],
    {},
    { candidateId: 'candidate_a' },
    { candidateId: 'candidate_a', batchId: 'batch_a' },
    { candidateId: 'candidate_a', batchId: 'batch_a', createdAt: 'not-a-date', expiresAt: 'x' },
  ];
  for (const entry of bad) {
    const result = schema.migrateClosetCandidateRecord(entry);
    assert.equal(result.ok, false, JSON.stringify(entry));
    assert.equal(result.errorCode, 'candidate_store_corrupt');
  }
});

test('migration reconstructs through the allowlist and drops smuggled keys', () => {
  const result = schema.migrateClosetCandidateRecord({
    schemaVersion: 1,
    candidateId: 'candidate_a',
    batchId: 'batch_a',
    ownerId: 'owner-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
    status: 'ready_for_review',
    purchaseOptions: [{ url: 'https://x.example' }],
    imageBase64: 'AAAA',
  });
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.record, 'purchaseOptions'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.record, 'imageBase64'), false);
  assert.equal(result.record.status, 'ready_for_review');
});

test('an unrecognised status on disk normalizes to queued rather than rendering unknown', () => {
  const result = schema.migrateClosetCandidateRecord({
    schemaVersion: 1,
    candidateId: 'candidate_a',
    batchId: 'batch_a',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
    status: 'promoted_to_closet',
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'queued');
});

// ── Telemetry ────────────────────────────────────────────────────────────────

test('telemetry emits only allowlisted events', () => {
  const seen = [];
  telemetry.setClosetTelemetrySink((event, payload) => seen.push([event, payload]));
  telemetry.emitClosetCandidateEvent('closet_candidate_created', { sourceType: 'gallery' });
  telemetry.emitClosetCandidateEvent('not_an_event', { sourceType: 'gallery' });
  telemetry.resetClosetTelemetrySink();
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'closet_candidate_created');
});

test('telemetry drops unknown properties and every unsafe value shape', () => {
  const seen = [];
  telemetry.setClosetTelemetrySink((event, payload) => seen.push(payload));
  telemetry.emitClosetCandidateEvent('closet_candidate_created', {
    sourceType: 'gallery',
    // Unknown keys.
    title: 'My favourite Gucci jacket',
    brand: 'Gucci',
    ownerId: 'user-uuid-1234',
    email: 'someone@example.com',
    imageBase64: 'AAAABBBB',
    // Known key, unsafe values.
    status: 'file:///data/user/0/photo.jpg',
    errorCode: 'https://retailer.example/p/1',
    countBucket: Number.NaN,
  });
  telemetry.resetClosetTelemetrySink();
  const payload = seen[0];
  assert.deepEqual(Object.keys(payload), ['sourceType']);
  assert.equal(payload.sourceType, 'gallery');
});

test('telemetry never throws and never blocks business logic', () => {
  telemetry.setClosetTelemetrySink(() => {
    throw new Error('sink exploded');
  });
  assert.doesNotThrow(() =>
    telemetry.emitClosetCandidateEvent('closet_candidate_created', { sourceType: 'camera' }),
  );
  telemetry.resetClosetTelemetrySink();
});

test('the telemetry safe-string shape cannot express a URI, path, or email', () => {
  const { SAFE_STRING } = telemetry.__closetTelemetryInternals;
  for (const value of [
    'file:///data/photo.jpg',
    'content://media/external/images/1',
    'ph://ABCD-1234',
    'C:\\Users\\jsmit\\photo.jpg',
    '/data/user/0/kscan/photo.jpg',
    'someone@example.com',
    'https://retailer.example/p/1?ref=x',
    'a brand name with spaces',
  ]) {
    assert.equal(SAFE_STRING.test(value), false, value);
  }
  for (const value of ['gallery', 'ready_for_review', 'candidate_offline', 'sha256-normalized-v1']) {
    assert.equal(SAFE_STRING.test(value), true, value);
  }
});

// ── Connectivity port ────────────────────────────────────────────────────────

test('the connectivity default is optimistic and learns from network failures', async () => {
  connectivity.resetClosetConnectivityProvider();
  assert.equal(await connectivity.isClosetOnline(), true);
  connectivity.noteClosetNetworkFailure(new Error('Network request failed'));
  assert.equal(await connectivity.isClosetOnline(), false);
  connectivity.noteClosetNetworkSuccess();
  assert.equal(await connectivity.isClosetOnline(), true);
});

test('a non-network error does not park the port offline', async () => {
  connectivity.resetClosetConnectivityProvider();
  connectivity.noteClosetNetworkFailure(new Error('Unexpected token < in JSON'));
  assert.equal(await connectivity.isClosetOnline(), true);
});

test('the connectivity port is injectable and a throwing provider fails toward online', async () => {
  connectivity.setClosetConnectivityProvider({ isOnline: () => false });
  assert.equal(await connectivity.isClosetOnline(), false);
  connectivity.setClosetConnectivityProvider({
    isOnline: () => {
      throw new Error('provider exploded');
    },
  });
  assert.equal(await connectivity.isClosetOnline(), true);
  connectivity.resetClosetConnectivityProvider();
});

test('refresh restores optimism so a reconnect pass can proceed', async () => {
  connectivity.resetClosetConnectivityProvider();
  connectivity.noteClosetNetworkFailure('network request failed');
  assert.equal(await connectivity.isClosetOnline(), false);
  connectivity.refreshClosetConnectivity();
  assert.equal(await connectivity.isClosetOnline(), true);
});
