const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  characterAlignment,
  executableSource,
  loadAdapter,
  loadPackages,
} = require('./fixtures/avatarEngineHarness');

const ELISE_ALIAS = 'elise_default';
const ELISE = 'stylist_portrait_01';
const HENRY = 'stylist_portrait_02';

const ELISE_ASSETS = Object.freeze({
  closed: {
    file: 'avatar_stylist_01_mouth_closed.png',
    sha256: '564b4d1fa71f9899c6aab437b095eb12ed27f6bef2a99ce8e9c50efd704cfcae',
  },
  halfOpen: {
    file: 'avatar_stylist_01_mouth_half_open.png',
    sha256: 'f2f03ed107475a55bd0aeaec51cf1dcb013e515fd46ff06f1afd312b1e3d852f',
  },
  open: {
    file: 'avatar_stylist_01_mouth_open.png',
    sha256: 'c59b10218d653bb09d134633f68858d6216a81958eb882c7273345cee3cc1424',
  },
});

const PHRASES = Object.freeze([
  'Hi.',
  'That jacket has a structured silhouette.',
  'The logo suggests this may be Acne Studios.',
  'Yes — I found it. Let me show you.',
  'Black, leather, cropped, and fitted.',
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function speech(overrides = {}) {
  return {
    avatarId: ELISE_ALIAS,
    generation: 1,
    phase: 'playing',
    playbackSeconds: 0,
    alignment: null,
    ...overrides,
  };
}

function frame(adapter, speechInput, overrides = {}) {
  return adapter.computeFrame({
    avatarId: ELISE,
    speech: speechInput,
    scopeMatches: true,
    reduceMotion: false,
    foreground: true,
    motionEpoch: 1,
    hostNowMs: Math.max(0, speechInput.playbackSeconds * 1000),
    ...overrides,
  });
}

function walkFiles(directory, extension) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(absolute, extension));
    else if (absolute.endsWith(extension)) out.push(absolute);
  }
  return out;
}

test('approved Elise mouth assets retain their audited hashes and uniform 1024px registration', () => {
  const directory = path.join(ROOT, 'assets', 'stylist-avatars', 'portraits', 'animated');
  for (const [state, expected] of Object.entries(ELISE_ASSETS)) {
    const buffer = fs.readFileSync(path.join(directory, expected.file));
    assert.equal(sha256(buffer), expected.sha256, `${state} artwork changed from approved dc13d04 blob`);
    assert.deepEqual(pngDimensions(buffer), { width: 1024, height: 1024 });
  }
  assert.equal(fs.existsSync(path.join(directory, 'avatar_stylist_01_mouth_round.png')), false);
});

test('elise_default resolves to the non-static portrait 01 package without Henry leakage', () => {
  const { resolveAvatarPackage } = loadPackages();
  const alias = resolveAvatarPackage(ELISE_ALIAS);
  const elise = resolveAvatarPackage(ELISE);
  const henry = resolveAvatarPackage(HENRY);

  assert.equal(alias.avatarId, ELISE);
  assert.equal(alias.package.identity.avatarId, ELISE);
  assert.equal(alias.validation.capabilities.basicLipSync, true);
  assert.equal(alias.validation.capabilities.roundLipSync, false);
  assert.deepEqual(alias.validation.capabilities, elise.validation.capabilities);
  assert.equal(henry.package.identity.avatarId, HENRY);
  assert.equal(henry.validation.capabilities.roundLipSync, true);
  assert.notDeepEqual(alias.package.mouth.round, henry.package.mouth.round);
});

test('the five governed phrases animate deterministically from native playback and finish closed', () => {
  const { AvatarEngineHostAdapter } = loadAdapter();
  for (const [index, phrase] of PHRASES.entries()) {
    const adapter = new AvatarEngineHostAdapter();
    const generation = index + 1;
    const alignment = characterAlignment(phrase, 0, 0.06);
    const duration = alignment.characterEndTimesSeconds.at(-1);
    const states = [];
    for (let seconds = 0; seconds <= duration; seconds += 0.02) {
      states.push(frame(adapter, speech({ generation, alignment, playbackSeconds: seconds })).mouthState);
    }
    states.push(frame(adapter, speech({ generation, alignment, playbackSeconds: duration + 0.2 })).mouthState);

    assert.ok(states.some((state) => state !== 'closed'), `${phrase} never animated`);
    assert.equal(states.at(-1), 'closed', `${phrase} did not end closed`);
    assert.equal(states.includes('round'), false, 'Elise cannot request missing round artwork');
    assert.equal(states.every((state) => ['closed', 'halfOpen', 'open'].includes(state)), true);
  }
});

