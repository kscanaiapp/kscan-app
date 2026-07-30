// Private Dressing Room ↔ Elise versioned contract (Build 3, Phase 4, Commit 1).
//
// Covers the three properties that make a two-runtime contract safe:
//
//   1. IMPORT SAFETY — the governing module and its Edge mirror execute with a
//      `require` shim that throws on ANY specifier. An import added to either
//      file fails here, which is what stops client-only code (React Native,
//      AsyncStorage, navigation, stores) being pulled into a function bundle.
//   2. MIRROR PARITY — the shared body is byte-identical, so the client and the
//      Edge Function can never disagree about what is legal.
//   3. FAIL-CLOSED VALIDATION — unknown versions, intents, statuses, fields and
//      aliases are rejected rather than coerced.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MOBILE_PATH = 'types/privateDressingRoomElise.ts';
const EDGE_PATH = 'supabase/functions/style-outfit-generate/privateDressingRoomEliseContract.ts';
const BODY_MARKER = '// ── Schema version ';

/**
 * Loads a TS module with NO import budget at all.
 *
 * The require shim throws on every specifier, so this only succeeds for a
 * genuinely dependency-free module. That is the import-safety gate, not a
 * convenience.
 */
function loadPureModule(relativePath) {
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
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

/** Recursive loader for the authoritative (non-pure) production modules. */
const moduleCache = new Map();
function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier === 'expo-crypto') {
      return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 17) % 256) };
    }
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  const sandbox = { exports: mod.exports, module: mod, require: localRequire, console };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const contract = loadPureModule(MOBILE_PATH);
const edgeContract = loadPureModule(EDGE_PATH);
const composition = loadModule('types/privateDressingRoomComposition.ts');
const composer = loadModule('services/privateDressingRoomComposer.ts');
const fashionReasoning = loadModule('types/fashionReasoning.ts');

/**
 * Structural comparison across `vm` realm boundaries.
 *
 * Modules loaded above run in their own vm context, so objects they return have
 * a different Object.prototype and `deepStrictEqual` reports "same structure but
 * not reference-equal" for values that are in fact identical. Round-tripping
 * both sides through JSON normalizes the realm without weakening the check.
 */
function same(actual, expected, message) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
    message,
  );
}

const REQ = '3f9a2b1c-0000-4000-8000-000000000001';
const FRAGMENT = '3f9a2b1c';
const alias = (index) => `item_${FRAGMENT}_${index}`;

function baseCandidate(index, overrides = {}) {
  return { ref: alias(index), slot: 'top', ...overrides };
}

function occasionRequest(overrides = {}) {
  return {
    schemaVersion: 'private-dressing-room-elise-v1',
    requestId: REQ,
    intent: 'interpret_occasion',
    instruction: 'dinner with clients',
    ...overrides,
  };
}

function anchorRequest(overrides = {}) {
  return {
    schemaVersion: 'private-dressing-room-elise-v1',
    requestId: REQ,
    intent: 'build_around_item',
    instruction: 'build around this',
    anchorRef: alias(1),
    candidates: [baseCandidate(1, { slot: 'outerwear', isAnchor: true }), baseCandidate(2)],
    ...overrides,
  };
}

// ── 1. Import safety ──────────────────────────────────────────────────────────

test('the contract and its mirror execute with zero imports available', () => {
  // loadPureModule threw on any specifier; reaching here proves both modules
  // are dependency-free. Re-assert explicitly so the intent is not implicit.
  assert.equal(typeof contract.parsePrivateEliseRequest, 'function');
  assert.equal(typeof edgeContract.parsePrivateEliseRequest, 'function');

  for (const relativePath of [MOBILE_PATH, EDGE_PATH]) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    // Comments are stripped first: these files DOCUMENT the runtimes they must
    // not touch, and a prose mention is not a dependency.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /^\s*import\s/m, `${relativePath} must not import`);
    assert.doesNotMatch(code, /\brequire\s*\(/, `${relativePath} must not require`);
    assert.doesNotMatch(code, /\bDeno\b/, `${relativePath} must not use Deno APIs`);
    assert.doesNotMatch(code, /\bprocess\.|\bglobalThis\.|\b__DEV__\b/,
      `${relativePath} must not read runtime globals`);
    assert.doesNotMatch(
      code,
      /\b(?:React|AsyncStorage|SecureStore|Platform|Dimensions|useState|useEffect)\b/,
      `${relativePath} must not reference client-only APIs`,
    );
  }
});

