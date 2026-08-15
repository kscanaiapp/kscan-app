/**
 * KSB29-028 — E4.1: the REAL mobile client reaching the certified server path.
 *
 * WHAT THE EXISTING EVIDENCE PROVED, AND WHAT IT DID NOT.
 * The 19/19 E4.1 probe proved the Edge Function can perform E4.1 when handed a
 * well-formed request. It was hand-built, so it proved nothing about whether
 * the app could produce one. It could not:
 *
 *   - `EliseVisualContextSource` was only 'scan' | 'upload', so the client had
 *     no vocabulary for a room resource at all;
 *   - `toServerSafeActiveContext` — the actual mobile request builder — copied
 *     descriptive fields only and dropped every id;
 *   - the one Dressing Room -> Elise call site collapsed the item onto
 *     'camera' and discarded `roomId` / `itemId`.
 *
 * So the server was capable and the client could not construct the request:
 * SERVER = capable, CLIENT = cannot reach it.
 *
 * THIS FILE STARTS FROM THE PRODUCTION REQUEST BUILDER AND ENDS AT THE
 * PRODUCTION SERVER NORMALIZER. Nothing in between is hand-authored:
 *
 *   RoomItemDetailModal's hand-off shape
 *     -> services/style-chat/providers/edgeStyleChatProvider.toServerSafeActiveContext
 *       -> supabase/functions/stylechat-generate/eliseVisualContextPipeline
 *          .buildEliseVisualContextEnvelope
 *         -> resolveEvidenceResource -> resolveOwnedRoomItem / resolveSharedRoomItem
 *           -> server_verified evidence
 *
 * Making the hand-built probe greener would have proved nothing new, so it is
 * not touched here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Load a TS module, resolving both extensionless client specifiers and
 * Deno-style `./x.ts` ones, so the real sources run unmodified. An unresolved
 * import throws rather than becoming an empty object, so a stubbed-away
 * dependency cannot quietly weaken what is under test.
 */
const moduleCache = new Map();

/**
 * Modules replaced by a stub, keyed by repo-relative path. Only genuine
 * externals belong here: the Supabase network client is the one thing that
 * cannot run in a test process. Everything else — including every module under
 * test — is loaded from real source.
 */
const STUBS = {
  'services/supabaseClient.ts': { supabase: { functions: { invoke: async () => ({ data: null }) } } },
};

