/**
 * Android/Hermes Shared Room request-id coverage.
 *
 * Modules are transpiled into isolated VM contexts so tests can model Hermes'
 * complete absence of global Web Crypto without depending on the Node runtime.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ABSENT = Symbol('absent');
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function loadTsModule(relativePath, requireMap, { cryptoValue = ABSENT } = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    ArrayBuffer,
    clearTimeout,
    console,
    Date,
    Error,
    exports: mod.exports,
    Map,
    Math,
    module: mod,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
    setTimeout,
    Uint8Array,
  };
  if (cryptoValue !== ABSENT) sandbox.crypto = cryptoValue;
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

function loadCollaboration({ cryptoValue = ABSENT, expoCrypto, supabase = {} }) {
  return loadTsModule(
    'services/dressingRoomCollaboration.ts',
    {
      'expo-crypto': expoCrypto,
      './supabaseClient': { supabase },
    },
    { cryptoValue },
  );
}

function validUuid(seed) {
  return `10000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

test('ANDROID request id prefers a valid global crypto.randomUUID implementation', () => {
  let globalCalls = 0;
  let expoCalls = 0;
  const expected = validUuid(1);
  const collab = loadCollaboration({
    cryptoValue: {
      randomUUID: () => {
        globalCalls += 1;
        return expected;
      },
    },
    expoCrypto: {
      randomUUID: () => {
        expoCalls += 1;
        return validUuid(2);
      },
      getRandomBytes: () => new Uint8Array(16),
    },
  });

  assert.equal(collab.createCollabRequestId(), expected);
  assert.equal(globalCalls, 1);
  assert.equal(expoCalls, 0);
  assert.match(expected, UUID_V4_RE);
});

test('ANDROID request id falls back to expo-crypto when global randomUUID is absent', () => {
  let expoCalls = 0;
  const expected = validUuid(3);
  const collab = loadCollaboration({
    cryptoValue: {},
    expoCrypto: {
      randomUUID: () => {
        expoCalls += 1;
        return expected;
      },
      getRandomBytes: () => new Uint8Array(16),
    },
  });

  assert.doesNotThrow(() => collab.createCollabRequestId());
  assert.equal(collab.createCollabRequestId(), expected);
  assert.equal(expoCalls, 2);
});

test('ANDROID NO-GLOBAL-CRYPTO TEST: valid UUID, no ReferenceError', () => {
  const expected = validUuid(4);
  const collab = loadCollaboration({
    expoCrypto: {
      randomUUID: () => expected,
      getRandomBytes: () => new Uint8Array(16),
    },
  });

  let id;
  assert.doesNotThrow(() => {
    id = collab.createCollabRequestId();
  });
  assert.equal(id, expected);
  assert.match(id, UUID_V4_RE);
});

test('ANDROID secure-byte fallback produces canonical UUIDv4 version and variant bits', () => {
  let requestedLength = null;
  const collab = loadCollaboration({
    expoCrypto: {
      randomUUID: undefined,
      getRandomBytes: (length) => {
        requestedLength = length;
        return new Uint8Array(length);
      },
    },
  });

  const id = collab.createCollabRequestId();
  assert.equal(requestedLength, 16);
  assert.equal(id, '00000000-0000-4000-8000-000000000000');
  assert.match(id, UUID_V4_RE);
  assert.equal(id[14], '4');
  assert.match(id[19], /[89ab]/);
});

test('ANDROID secure-byte fallback sample does not deterministically repeat IDs', () => {
  let counter = 0;
  const collab = loadCollaboration({
    expoCrypto: {
      randomUUID: undefined,
      getRandomBytes: (length) => {
        const bytes = new Uint8Array(length);
        counter += 1;
        bytes[14] = (counter >>> 8) & 0xff;
        bytes[15] = counter & 0xff;
        return bytes;
      },
    },
  });

  const ids = Array.from({ length: 64 }, () => collab.createCollabRequestId());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, UUID_V4_RE);
});

function createCollaborationRuntime() {
  const rpcCalls = [];
  let expoCounter = 10;
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'actor-a' } } } }),
    },
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === 'create_dressing_room_message') {
        return {
          data: {
            id: `message-${rpcCalls.length}`,
            roomId: args.p_room_id,
            senderId: 'actor-a',
            body: args.p_body,
            createdAt: '2026-07-26T12:00:00.000Z',
            clientMessageId: args.p_client_message_id,
            parentMessageId: args.p_parent_message_id,
          },
          error: null,
        };
      }
      if (name === 'set_dressing_room_item_reaction') {
        return {
          data: {
            ok: true,
            roomId: args.p_room_id,
            itemId: args.p_item_id,
            reactionType: args.p_reaction_type,
            active: args.p_active,
            myReaction: args.p_active ? args.p_reaction_type : null,
            requestId: args.p_request_id,
            accessVersion: 1,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const collab = loadCollaboration({
    expoCrypto: {
      randomUUID: () => validUuid(expoCounter++),
      getRandomBytes: () => new Uint8Array(16),
    },
    supabase,
  });
  return { collab, rpcCalls, supabase };
}

test('ANDROID ROOM CHAT HERMES TEST: generated and caller IDs reach the existing RPC contract', async () => {
  const { collab, rpcCalls, supabase } = createCollaborationRuntime();
  const roomMessages = loadTsModule('services/roomMessages.ts', {
    './supabaseClient': { supabase },
    '../constants/featureFlags': {
      DRESSING_ROOM_COLLABORATION_V1: true,
      DRESSING_ROOM_MESSAGES_V1: true,
      DRESSING_ROOM_THREADS_V1: true,
    },
    './dressingRoomCollaboration': collab,
  });

  const generated = await roomMessages.sendRoomMessage('room-a', 'Hello from Hermes');
  const generatedCall = rpcCalls.at(-1);
  assert.equal(generatedCall.name, 'create_dressing_room_message');
  assert.match(generatedCall.args.p_client_message_id, UUID_V4_RE);
  assert.equal(generated.clientMessageId, generatedCall.args.p_client_message_id);

  const supplied = validUuid(99);
  await roomMessages.sendRoomMessage('room-a', 'Retry safely', { clientMessageId: supplied });
  assert.equal(rpcCalls.at(-1).args.p_client_message_id, supplied);
});

test('ANDROID REACTION HERMES TEST: generated and caller IDs preserve reaction idempotency', async () => {
  const { collab, rpcCalls, supabase } = createCollaborationRuntime();
  const styleObjects = loadTsModule('services/styleObjects.ts', {
    './supabaseClient': { supabase },
    'expo-file-system/legacy': {},
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' } },
    '../constants/featureFlags': {
      DRESSING_ROOM_CANONICAL_ITEM_V1: true,
      DRESSING_ROOM_COLLABORATION_V1: true,
      DRESSING_ROOM_COMMERCE_PRESERVATION_V1: true,
      DRESSING_ROOM_DEDUPE_V1: true,
      DRESSING_ROOM_REACTIONS_V1: true,
    },
    './dressingRoomCollaboration': collab,
    './dressingRoomItemContract': {
      buildCanonicalSnapshotExtension: () => ({}),
      isLocalImageUri: () => false,
      isRemoteImageUrl: () => false,
      readSnapshotDedupeKey: () => null,
      resolveDressingRoomImageSource: () => ({ kind: 'none' }),
    },
  });

  await styleObjects.setItemReaction('item-a', 'heart', {
    roomId: 'room-a',
    active: true,
  });
  const generatedCall = rpcCalls.at(-1);
  assert.equal(generatedCall.name, 'set_dressing_room_item_reaction');
  assert.match(generatedCall.args.p_request_id, UUID_V4_RE);

  const supplied = validUuid(100);
  await styleObjects.setItemReaction('item-a', 'heart', {
    roomId: 'room-a',
    active: false,
    requestId: supplied,
  });
  assert.equal(rpcCalls.at(-1).args.p_request_id, supplied);
  assert.equal(rpcCalls.at(-1).args.p_active, false);
});

test('ANDROID request-id implementation excludes weak local entropy sources', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/dressingRoomCollaboration.ts'),
    'utf8',
  );
  const helper = source.match(/export function createCollabRequestId\(\): string \{([\s\S]*?)\n\}/);
  assert.ok(helper, 'request-id helper must remain discoverable');
  assert.doesNotMatch(helper[1], /Math\.random|Date\.now/);
});