// ── 2. Mirror parity ──────────────────────────────────────────────────────────

test('the Edge mirror body is byte-identical to the governing source', () => {
  const mobile = fs.readFileSync(path.join(ROOT, MOBILE_PATH), 'utf8');
  const edge = fs.readFileSync(path.join(ROOT, EDGE_PATH), 'utf8');
  const mobileBody = mobile.slice(mobile.indexOf(BODY_MARKER));
  const edgeBody = edge.slice(edge.indexOf(BODY_MARKER));
  assert.ok(mobileBody.length > 0 && edgeBody.length > 0, 'body marker missing');
  assert.equal(edgeBody, mobileBody, 'Edge mirror has drifted from types/privateDressingRoomElise.ts');
});

test('both runtimes expose the same vocabularies and agree on validation', () => {
  for (const key of [
    'PRIVATE_ELISE_INTENTS',
    'PRIVATE_ELISE_STATUSES',
    'PRIVATE_ELISE_SLOTS',
    'PRIVATE_ELISE_OCCASION_GROUPS',
    'PRIVATE_ELISE_DRESS_CODES',
    'PRIVATE_ELISE_OCCASIONS',
    'PRIVATE_ELISE_CANDIDATE_FIELDS',
  ]) {
    same([...edgeContract[key]], [...contract[key]], `${key} mismatch`);
  }
  assert.equal(
    edgeContract.PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
    contract.PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
  );
  // Same input, same verdict, on both sides.
  const body = anchorRequest();
  same(edgeContract.parsePrivateEliseRequest(body), contract.parsePrivateEliseRequest(body));
});

// ── 3. Vocabularies mirror production, and are not invented ───────────────────

test('contract vocabularies equal their authoritative production sources', () => {
  same([...contract.PRIVATE_ELISE_SLOTS], [...composition.PRIVATE_SLOTS]);
  same(
    [...contract.PRIVATE_ELISE_OCCASION_GROUPS],
    [...composition.PRIVATE_OCCASION_GROUPS],
  );
  same(
    [...contract.PRIVATE_ELISE_DRESS_CODES],
    [...fashionReasoning.OUTFIT_DRESS_CODES],
  );
});

test('every occasion Elise may return is one the production composer resolves', () => {
  // Elise SELECTS an existing value; it never creates one. If any of these fell
  // through to 'neutral' the composer would silently ignore the change.
  const expected = {
    Work: 'work',
    Dinner: 'evening',
    Weekend: 'casual',
    Event: 'evening',
    Travel: 'travel',
    Smart: 'smart_casual',
  };
  for (const occasion of contract.PRIVATE_ELISE_OCCASIONS) {
    const group = composer.occasionGroupFor(occasion);
    assert.equal(group, expected[occasion], `${occasion} resolved to ${group}`);
    assert.ok(
      contract.isPrivateEliseOccasionGroup(group),
      `${occasion} produced a group outside the contract`,
    );
  }
});

test("the route's own occasion chips are all returnable by Elise", () => {
  const routeSource = fs.readFileSync(path.join(ROOT, 'app/stylist/dressing-room/index.tsx'), 'utf8');
  const declaration = routeSource.match(/const OCCASIONS = \[([^\]]+)\]/);
  assert.ok(declaration, 'route occasion chips not found');
  const chips = declaration[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const chip of chips) {
    assert.ok(
      contract.isPrivateEliseOccasion(chip),
      `chip ${chip} is not a value Elise may return`,
    );
  }
});

// ── 4. Aliases ────────────────────────────────────────────────────────────────

test('aliases are request-qualified and never derived from a Closet identity', () => {
  assert.equal(contract.buildRequestAlias(REQ, 1), `item_${FRAGMENT}_1`);
  assert.equal(contract.aliasFragmentForRequest(REQ), FRAGMENT);
  // Two different requests never mint the same alias.
  const other = 'aaaabbbb-0000-4000-8000-000000000002';
  assert.notEqual(contract.buildRequestAlias(other, 1), contract.buildRequestAlias(REQ, 1));
  // A non-hex request id still produces a well-formed, padded fragment.
  assert.match(contract.buildRequestAlias('zzz', 1), /^item_[0-9a-f]{8}_1$/);
});

