const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
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
    Set,
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

const MOTION_SOURCES = [
  'services/avatarMotionState.ts',
  'services/avatarMotionController.ts',
  'services/avatarMotionRenderer.ts',
  'services/avatarMotionCapabilities.ts',
  'services/avatarMotionStatus.ts',
  'services/avatarExpressionRules.ts',
  'services/avatarSpeechLifecycle.ts',
  'stores/avatarMotionStore.ts',
  'hooks/useAvatarCompositeMotion.ts',
  'hooks/useAvatarConversationMotion.ts',
  'hooks/useAvatarMotionState.ts',
  'components/stylist/AnimatedStylistAvatar.tsx',
];

test('no native image-cache eviction is claimed anywhere in the motion work', () => {
  for (const relative of MOTION_SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    // Nulling an Image source is not a cache purge and must never be used
    // as one; the discrete snapshot's unrelated `source` field is fine.
    assert.doesNotMatch(source, /source=\{null\}/, relative);
    assert.doesNotMatch(source, /cache.{0,12}(purge|evict)/i, relative);
  }
  const doc = fs.readFileSync(
    path.join(ROOT, 'docs', 'avatars', 'AVATAR_MOTION_V1_ASSET_AND_QA_CONTRACT.md'),
    'utf8',
  );
  assert.match(doc, /No explicit native image-cache eviction is claimed/);
});

test('no invented CPU, memory, or frame-rate thresholds', () => {
  for (const relative of MOTION_SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /\b(60\s*fps|fps\s*(budget|threshold)|maxMemoryMb|cpuBudget)\b/i, relative);
  }
});

test('no motion module preloads all avatars', () => {
  for (const relative of MOTION_SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /STYLIST_AVATAR_PRESETS\b/, `${relative} must not enumerate every preset`);
    assert.doesNotMatch(source, /preload/i, relative);
  }
});

test('no motion module creates an unbounded timer at rest', () => {
  for (const relative of [
    'services/avatarMotionState.ts',
    'services/avatarMotionController.ts',
    'services/avatarMotionRenderer.ts',
    'services/avatarMotionCapabilities.ts',
    'services/avatarMotionStatus.ts',
    'services/avatarExpressionRules.ts',
    'stores/avatarMotionStore.ts',
    'components/stylist/AnimatedStylistAvatar.tsx',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /setInterval/, relative);
    assert.doesNotMatch(source, /setTimeout/, relative);
  }
  // The one timer in the system is the listening hysteresis, and it is always
  // cleared by its effect cleanup.
  const conversation = fs.readFileSync(
    path.join(ROOT, 'hooks', 'useAvatarConversationMotion.ts'),
    'utf8',
  );
  const timerCount = (conversation.match(/setTimeout/g) ?? []).length;
  assert.equal(timerCount, 1);
  assert.match(conversation, /return \(\) => clearTimeout\(timer\)/);
});

test('controller disposal leaves no listeners, no state, and rejects every input', () => {
  const contract = transpileModule('services/avatarMotionState.ts');
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  const controller = controllerModule.createAvatarMotionController({
    clock: () => 0,
    random: () => 0.5,
  });
  controller.subscribe(() => {});
  controller.subscribe(() => {});
  controller.reportPlaybackActive(1);
  controller.dispose();
  assert.equal(controller.getListenerCountForTests(), 0);
  assert.equal(controller.getSnapshot().mode, 'idle');
  assert.equal(controller.getSnapshot().speaking, false);
  assert.equal(controller.requestMode('thinking', 99), false);
  assert.equal(controller.reportPlaybackActive(99), false);
  assert.equal(controller.reportPlaybackMouth(99, 'open'), false);
  assert.equal(controller.setExpression('warm', 99), false);
  assert.equal(controller.subscribe(() => {})(), undefined);
  assert.equal(controller.getListenerCountForTests(), 0, 'no subscription survives disposal');
  // Dispose is idempotent.
  controller.dispose();
  assert.equal(controller.getListenerCountForTests(), 0);
});

