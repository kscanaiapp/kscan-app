const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

/**
 * Exercises the eligibility gate every deterministic moment passes through.
 *
 * The gate is loaded with its React dependency replaced by a trivial useCallback,
 * so these assert the POLICY - who is allowed to hear a cue - without needing a
 * renderer. The trigger conditions themselves (which state transition raises
 * which moment) live in the screens and are covered by the loop suites.
 */
function loadGate({ voice, screenReader, actorId = 'actor-1', avatarId = 'stylist_portrait_05' }) {
  const sourcePath = path.join(ROOT, 'hooks/useEliseSpeechCue.ts');
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const spoken = [];
  const mod = { exports: {} };
  const sandbox = {
    console, Promise, Error, exports: mod.exports, module: mod,
    require: (specifier) => {
      switch (specifier) {
        case 'react':
          return { useCallback: (fn) => fn };
        case '../contexts/AuthSessionContext':
          return { useAuthSession: () => ({ user: actorId ? { id: actorId } : null }) };
        case '../constants/stylistIdentity':
          return {
            getStylistVoiceProfile: (id) =>
              id === 'elise_default' ? 'silent' : 'feminine',
          };
        case '../services/avatarSpeech':
          return { speakAvatarCue: (payload) => { spoken.push(payload); return Promise.resolve(); } };
        case '../services/style-chat/eliseSpeechMoments':
          return {};
        case './useScreenReaderEnabled':
          return {
            useScreenReaderEnabled: () => screenReader.enabled,
            useScreenReaderReady: () => screenReader.ready,
          };
        case './useStylistIdentity':
          return { useStylistIdentity: () => ({ identity: { avatarId } }) };
        case './useVoiceResponsesPreference':
          return { useVoiceResponsesPreference: () => voice };
        default:
          throw new Error(`Unexpected import: ${specifier}`);
      }
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return { speak: mod.exports.useEliseSpeechCue(), spoken };
}

const ELIGIBLE = {
  voice: { enabled: true, loading: false },
  screenReader: { enabled: false, ready: true },
};

test('an eligible listener hears the cue, carrying the moment and occurrence', () => {
  const { speak, spoken } = loadGate(ELIGIBLE);
  speak('closet_saved', 'closet-item-1', 'session-1');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].cue, 'closet_saved');
  assert.equal(spoken[0].occurrenceId, 'closet-item-1');
  assert.equal(spoken[0].sessionId, 'session-1');
  // stylistId and avatarId must agree; speakAvatarCue drops the call otherwise.
  assert.equal(spoken[0].stylistId, spoken[0].avatarId);
});

test('a voice-disabled user hears nothing', () => {
  const { speak, spoken } = loadGate({ ...ELIGIBLE, voice: { enabled: false, loading: false } });
  speak('closet_saved', 'closet-item-1');
  assert.equal(spoken.length, 0);
});

test('speech is withheld while the voice preference is still loading', () => {
  // Failing closed matters here: defaulting to "speak" during hydration would
  // make a voice-off user hear a cue on every cold start.
  const { speak, spoken } = loadGate({ ...ELIGIBLE, voice: { enabled: true, loading: true } });
  speak('closet_saved', 'closet-item-1');
  assert.equal(spoken.length, 0);
});

test('a screen-reader user hears nothing', () => {
  const { speak, spoken } = loadGate({ ...ELIGIBLE, screenReader: { enabled: true, ready: true } });
  speak('dressing_room_ready', 'anchor-1');
  assert.equal(spoken.length, 0);
});

test('speech is withheld until screen-reader state is known', () => {
  const { speak, spoken } = loadGate({ ...ELIGIBLE, screenReader: { enabled: false, ready: false } });
  speak('dressing_room_ready', 'anchor-1');
  assert.equal(spoken.length, 0);
});

test('a silent stylist never speaks a cue', () => {
  const { speak, spoken } = loadGate({ ...ELIGIBLE, avatarId: 'elise_default' });
  speak('entry', 'session-1');
  assert.equal(spoken.length, 0);
});

test('a signed-out actor never speaks a cue', () => {
  const { speak, spoken } = loadGate({ ...ELIGIBLE, actorId: null });
  speak('closet_saved', 'closet-item-1');
  assert.equal(spoken.length, 0);
});

test('a missing occurrence is refused rather than guessed', () => {
  // An absent occurrence would collapse every item onto one dedupe key, so the
  // second item to reach the same state would be silently skipped.
  const { speak, spoken } = loadGate(ELIGIBLE);
  for (const occurrence of [null, undefined, '']) speak('closet_saved', occurrence);
  assert.equal(spoken.length, 0);
});

test('the gate never returns a promise callers could accidentally await', () => {
  // Speech is enhancement. Returning void is what keeps a call site from
  // sequencing a Closet save or a handoff behind provider latency.
  const { speak } = loadGate(ELIGIBLE);
  assert.equal(speak('closet_saved', 'closet-item-1'), undefined);
});