test('alias shape checks reject Closet ids, storage keys and out-of-range indexes', () => {
  assert.equal(contract.isWellFormedAlias('closet_12345'), false);
  assert.equal(contract.isWellFormedAlias('item_3f9a2b1c_0'), false);
  assert.equal(contract.isWellFormedAlias('item_3f9a2b1c_21'), false);
  assert.equal(contract.isWellFormedAlias('item_ZZZZZZZZ_1'), false);
  assert.equal(contract.isWellFormedAlias('kscan_closet/items/abc.jpg'), false);
  assert.equal(contract.isWellFormedAlias(alias(20)), true);
  // Correct shape, wrong request — still refused.
  assert.equal(contract.isAliasForRequest('item_deadbeef_1', REQ), false);
  assert.equal(contract.isAliasForRequest(alias(1), REQ), true);
});

// ── 5. Request validation ─────────────────────────────────────────────────────

test('a well-formed occasion request parses and carries no garment pool', () => {
  const parsed = contract.parsePrivateEliseRequest(occasionRequest());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.intent, 'interpret_occasion');
  assert.equal(parsed.request.candidates, undefined);
  assert.equal(parsed.request.anchorRef, undefined);
});

test('a well-formed build_around_item request parses with a bounded pool', () => {
  const parsed = contract.parsePrivateEliseRequest(anchorRequest());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.anchorRef, alias(1));
  assert.equal(parsed.request.candidates.length, 2);
  assert.equal(parsed.request.candidates[0].isAnchor, true);
});

test('unknown schema versions and intents are rejected, never defaulted', () => {
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ schemaVersion: 'private-dressing-room-elise-v2' })),
    { ok: false, error: 'unsupported_schema_version' },
  );
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ schemaVersion: undefined })),
    { ok: false, error: 'unsupported_schema_version' },
  );
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ intent: 'make_more_casual' })),
    { ok: false, error: 'unsupported_intent' },
  );
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ intent: 'delete_closet' })),
    { ok: false, error: 'unsupported_intent' },
  );
});

test('make_more_casual is not a remote intent', () => {
  assert.equal(contract.PRIVATE_ELISE_INTENTS.includes('make_more_casual'), false);
  same([...contract.PRIVATE_ELISE_INTENTS], ['interpret_occasion', 'build_around_item']);
});

test('a candidate carrying any field outside the allowlist is rejected', () => {
  for (const leak of [
    { closetItemId: 'closet-1' },
    { id: 'closet-1' },
    { title: 'My navy blazer' },
    { notes: 'bought in Rome' },
    { imageUri: 'file:///data/user/0/kscan/closet/1.jpg' },
    { thumbnailUri: 'file:///thumb.jpg' },
    { brand: 'Acme' },
    { size: 'M' },
    { actorId: 'actor-1' },
    { silhouette: 'A-line' },
    { texture: 'ribbed' },
    { fit: 'slim' },
    { occasionCompatibility: ['work'] },
  ]) {
    const body = anchorRequest({
      candidates: [baseCandidate(1, { slot: 'outerwear', isAnchor: true, ...leak })],
    });
    same(
      contract.parsePrivateEliseRequest(body),
      { ok: false, error: 'invalid_candidates' },
      `field ${Object.keys(leak)[0]} must be rejected`,
    );
  }
});

test('an oversized candidate pool is rejected rather than truncated', () => {
  const candidates = Array.from({ length: 21 }, (_, index) => baseCandidate(index + 1));
  same(
    contract.parsePrivateEliseRequest(anchorRequest({ candidates })),
    { ok: false, error: 'invalid_candidates' },
  );
  // Exactly at the cap is accepted, so the bound is 20 and not 19.
  const atCap = Array.from({ length: 20 }, (_, index) =>
    baseCandidate(index + 1, index === 0 ? { slot: 'outerwear', isAnchor: true } : {}),
  );
  assert.equal(contract.parsePrivateEliseRequest(anchorRequest({ candidates: atCap })).ok, true);
});

test('aliases from another request cannot enter a candidate pool or anchor', () => {
  same(
    contract.parsePrivateEliseRequest(
      anchorRequest({ candidates: [{ ref: 'item_deadbeef_1', slot: 'top' }], anchorRef: 'item_deadbeef_1' }),
    ),
    { ok: false, error: 'invalid_candidates' },
  );
});