test('request, play, complete, interrupt, replace, fail, background and reduce-motion all close safely', () => {
  const { AvatarEngineHostAdapter } = loadAdapter();
  const adapter = new AvatarEngineHostAdapter();
  const first = characterAlignment(PHRASES[1], 0, 0.06);
  const second = characterAlignment(PHRASES[3], 0, 0.06);

  for (const phase of ['requesting', 'ready']) {
    assert.equal(frame(adapter, speech({ phase, alignment: phase === 'ready' ? first : null })).mouthState, 'closed');
  }
  const playingStates = [0.12, 0.24, 0.36, 0.48].map((playbackSeconds) =>
    frame(adapter, speech({ alignment: first, playbackSeconds })).mouthState,
  );
  assert.ok(playingStates.some((mouthState) => mouthState !== 'closed'));

  assert.equal(frame(adapter, speech({ phase: 'stopping', alignment: first })).mouthState, 'closed');
  assert.equal(frame(adapter, speech({ phase: 'idle' })).mouthState, 'closed');

  const replacement = frame(adapter, speech({ generation: 2, alignment: second, playbackSeconds: 0.24 }));
  assert.equal(replacement.frame.speechGeneration, 2);
  assert.equal(frame(adapter, speech({ generation: 1, alignment: first, playbackSeconds: 0.5 })).mouthState, 'closed');

  assert.equal(frame(adapter, speech({ generation: 3, phase: 'error' })).mouthState, 'closed');
  assert.equal(
    frame(adapter, speech({ generation: 4, alignment: first, playbackSeconds: 0.3 }), { foreground: false }).mouthState,
    'closed',
  );
  assert.equal(
    frame(adapter, speech({ generation: 5, alignment: first, playbackSeconds: 0.3 }), { reduceMotion: true }).mouthState,
    'closed',
  );
});

test('one-authority architecture: one compiler, one interpreter, one visible renderer', () => {
  const services = walkFiles(path.join(ROOT, 'services'), '.ts');
  const components = walkFiles(path.join(ROOT, 'components'), '.tsx');
  const allSource = [...services, ...components].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  const runtime = executableSource('services/avatars/engine/runtime/AvatarRuntime.ts');

  assert.equal((allSource.match(/export function compileSpeechTimeline\s*\(/g) ?? []).length, 1);
  assert.equal((allSource.match(/export function normalizeAlignment\s*\(/g) ?? []).length, 1);
  assert.equal(/normalizeAlignment/.test(runtime), false, 'runtime must not interpret alignment before the compiler');
  assert.equal((header.match(/useAvatarSpeechState\(\)/g) ?? []).length, 1);
  assert.equal((header.match(/getAvatarEngineAdapter\(\)\.computeFrame/g) ?? []).length, 1);
  // One visible mouth wiring. The binding may be destructured from a richer
  // engine result — the header also consumes headMotion/breathing from the
  // same frame — so the spelling is allowed to be `visual.mouthState`.
  assert.equal((header.match(/mouthState=\{(?:visual\.)?mouthState\}/g) ?? []).length, 1);
  // Exactly one frame is calculated per render and both channels come from it.
  assert.equal((header.match(/result\.frame\.headMotion|result\.frame\.breathing/g) ?? []).length, 2);
  assert.equal(/deriveAvatarMouthState|buildMouthStateTimeline|avatarShadowBridge/.test(header), false);

  const activeLegacyImports = allSource
    .split(/\r?\n/)
    .filter((line) => line.includes('avatarSpeechMotion') && !line.trimStart().startsWith('import type'));
  assert.deepEqual(activeLegacyImports, [], 'legacy timeline must have no active production importer');
});