test('asset failure degrades stepwise and never blocks StyleChat', () => {
  const renderer = transpileModule('services/avatarMotionRenderer.ts');
  const chain = [
    [{ closed: 1, halfOpen: 2, open: 3, round: 4 }, 'round', 4],
    [{ closed: 1, halfOpen: 2, open: 3 }, 'round', 3],
    [{ closed: 1, halfOpen: 2 }, 'open', 2],
    [{ closed: 1 }, 'halfOpen', 1],
    [{}, 'closed', null],
  ];
  for (const [sources, target, expected] of chain) {
    assert.equal(renderer.resolveMouthStateSource(sources, target), expected);
  }
  // A null result means "render the static portrait", not "throw".
  assert.doesNotThrow(() => renderer.resolveMouthStateSource({}, 'round'));
});

test('capability contract fails closed for unknown and non-portrait avatars', () => {
  require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;
  const capabilities = transpileModule('services/avatarMotionCapabilities.ts', {
    '../constants/stylistIdentity': require('../constants/stylistIdentity.ts'),
    '../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS),
    './avatarMotionState': transpileModule('services/avatarMotionState.ts'),
  });
  for (const id of [null, undefined, '', 'not-a-real-avatar', 'elise_default']) {
    const caps = capabilities.getAvatarMotionCapabilities(id);
    for (const [key, value] of Object.entries(caps)) {
      assert.equal(value, false, `${String(id)}.${key} must fail closed`);
    }
  }
});

test('motion and voice remain independently controllable', () => {
  const flags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');
  assert.match(flags, /AVATAR_MOTION_V1_ENABLED/);
  assert.match(flags, /EXPO_PUBLIC_AVATAR_MOTION_V1 === 'true'/, 'defaults to false');
  // The motion flag is not consulted by any speech/voice path.
  for (const relative of [
    'services/avatarSpeech.ts',
    'services/avatarSpeechLifecycle.ts',
    'hooks/useVoiceResponsesPreference.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /AVATAR_MOTION_V1_ENABLED/, relative);
  }
  // ...and the voice preference is not consulted by motion modules.
  for (const relative of [
    'hooks/useAvatarCompositeMotion.ts',
    'hooks/useAvatarConversationMotion.ts',
    'services/avatarMotionController.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /voicePreference|useVoiceResponsesPreference/, relative);
  }
});

test('no backend, auth, routing, database, commerce, or scanner behavior is touched', () => {
  // Resolve HEAD through Git rather than reading .git/HEAD directly: in a
  // linked worktree `.git` is a FILE containing a gitdir pointer, not a
  // directory, so the direct path only exists in a normal clone layout. Asking
  // Git works in both layouts and proves repository readability at least as
  // strongly as reading the file did.
  const changed = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  assert.ok(changed.length > 0, 'repository is readable');
  // Structural guarantee: no motion module imports Supabase, routing, or
  // commerce/scanner surfaces.
  for (const relative of MOTION_SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*import\b/.test(line)).join('\n');
    assert.doesNotMatch(imports, /supabaseClient|expo-router|scanIdentify|commerce|retailer/i, relative);
  }
});

test('the deferred device QA protocol is documented without fabricated thresholds', () => {
  const doc = fs.readFileSync(
    path.join(ROOT, 'docs', 'avatars', 'AVATAR_MOTION_V1_ASSET_AND_QA_CONTRACT.md'),
    'utf8',
  );
  for (const required of [
    'baseline memory before entering StyleChat',
    'memory after repeated utterances',
    'memory after rapid avatar switching',
    'memory after leaving StyleChat',
    'render smoothness',
    'background/foreground cleanup',
    'no monotonic retained-memory pattern',
  ]) {
    assert.ok(doc.includes(required), `QA protocol must record: ${required}`);
  }
  assert.match(doc, /Round mouth \| NO — assets missing/);
  assert.match(doc, /Blink \| NO — assets missing/);
  assert.match(doc, /Brows \| NO — assets missing/);
  assert.match(doc, /Independent gaze \| NO — assets missing/);
  assert.doesNotMatch(doc, /\b\d+\s*fps\b/i, 'no invented frame-rate budget');
});
