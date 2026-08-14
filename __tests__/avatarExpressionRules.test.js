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

const rules = transpileModule('services/avatarExpressionRules.ts');
const {
  resolveExpressionMode,
  getExpressionPresentation,
  shouldPlayEmphasisNod,
} = rules;

const HEAD_MOTION_CAPS = Object.freeze({
  threeStateMouth: true,
  roundMouth: false,
  blink: false,
  brows: false,
  gaze: false,
  headMotion: true,
  upperBodyMotion: true,
});

const NO_CAPS = Object.freeze({
  threeStateMouth: false,
  roundMouth: false,
  blink: false,
  brows: false,
  gaze: false,
  headMotion: false,
  upperBodyMotion: false,
});

test('expression rules are local and deterministic with no cloud dependency', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarExpressionRules.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /fetch\(|supabase|invoke\(|axios/i);
  assert.doesNotMatch(code, /sentiment|emotionApi|openai|anthropic/i);
  assert.doesNotMatch(code, /Math\.random/);
  // The only import is a type-only import from the motion contract.
  const importBlocks = source.match(/^import[\s\S]*?from '[^']+';/gm) ?? [];
  assert.equal(importBlocks.length, 1, 'exactly one import statement');
  assert.match(importBlocks[0], /^import type \{/);
  assert.match(importBlocks[0], /from '\.\/avatarMotionState';$/);
  // The module never claims Elise feels anything.
  assert.match(source, /never a claim that Elise experiences emotion/);
});

test('the same input always produces the same mode', () => {
  const input = { text: 'I would go with the ivory blazer. It reads editorial.' };
  const first = resolveExpressionMode(input);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    assert.equal(resolveExpressionMode(input), first);
  }
});

test('uncertainty outranks confidence and warmth', () => {
  assert.equal(
    resolveExpressionMode({ text: 'I love this, but honestly it might not work.', hasRecommendation: true }),
    'uncertain',
  );
  assert.equal(
    resolveExpressionMode({ text: 'Which occasion is this for?' }),
    'uncertain',
  );
  assert.equal(
    resolveExpressionMode({ text: 'Definitely the boots.', isClarifying: true }),
    'uncertain',
    'explicit clarifying metadata wins',
  );
});

test('recommendation structure and confident phrasing produce the confident mode', () => {
  assert.equal(
    resolveExpressionMode({ text: 'Here is the look.', hasRecommendation: true }),
    'confident',
  );
  assert.equal(
    resolveExpressionMode({ text: "I'd go with the charcoal trousers." }),
    'confident',
  );
});

test('greetings and warm phrasing produce the warm mode', () => {
  assert.equal(resolveExpressionMode({ text: 'Hi Kathleen.', isGreeting: true }), 'warm');
  assert.equal(resolveExpressionMode({ text: 'That coat is gorgeous on you.' }), 'warm');
});

test('plain, empty, and whitespace text stay neutral', () => {
  assert.equal(resolveExpressionMode({ text: 'Your closet has 14 tops.' }), 'neutral');
  assert.equal(resolveExpressionMode({ text: '' }), 'neutral');
  assert.equal(resolveExpressionMode({ text: '   \n  ' }), 'neutral');
  assert.equal(resolveExpressionMode({ text: null }), 'neutral');
});

test('every mode presents within the restrained head-motion band', () => {
  for (const mode of ['neutral', 'warm', 'confident', 'thinking', 'uncertain']) {
    const presentation = getExpressionPresentation(mode, HEAD_MOTION_CAPS);
    assert.ok(Math.abs(presentation.headTiltDeg) <= 1, `${mode} tilt restrained`);
    assert.ok(presentation.attackScale >= 0.8 && presentation.attackScale <= 1.5, `${mode} timing`);
  }
});

test('without head-motion capability every mode presents as neutral', () => {
  for (const mode of ['warm', 'confident', 'thinking', 'uncertain']) {
    const presentation = getExpressionPresentation(mode, NO_CAPS);
    assert.equal(presentation.headTiltDeg, 0, `${mode} must not imply a facial expression`);
    assert.equal(presentation.allowsEmphasisNod, false);
  }
});

test('emphasis nods require capability, an allowing mode, and no Reduce Motion', () => {
  assert.equal(shouldPlayEmphasisNod('confident', HEAD_MOTION_CAPS, false), true);
  assert.equal(shouldPlayEmphasisNod('confident', HEAD_MOTION_CAPS, true), false);
  assert.equal(shouldPlayEmphasisNod('confident', NO_CAPS, false), false);
  assert.equal(shouldPlayEmphasisNod('uncertain', HEAD_MOTION_CAPS, false), false);
  assert.equal(shouldPlayEmphasisNod('neutral', HEAD_MOTION_CAPS, false), false);
});

test('presentations are frozen and cannot be mutated by a consumer', () => {
  const presentation = getExpressionPresentation('warm', HEAD_MOTION_CAPS);
  assert.throws(() => {
    'use strict';
    presentation.headTiltDeg = 45;
  });
  assert.equal(getExpressionPresentation('warm', HEAD_MOTION_CAPS).headTiltDeg, 0.6);
});
