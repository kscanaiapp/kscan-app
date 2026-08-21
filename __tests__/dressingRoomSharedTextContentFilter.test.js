/**
 * Apple App Store Guideline 1.2 (User-Generated Content): the Dressing Room
 * chat filter (validateMessageBody) covered only chat messages. Three other
 * free-text fields reach other users — the "Ask My Room" decision question
 * (participants + public link viewers), the room title, and the room note
 * (share recipients). These tests assert that each passes the same
 * objectionable-content denylist BEFORE any backend call is made.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BLOCKED = 'kys';

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(readSource(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      exports: module.exports,
      module,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

const roomMessagesFilter = loadTsModule('services/roomMessages.ts', {
  './supabaseClient': { supabase: {} },
  '../constants/featureFlags': { DRESSING_ROOM_THREADS_V1: false },
  './dressingRoomCollaboration': {},
});

test('Ask My Room question is filtered before the share RPC is called', async () => {
  const rpcCalls = [];
  const outfitDecisions = loadTsModule('services/outfitDecisions.ts', {
    './supabaseClient': {
      supabase: {
        rpc: async (...args) => {
          rpcCalls.push(args);
          return { data: 'group-1', error: null };
        },
      },
    },
    './roomMessages': roomMessagesFilter,
    '../types/styleObjects': {},
  });

  await assert.rejects(
    () => outfitDecisions.shareLooksToRoom({ roomId: 'r1', lookIds: ['l1'], question: `please ${BLOCKED}` }),
    (err) => err.message === outfitDecisions.DECISION_QUESTION_OBJECTIONABLE_ERROR,
  );
  assert.equal(rpcCalls.length, 0, 'blocked question must never reach the backend');

  const groupId = await outfitDecisions.shareLooksToRoom({
    roomId: 'r1',
    lookIds: ['l1'],
    question: 'Which one for Friday?',
  });
  assert.equal(groupId, 'group-1');
  assert.equal(rpcCalls.length, 1);
});

test('room title and room note use the same denylist as room chat', () => {
  const source = readSource('services/styleObjects.ts');
  assert.match(source, /import \{ containsBlockedMessageContent \} from '\.\/roomMessages'/);
  assert.match(source, /containsBlockedMessageContent\(title\)/);
  assert.match(source, /containsBlockedMessageContent\(note\)/);
});

test('room title and room note writes reject objectionable text before any supabase call', async () => {
  const calls = [];
  const chain = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        return (...args) => {
          calls.push([prop, args]);
          if (prop === 'single') return Promise.resolve({ data: { room_note: null }, error: null });
          return chain;
        };
      },
    },
  );
  const styleObjects = loadTsModule('services/styleObjects.ts', {
    './supabaseClient': {
      supabase: { from: (...args) => { calls.push(['from', args]); return chain; }, auth: {} },
    },
    './roomMessages': roomMessagesFilter,
    'expo-file-system/legacy': {},
    'expo-image-manipulator': {},
    '../constants/featureFlags': new Proxy({}, { get: () => false }),
    './dressingRoomCollaboration': {},
    './dressingRoomItemContract': {},
    './roomShareState': {},
    '../types/styleObjects': {},
    '../types/canonicalDressingRoomItem': {},
  });

  await assert.rejects(
    () => styleObjects.updateDressingRoomNote('r1', `note ${BLOCKED}`),
    (err) => err.message === styleObjects.ROOM_NOTE_OBJECTIONABLE_ERROR,
  );
  await assert.rejects(
    () => styleObjects.createDressingRoom({ userId: 'u1', title: `${BLOCKED} room` }),
    (err) => err.message === styleObjects.ROOM_TITLE_OBJECTIONABLE_ERROR,
  );
  await assert.rejects(
    () => styleObjects.updateDressingRoom('r1', { title: `${BLOCKED} room` }),
    (err) => err.message === styleObjects.ROOM_TITLE_OBJECTIONABLE_ERROR,
  );
  assert.equal(calls.length, 0, 'blocked title/note must never reach the backend');
});