test('duplicate aliases and unknown slots are rejected', () => {
  same(
    contract.parsePrivateEliseRequest(
      anchorRequest({ candidates: [baseCandidate(1, { isAnchor: true }), baseCandidate(1)] }),
    ),
    { ok: false, error: 'invalid_candidates' },
  );
  same(
    contract.parsePrivateEliseRequest(
      anchorRequest({ candidates: [baseCandidate(1, { slot: 'bag', isAnchor: true })] }),
    ),
    { ok: false, error: 'invalid_candidates' },
  );
});

test('the anchor must be present for build_around_item and absent otherwise', () => {
  same(
    contract.parsePrivateEliseRequest(anchorRequest({ anchorRef: undefined })),
    { ok: false, error: 'invalid_anchor_ref' },
  );
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ anchorRef: alias(1) })),
    { ok: false, error: 'invalid_anchor_ref' },
  );
  // An anchor that is not itself in the pool it claims to anchor is rejected.
  same(
    contract.parsePrivateEliseRequest(
      anchorRequest({ anchorRef: alias(3), candidates: [baseCandidate(1), baseCandidate(2)] }),
    ),
    { ok: false, error: 'invalid_anchor_ref' },
  );
});

test('lockedRefs stays bounded to the current anchor-only product model', () => {
  assert.equal(contract.parsePrivateEliseRequest(anchorRequest({ lockedRefs: [] })).ok, true);
  assert.equal(
    contract.parsePrivateEliseRequest(anchorRequest({ lockedRefs: [alias(1)] })).ok,
    true,
  );
  // A non-anchor lock is future behaviour this phase does not build.
  same(
    contract.parsePrivateEliseRequest(anchorRequest({ lockedRefs: [alias(2)] })),
    { ok: false, error: 'invalid_locked_refs' },
  );
  same(
    contract.parsePrivateEliseRequest(anchorRequest({ lockedRefs: [alias(1), alias(2)] })),
    { ok: false, error: 'invalid_locked_refs' },
  );
});

test('instruction and context are bounded and enum-checked', () => {
  const long = 'x'.repeat(500);
  const parsed = contract.parsePrivateEliseRequest(occasionRequest({ instruction: long }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.instruction.length, contract.PRIVATE_ELISE_BOUNDS.instruction);
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ instruction: '   ' })),
    { ok: false, error: 'invalid_instruction' },
  );
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ context: { occasionGroup: 'black_tie' } })),
    { ok: false, error: 'invalid_context' },
  );
  same(
    contract.parsePrivateEliseRequest(occasionRequest({ context: { dressCode: 'black_tie' } })),
    { ok: false, error: 'invalid_context' },
  );
  assert.equal(
    contract.parsePrivateEliseRequest(
      occasionRequest({ context: { occasion: 'Work', occasionGroup: 'work', dressCode: 'dressy' } }),
    ).ok,
    true,
  );
});

test('a request carrying a forbidden identity field is rejected', () => {
  const hostile = occasionRequest({
    actorId: 'actor-1',
    userId: 'user-1',
    sessionId: 'session-1',
    accessToken: 'ey.token',
    email: 'someone@example.com',
    closetItemId: 'closet-1',
  });
  const parsed = contract.parsePrivateEliseRequest(hostile);
  same(parsed, { ok: false, error: 'invalid_request_fields' });
});

// ── 6. Response validation ────────────────────────────────────────────────────

const OCCASION_EXPECT = { requestId: REQ, intent: 'interpret_occasion', authorizedRefs: [] };
const ANCHOR_EXPECT = { requestId: REQ, intent: 'build_around_item', authorizedRefs: [alias(1), alias(2)] };

function occasionResponse(overrides = {}) {
  return {
    schemaVersion: 'private-dressing-room-elise-v1',
    requestId: REQ,
    intent: 'interpret_occasion',
    status: 'success',
    normalizedOccasion: 'Dinner',
    occasionGroup: 'evening',
    ...overrides,
  };
}

test('a valid occasion response parses and is restricted to contract values', () => {
  const parsed = contract.parsePrivateEliseResponse(occasionResponse(), OCCASION_EXPECT);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.response.normalizedOccasion, 'Dinner');
  assert.equal(parsed.response.occasionGroup, 'evening');
});

