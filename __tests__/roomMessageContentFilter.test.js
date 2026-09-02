/**
 * Apple App Store Guideline 1.2 (User-Generated Content) requires "a method
 * for filtering objectionable material" before it reaches other users. The
 * Dressing Room chat previously had none — Report Message, Report User, and
 * Block/Unblock all existed, but nothing stood between the composer and the
 * backend insert. These tests assert the smallest safe gate: a fixed denylist
 * checked in validateMessageBody, so a blocked message never reaches
 * sendRoomMessage's network calls at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

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

function loadRoomMessages() {
  const getSessionCalls = [];
  const createCollaborationMessageCalls = [];

  const supabase = {
    auth: {
      getSession: async () => {
        getSessionCalls.push(true);
        return { data: { session: { user: { id: 'user-1' } } }, error: null };
      },
    },
  };

  const dressingRoomCollaboration = {
    bumpCollabActorGeneration: () => {},
    COLLAB_ACCESS_ERROR: 'This room is no longer available to you.',
    createCollaborationMessage: async (args) => {
      createCollaborationMessageCalls.push(args);
      return {
        id: 'm-1',
        roomId: args.roomId,
        senderId: 'user-1',
        body: args.text,
        createdAt: '2026-08-21T00:00:00.000Z',
        isMine: true,
        clientMessageId: args.clientMessageId,
        parentMessageId: args.parentMessageId,
      };
    },
    createCollabRequestId: () => 'req-1',
    getCollabActorGeneration: () => 1,
    isCurrentCollabGeneration: () => true,
    listCollaborationMessages: async () => ({
      messages: [],
      nextCursor: null,
      newestCursor: null,
      accessVersion: 1,
    }),
    catchUpCollaborationMessages: async () => ({
      messages: [],
      newestCursor: null,
      accessVersion: 1,
    }),
    mergeMessagesById: (existing, incoming) => [...existing, ...incoming],
  };

  const mod = loadTsModule('services/roomMessages.ts', {
    './supabaseClient': { supabase },
    '../constants/featureFlags': { DRESSING_ROOM_THREADS_V1: false },
    './dressingRoomCollaboration': dressingRoomCollaboration,
    // joinSharedRoom now also ensures the Shared-with-Me discovery record;
    // these suites exercise the message paths, so the seam is stubbed.
    './sharedRoomMemberships': { saveSharedRoomForCurrentUser: async () => ({ status: 'already_saved' }) },
  });

  return { mod, getSessionCalls, createCollaborationMessageCalls };
}

test('validateMessageBody rejects a message containing a blocked term', () => {
  const { mod } = loadRoomMessages();
  assert.throws(
    () => mod.validateMessageBody('please just kys already'),
    (err) => err.message === mod.ROOM_MESSAGE_OBJECTIONABLE_ERROR,
  );
});

test('validateMessageBody blocks case-insensitively', () => {
  const { mod } = loadRoomMessages();
  assert.throws(
    () => mod.validateMessageBody('KYS'),
    (err) => err.message === mod.ROOM_MESSAGE_OBJECTIONABLE_ERROR,
  );
});

test('validateMessageBody blocks a multi-word phrase inside a longer sentence', () => {
  const { mod } = loadRoomMessages();
  assert.throws(
    () => mod.validateMessageBody('honestly you should kill yourself over this fit'),
    (err) => err.message === mod.ROOM_MESSAGE_OBJECTIONABLE_ERROR,
  );
});

test('validateMessageBody does not flag a blocked term embedded inside a longer token (word-boundary check)', () => {
  const { mod } = loadRoomMessages();
  // "kys" has no standalone word boundary here — proves the filter matches
  // whole words, not substrings, so it will not over-block unrelated text.
  assert.equal(mod.validateMessageBody('xkysx99'), 'xkysx99');
});

test('validateMessageBody still passes ordinary Dressing Room chat through unaffected', () => {
  const { mod } = loadRoomMessages();
  const body = 'This looks great with black jeans and white sneakers!';
  assert.equal(mod.validateMessageBody(body), body);
});

test('sendRoomMessage rejects objectionable content before any session or network call', async () => {
  const { mod, getSessionCalls, createCollaborationMessageCalls } = loadRoomMessages();

  await assert.rejects(
    () => mod.sendRoomMessage('room-1', 'you are such a slut'),
    (err) => err.message === mod.ROOM_MESSAGE_OBJECTIONABLE_ERROR,
  );

  assert.equal(getSessionCalls.length, 0, 'must not check the session for a blocked message');
  assert.equal(
    createCollaborationMessageCalls.length,
    0,
    'must never reach the backend insert for a blocked message',
  );
});

test('sendRoomMessage still delivers an ordinary message to the backend', async () => {
  const { mod, createCollaborationMessageCalls } = loadRoomMessages();

  const sent = await mod.sendRoomMessage('room-1', 'Loving this fit for fall!');

  assert.equal(sent.body, 'Loving this fit for fall!');
  assert.equal(createCollaborationMessageCalls.length, 1);
  assert.equal(createCollaborationMessageCalls[0].roomId, 'room-1');
});
