const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function load(file, mocks) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    AbortController, console, Date, Error, Promise, Set, RegExp,
    setTimeout, clearTimeout, exports: mod.exports, module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

function clientWith(responder) {
  const seen = [];
  const client = load('services/avatars/stylistSpeechClient.ts', {
    '../supabaseClient': {
      supabase: {
        functions: {
          invoke: (name, options) => {
            seen.push({ name, body: options.body });
            return Promise.resolve(responder(options.body));
          },
        },
      },
    },
    '../../stores/avatarSpeechStore': {},
    '../../constants/stylistIdentity': {},
  });
  return { client, seen };
}

const AUDIO = { voiceProfile: 'feminine', mimeType: 'audio/mpeg', audioBase64: 'YXVkaW8=', alignment: null };

test('a cue request sends only the cue key and stylist, never chat references', async () => {
  const { client, seen } = clientWith((body) => ({
    data: { cue: body.cue, messageId: null, stylistId: body.stylistId, ...AUDIO },
    error: null,
  }));

  const result = await client.requestStylistSpeech({
    mode: 'cue',
    actorId: 'actor-1',
    cue: 'dressing_room_ready',
    stylistId: 'stylist_portrait_05',
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'stylist-speech');
  // The decisive property: no field carries words, and no chat identifiers leak
  // into a cue that has no chat behind it.
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['cue', 'stylistId']);
  assert.equal(result.cue, 'dressing_room_ready');
  assert.equal(result.messageId, null);
});

test('a cue reply cannot satisfy a message request', async () => {
  const { client } = clientWith(() => ({
    data: { cue: 'entry', messageId: null, stylistId: 'stylist_portrait_05', ...AUDIO },
    error: null,
  }));
  await assert.rejects(
    () => client.requestStylistSpeech({
      actorId: 'actor-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      messageId: 'message-1',
      stylistId: 'stylist_portrait_05',
    }),
    /Speech response is invalid/,
  );
});

test('a message reply cannot satisfy a cue request', async () => {
  const { client } = clientWith(() => ({
    data: { cue: null, messageId: 'message-1', stylistId: 'stylist_portrait_05', ...AUDIO },
    error: null,
  }));
  await assert.rejects(
    () => client.requestStylistSpeech({
      mode: 'cue', actorId: 'actor-1', cue: 'entry', stylistId: 'stylist_portrait_05',
    }),
    /Speech response is invalid/,
  );
});

test('a reply echoing a different cue is refused', async () => {
  const { client } = clientWith(() => ({
    data: { cue: 'change_something', messageId: null, stylistId: 'stylist_portrait_05', ...AUDIO },
    error: null,
  }));
  await assert.rejects(
    () => client.requestStylistSpeech({
      mode: 'cue', actorId: 'actor-1', cue: 'entry', stylistId: 'stylist_portrait_05',
    }),
    /Speech response is invalid/,
  );
});

test('message mode still works against a deployment that predates cue mode', async () => {
  // The rollout window: a new app build can reach a stylist-speech that omits
  // `cue` entirely. Requiring a literal null here would silence Elise for every
  // user between the app release and the function deploy.
  const { client } = clientWith(() => ({
    data: { messageId: 'message-1', stylistId: 'stylist_portrait_05', ...AUDIO },
    error: null,
  }));
  const result = await client.requestStylistSpeech({
    actorId: 'actor-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    messageId: 'message-1',
    stylistId: 'stylist_portrait_05',
  });
  assert.equal(result.messageId, 'message-1');
  assert.equal(result.cue, null);
});

test('a cue request without a cue is refused before any network call', async () => {
  const { client, seen } = clientWith(() => ({ data: null, error: null }));
  await assert.rejects(
    () => client.requestStylistSpeech({
      mode: 'cue', actorId: 'actor-1', cue: '', stylistId: 'stylist_portrait_05',
    }),
    /Speech references are required/,
  );
  assert.equal(seen.length, 0);
});