test('a response for a different request or intent is rejected', () => {
  same(
    contract.parsePrivateEliseResponse(occasionResponse({ requestId: 'other' }), OCCASION_EXPECT),
    { ok: false, error: 'request_id_mismatch' },
  );
  same(
    contract.parsePrivateEliseResponse(occasionResponse({ intent: 'build_around_item' }), OCCASION_EXPECT),
    { ok: false, error: 'intent_mismatch' },
  );
  same(
    contract.parsePrivateEliseResponse(
      occasionResponse({ schemaVersion: 'private-dressing-room-elise-v2' }),
      OCCASION_EXPECT,
    ),
    { ok: false, error: 'unsupported_schema_version' },
  );
});

test('an occasion outside the production vocabulary is rejected', () => {
  for (const invented of ['Gala', 'work', 'Black Tie', '', 42]) {
    same(
      contract.parsePrivateEliseResponse(
        occasionResponse({ normalizedOccasion: invented }),
        OCCASION_EXPECT,
      ),
      { ok: false, error: 'invalid_occasion' },
      `${invented} must be rejected`,
    );
  }
});

test('aliases outside the authorized request set fail closed', () => {
  same(
    contract.parsePrivateEliseResponse(
      {
        schemaVersion: 'private-dressing-room-elise-v1',
        requestId: REQ,
        intent: 'build_around_item',
        status: 'success',
        anchorRef: alias(3),
      },
      ANCHOR_EXPECT,
    ),
    { ok: false, error: 'invalid_alias' },
  );
  // A raw Closet id offered where an alias belongs is equally refused.
  same(
    contract.parsePrivateEliseResponse(
      {
        schemaVersion: 'private-dressing-room-elise-v1',
        requestId: REQ,
        intent: 'build_around_item',
        status: 'success',
        anchorRef: 'closet-item-1',
      },
      ANCHOR_EXPECT,
    ),
    { ok: false, error: 'invalid_alias' },
  );
  same(
    contract.parsePrivateEliseResponse(
      {
        schemaVersion: 'private-dressing-room-elise-v1',
        requestId: REQ,
        intent: 'build_around_item',
        status: 'success',
        anchorRef: alias(1),
        selectedRefs: [alias(1), alias(3)],
      },
      ANCHOR_EXPECT,
    ),
    { ok: false, error: 'invalid_alias' },
  );
});

test('an empty success is rejected rather than rendered as a win', () => {
  same(
    contract.parsePrivateEliseResponse(
      occasionResponse({ normalizedOccasion: undefined, occasionGroup: undefined }),
      OCCASION_EXPECT,
    ),
    { ok: false, error: 'missing_success_payload' },
  );
  same(
    contract.parsePrivateEliseResponse(
      {
        schemaVersion: 'private-dressing-room-elise-v1',
        requestId: REQ,
        intent: 'build_around_item',
        status: 'success',
      },
      ANCHOR_EXPECT,
    ),
    { ok: false, error: 'missing_success_payload' },
  );
});

test('non-success statuses parse without requiring a payload', () => {
  for (const status of ['clarification_required', 'unsupported', 'invalid_request', 'safe_failure']) {
    const parsed = contract.parsePrivateEliseResponse(
      occasionResponse({ status, normalizedOccasion: undefined, occasionGroup: undefined }),
      OCCASION_EXPECT,
    );
    assert.equal(parsed.ok, true, `${status} should parse`);
    assert.equal(parsed.response.status, status);
  }
  same(
    contract.parsePrivateEliseResponse(occasionResponse({ status: 'navigate' }), OCCASION_EXPECT),
    { ok: false, error: 'unsupported_status' },
  );
});

test('unknown response fields are dropped, never forwarded to the application', () => {
  const parsed = contract.parsePrivateEliseResponse(
    occasionResponse({
      route: '/settings',
      command: 'deleteCloset',
      sql: 'drop table users',
      closetItemId: 'closet-1',
      outfits: [{ items: ['a'] }],
    }),
    OCCASION_EXPECT,
  );
  assert.equal(parsed.ok, true);
  same(Object.keys(parsed.response).sort(), [
    'intent',
    'normalizedOccasion',
    'occasionGroup',
    'requestId',
    'schemaVersion',
    'status',
  ]);
});

test('clarification and display copy are bounded strings', () => {
  const parsed = contract.parsePrivateEliseResponse(
    occasionResponse({ clarification: 'y'.repeat(400), displayCopy: 'z'.repeat(400) }),
    OCCASION_EXPECT,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.response.clarification.length, contract.PRIVATE_ELISE_BOUNDS.clarification);
  assert.equal(parsed.response.displayCopy.length, contract.PRIVATE_ELISE_BOUNDS.displayCopy);
});