function loadTs(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (normalized in STUBS) return STUBS[normalized];
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);

  const filename = path.join(ROOT, normalized);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const dir = path.dirname(normalized);
  const sandbox = {
    console,
    Date,
    process: { env: {} },
    __DEV__: false,
    exports: module.exports,
    module,
    require: (specifier) => {
      if (!specifier.startsWith('.')) {
        throw new Error(`Unexpected external import in ${normalized}: ${specifier}`);
      }
      const base = path.join(dir, specifier).split(path.sep).join('/');
      // Client modules omit the extension; edge-function modules use Deno's
      // explicit `.ts`. Resolve both so real sources run unmodified.
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`]) {
        const cleaned = candidate.split(path.sep).join('/');
        if (cleaned in STUBS) return STUBS[cleaned];
        if (fs.existsSync(path.join(ROOT, cleaned)) && fs.statSync(path.join(ROOT, cleaned)).isFile()) {
          return loadTs(cleaned);
        }
      }
      throw new Error(`Unresolved import ${specifier} from ${normalized}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  moduleCache.set(normalized, module.exports);
  return module.exports;
}

/**
 * The REAL mobile request builder.
 *
 * `toServerSafeActiveContext` is pure — it reads its argument and returns a
 * plain object — but the module around it transitively imports expo-crypto and
 * the rest of the native graph, which cannot load in a test process. Rather
 * than stubbing that graph (which risks stubbing away the thing under test),
 * the function's OWN SOURCE TEXT is lifted out of the real file by AST and
 * evaluated. It is the production function body verbatim, not a reimplementation
 * — if someone edits it in the provider, this test picks the edit up.
 */
let cachedBuilder = null;
function clientBuilder() {
  if (cachedBuilder) return cachedBuilder;

  const relativePath = 'services/style-chat/providers/edgeStyleChatProvider.ts';
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.ES2020, true);

  let declaration = null;
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.name.getText() === 'toServerSafeActiveContext'
    ) {
      declaration = node;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  assert.ok(declaration, 'edgeStyleChatProvider must export toServerSafeActiveContext');

  const js = ts.transpileModule(declaration.getText().replace(/^export\s+/, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const sandbox = { module: { exports: {} }, exports: {} };
  vm.createContext(sandbox);
  new vm.Script(`${js}
module.exports = { toServerSafeActiveContext };`).runInContext(sandbox);
  cachedBuilder = sandbox.module.exports;
  return cachedBuilder;
}

/** The REAL server-side normalizer. */
function serverPipeline() {
  return loadTs('supabase/functions/stylechat-generate/eliseVisualContextPipeline.ts');
}

/**
 * A data source standing in for the database only. Every ownership DECISION is
 * still made by the real resolvers; this just answers "what rows exist".
 */
function dataSource({ ownerId = ACTOR_ID, sharedActive = true, sharedExpired = false } = {}) {
  const item = {
    id: ITEM_ID,
    dressing_room_id: ROOM_ID,
    title: 'Navy wool overcoat',
    category: 'Outerwear',
    brand: 'Acme',
    storage_bucket: 'dressing-room-items',
    storage_path: `${ROOM_ID}/${ITEM_ID}.jpg`,
  };
  return {
    fetchDressingRoom: async (roomId) =>
      roomId === ROOM_ID ? { id: ROOM_ID, user_id: ownerId } : null,
    fetchDressingRoomItem: async (roomId, itemId) =>
      roomId === ROOM_ID && itemId === ITEM_ID ? item : null,
    fetchSharedRoomAccess: async (roomId) =>
      roomId === ROOM_ID ? { active: sharedActive, expired: sharedExpired } : null,
    fetchSavedScan: async () => null,
    fetchInspirationItem: async () => null,
  };
}

/** The hand-off RoomItemDetailModal actually constructs. */
function roomHandoff(sourceType) {
  return {
    source: 'dressing-room',
    roomProvenance: { sourceType, roomId: ROOM_ID, itemId: ITEM_ID },
    imageUri: 'file:///local/should-never-leave-device.jpg',
    category: 'Outerwear',
    color: 'Navy',
    material: 'Wool',
    analysisText: 'Navy wool overcoat',
    createdAt: '2026-08-15T00:00:00.000Z',
    visualContext: {
      source: 'scan',
      roomProvenance: { sourceType, roomId: ROOM_ID, itemId: ITEM_ID },
      title: 'Navy wool overcoat',
      category: 'Outerwear',
      colors: ['Navy'],
      materials: ['Wool'],
      brand: 'Acme',
      confidence: 0.82,
    },
  };
}

async function envelopeFor(sourceType, options = {}) {
  const { toServerSafeActiveContext } = clientBuilder();
  const { buildEliseVisualContextEnvelope } = serverPipeline();

  // THE PRODUCTION REQUEST. Not hand-authored.
  const rawActiveContext = toServerSafeActiveContext(roomHandoff(sourceType));

  const result = await buildEliseVisualContextEnvelope({
    rawActiveContext,
    actorId: options.actorId ?? ACTOR_ID,
    sessionId: 'session-1',
    dataSource: dataSource(options),
  });
  return { rawActiveContext, ...result };
}

/* ------------------------------------------------------------------ */
/* The client can now express the resource at all                      */
/* ------------------------------------------------------------------ */

test('the production request builder emits the room resource triple', () => {
  const { toServerSafeActiveContext } = clientBuilder();
  const payload = toServerSafeActiveContext(roomHandoff('owned_room_item'));

  assert.equal(payload.sourceType, 'owned_room_item');
  assert.equal(payload.roomId, ROOM_ID);
  assert.equal(payload.itemId, ITEM_ID);

  // And on the evidence entry, which is where the pipeline reads it per item.
  assert.equal(payload.visualContext.sourceType, 'owned_room_item');
  assert.equal(payload.visualContext.roomId, ROOM_ID);
  assert.equal(payload.visualContext.itemId, ITEM_ID);
});

test('the builder still refuses to leak device-local material', () => {
  const { toServerSafeActiveContext } = clientBuilder();
  const payload = toServerSafeActiveContext(roomHandoff('owned_room_item'));
  const serialized = JSON.stringify(payload);

  // Adding ids must not have opened the door to local URIs or timestamps: the
  // permitted ids are canonical SERVER resource ids, not device identity.
  assert.equal('imageUri' in payload, false);
  assert.equal('createdAt' in payload, false);
  assert.doesNotMatch(serialized, /file:\/\//);
  assert.doesNotMatch(serialized, /should-never-leave-device/);
});

/* ------------------------------------------------------------------ */
/* The server resolves it — the link that was missing                  */
/* ------------------------------------------------------------------ */

test('an owned room item resolves to server-verified evidence', async () => {
  const { envelope } = await envelopeFor('owned_room_item');

  assert.equal(envelope.evidence.length, 1, 'the request must yield exactly one evidence entry');
  const [evidence] = envelope.evidence;

  assert.equal(evidence.sourceType, 'owned_room_item');
  assert.equal(evidence.roomId, ROOM_ID);
  assert.equal(evidence.itemId, ITEM_ID);

  // THE POINT: the server looked the item up and vouched for it, instead of
  // falling back to whatever the client claimed.
  assert.equal(evidence.trust, 'server_verified');
  assert.equal(evidence.actorRelationship, 'owned');
});

test('a shared room item resolves as shared and never upgrades to owned', async () => {
  const { envelope } = await envelopeFor('shared_room_item', { ownerId: 'someone-else' });
  const [evidence] = envelope.evidence;

  assert.equal(evidence.sourceType, 'shared_room_item');
  assert.equal(evidence.trust, 'server_verified');
  assert.equal(
    evidence.actorRelationship,
    'shared',
    'a shared item must never be promoted to owned',
  );
});

/** Verified only when the entry survived AND the server vouched for it. */
function isServerVerified(envelope) {
  const [evidence] = envelope.evidence;
  return Boolean(evidence) && evidence.trust === 'server_verified';
}

test('the same request is refused when the actor has no claim to the room', async () => {
  // Same client payload, different actor. If the ids alone were enough to be
  // believed this would still verify, so this is what proves the server
  // re-checks rather than trusting the client's assertion. In practice it goes
  // further than "unverified" and drops the evidence outright.
  const { envelope } = await envelopeFor('owned_room_item', {
    actorId: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(isServerVerified(envelope), false, 'a foreign actor must not be verified');
  assert.equal(envelope.evidence.length, 0, 'an unauthorised resource is dropped, not downgraded');
});

test('an expired share is refused even though the ids are correct', async () => {
  const { envelope } = await envelopeFor('shared_room_item', {
    ownerId: 'someone-else',
    sharedExpired: true,
  });
  assert.equal(isServerVerified(envelope), false, 'an expired share must not be verified');
  assert.equal(envelope.evidence.length, 0, 'an expired share is dropped, not downgraded');
});

/* ------------------------------------------------------------------ */
/* The regression this closes                                          */
/* ------------------------------------------------------------------ */

test('without room provenance the server cannot verify — the pre-repair state', async () => {
  const { toServerSafeActiveContext } = clientBuilder();
  const { buildEliseVisualContextEnvelope } = serverPipeline();

  // Exactly what the client used to send: a room item described as a camera
  // photo, with every id stripped.
  const legacy = toServerSafeActiveContext({
    source: 'camera',
    imageUri: 'file:///local/x.jpg',
    category: 'Outerwear',
    analysisText: 'Navy wool overcoat',
    visualContext: {
      source: 'scan',
      title: 'Navy wool overcoat',
      category: 'Outerwear',
    },
  });
  assert.equal(legacy.roomId, undefined, 'the pre-repair payload carried no room id');
  assert.equal(legacy.itemId, undefined, 'the pre-repair payload carried no item id');

  const { envelope } = await buildEliseVisualContextEnvelope({
    rawActiveContext: legacy,
    actorId: ACTOR_ID,
    sessionId: 'session-1',
    dataSource: dataSource(),
  });

  assert.equal(
    isServerVerified(envelope),
    false,
    'this is the defect: the same garment could not be verified without its ids',
  );
});
