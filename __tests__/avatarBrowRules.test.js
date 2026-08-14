const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks = {}) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    RegExp,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

// Registered Metro static require() targets in constants/avatarFacialOverlays.ts
// (stylist_portrait_02 eyes + brows production overlays). The sandboxed
// require() above throws on anything outside `mocks`, so every call site that
// loads that module now needs these -- unlike require.extensions['.png'],
// which only intercepts real Node module resolution and has no effect
// inside this VM sandbox.
const FACIAL_OVERLAY_ASSET_MOCKS = {
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_open.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_halfClosed.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_closed.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_neutral.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_raised.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_focused.png': 1,
};

const rules = transpileModule('services/avatarExpressionRules.ts');
const { resolveBrowState, resolveExpressionMode } = rules;

const BROW_CAPS = Object.freeze({
  threeStateMouth: true,
  roundMouth: false,
  blink: false,
  brows: true,
  gaze: false,
  headMotion: true,
  upperBodyMotion: true,
});

const NO_BROW_CAPS = Object.freeze({ ...BROW_CAPS, brows: false });

test('neutral is the default brow state', () => {
  assert.equal(resolveBrowState('neutral', 'idle', BROW_CAPS, false), 'neutral');
  assert.equal(resolveBrowState('neutral', 'listening', BROW_CAPS, false), 'neutral');
  assert.equal(resolveBrowState('warm', 'idle', BROW_CAPS, false), 'neutral');
});

test('raised expresses questions, positive emphasis, and attentive acknowledgement', () => {
  // Attentive acknowledgement while listening.
  assert.equal(resolveBrowState('warm', 'listening', BROW_CAPS, false), 'raised');
  // Positive emphasis while speaking or reacting.
  assert.equal(resolveBrowState('confident', 'speaking', BROW_CAPS, false), 'raised');
  assert.equal(resolveBrowState('warm', 'reacting', BROW_CAPS, false), 'raised');
});

test('focused expresses measured comparison and uncertainty', () => {
  assert.equal(resolveBrowState('uncertain', 'idle', BROW_CAPS, false), 'focused');
  assert.equal(resolveBrowState('uncertain', 'speaking', BROW_CAPS, false), 'focused');
  assert.equal(resolveBrowState('neutral', 'thinking', BROW_CAPS, false), 'focused');
});

test('brow mapping is deterministic end-to-end from response text', () => {
  const cases = [
    ['Which occasion is this for?', 'speaking', 'focused'],
    ["I'd go with the charcoal trousers.", 'speaking', 'raised'],
    ['Your closet has 14 tops.', 'speaking', 'neutral'],
  ];
  for (const [text, mode, expected] of cases) {
    const expression = resolveExpressionMode({ text });
    for (let run = 0; run < 10; run += 1) {
      assert.equal(
        resolveBrowState(expression, mode, BROW_CAPS, false),
        expected,
        `${text} -> ${expected}`,
      );
    }
  }
});

test('capability gate: no brow package means always neutral', () => {
  for (const expression of ['neutral', 'warm', 'confident', 'thinking', 'uncertain']) {
    for (const mode of ['idle', 'listening', 'thinking', 'speaking', 'reacting']) {
      assert.equal(
        resolveBrowState(expression, mode, NO_BROW_CAPS, false),
        'neutral',
        `${expression}/${mode} must not imply brow motion without assets`,
      );
    }
  }
});

test('Reduce Motion pins brows to neutral', () => {
  assert.equal(resolveBrowState('uncertain', 'thinking', BROW_CAPS, true), 'neutral');
  assert.equal(resolveBrowState('confident', 'speaking', BROW_CAPS, true), 'neutral');
});

test('interruption resets brows with every other facial layer', () => {
  assert.equal(resolveBrowState('uncertain', 'interrupted', BROW_CAPS, false), 'neutral');
  assert.equal(resolveBrowState('confident', 'interrupted', BROW_CAPS, false), 'neutral');
});

test('no cloud emotion-analysis dependency and no emotional-awareness claim', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarExpressionRules.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /fetch\(|supabase|invoke\(|axios/i);
  assert.doesNotMatch(code, /sentiment|emotionApi/i);
  assert.match(source, /never\s*(\* )?implies emotional awareness/);
});

test('the component renders brows as an overlay inside the composite and resets to neutral', () => {
  const component = fs.readFileSync(
    path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
    'utf8',
  );
  assert.match(component, /resolveBrowState\(expression, browMode, capabilities, reducedMotion\)/);
  assert.match(component, /browState !== 'neutral' \? getFacialOverlayAsset\(avatarId, 'brows', browState\) : null/);
  assert.match(component, /\{browAsset \? <FacialOverlayLayer/);
  // Motion inactive (flag off / static) forces neutral — nothing mounts.
  assert.match(component, /const browState = motionActive\s*\n?\s*\? resolveBrowState/);
  // Brow layer never gates or alters the mouth layer.
  assert.doesNotMatch(component, /browState[\s\S]{0,120}showMouthLayer =/);
});

test('missing brow assets mean no brow layer even when the state is non-neutral', () => {
  const overlays = transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS);
  for (const state of ['neutral', 'raised', 'focused']) {
    assert.equal(overlays.getFacialOverlayAsset('stylist_portrait_01', 'brows', state), null);
  }
});
