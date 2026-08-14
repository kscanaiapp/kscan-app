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

const status = transpileModule('services/avatarMotionStatus.ts');
const contract = transpileModule('services/avatarMotionState.ts');
const {
  getAvatarMotionStatusText,
  decideMotionAnnouncement,
  isAnnounceableMotionMode,
} = status;

test('every semantic state has a textual equivalent', () => {
  assert.equal(
    getAvatarMotionStatusText({ mode: 'listening', stylistName: 'Elise' }),
    'Elise is listening',
  );
  assert.equal(
    getAvatarMotionStatusText({ mode: 'thinking', stylistName: 'Elise' }),
    'Elise is considering your request',
  );
  assert.equal(
    getAvatarMotionStatusText({ mode: 'speaking', stylistName: 'Elise' }),
    'Elise is speaking',
  );
  // Idle needs no status; the role line remains.
  assert.equal(getAvatarMotionStatusText({ mode: 'idle', stylistName: 'Elise' }), null);
});

test('status copy follows the user-chosen stylist name and falls back safely', () => {
  assert.equal(
    getAvatarMotionStatusText({ mode: 'speaking', stylistName: 'Ava' }),
    'Ava is speaking',
  );
  assert.equal(
    getAvatarMotionStatusText({ mode: 'speaking', stylistName: '   ' }),
    'Elise is speaking',
  );
});

test('exactly one announcement per semantic transition', () => {
  let last = null;
  const announced = [];
  const feed = (mode) => {
    const decision = decideMotionAnnouncement(mode, last, 'Elise');
    last = decision.nextAnnouncedMode;
    if (decision.announce) announced.push(decision.text);
  };
  feed('idle');
  feed('listening');
  feed('thinking');
  feed('speaking');
  feed('idle');
  assert.deepEqual(announced, [
    'Elise is listening',
    'Elise is considering your request',
    'Elise is speaking',
  ]);
});

test('no repeated announcement during a continuous state', () => {
  let last = null;
  let count = 0;
  // 60 evaluations while speaking (one per playback-driven rerender).
  for (let index = 0; index < 60; index += 1) {
    const decision = decideMotionAnnouncement('speaking', last, 'Elise');
    last = decision.nextAnnouncedMode;
    if (decision.announce) count += 1;
  }
  assert.equal(count, 1);
});

test('returning to a state after leaving it announces again', () => {
  let last = null;
  const announced = [];
  for (const mode of ['listening', 'idle', 'listening']) {
    const decision = decideMotionAnnouncement(mode, last, 'Elise');
    last = decision.nextAnnouncedMode;
    if (decision.announce) announced.push(decision.text);
  }
  assert.deepEqual(announced, ['Elise is listening', 'Elise is listening']);
});

test('playback frames and mouth changes are not announceable', () => {
  for (const mode of ['idle', 'reacting', 'interrupted']) {
    assert.equal(isAnnounceableMotionMode(mode), false);
  }
  for (const mode of ['listening', 'thinking', 'speaking']) {
    assert.equal(isAnnounceableMotionMode(mode), true);
  }
  const code = fs.readFileSync(path.join(ROOT, 'services', 'avatarMotionStatus.ts'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /mouth|playbackSeconds|viseme/i);
});

test('Reduce Motion strips all nonessential motion while status survives', () => {
  const fullCapabilities = {
    threeStateMouth: true, roundMouth: true, blink: true, brows: true,
    gaze: true, headMotion: true, upperBodyMotion: true,
  };
  const speaking = {
    ...contract.NEUTRAL_AVATAR_MOTION_STATE,
    mode: 'speaking',
    mouth: 'open',
    eyes: 'closed',
    brows: 'raised',
    gaze: { x: 0.6, y: 0.2 },
    head: { pitchDeg: 1.4, rollDeg: 0.9, yawDeg: -1 },
    breathingScale: 1.008,
    shoulderOffsetPx: 1.5,
    speaking: true,
  };
  const reduced = contract.normalizeAvatarMotionState(speaking, {
    reducedMotion: true,
    capabilities: fullCapabilities,
  });
  assert.equal(reduced.mouth, 'closed', 'no lip motion');
  assert.equal(reduced.eyes, 'open', 'no blink');
  assert.equal(reduced.brows, 'neutral');
  assert.equal(reduced.gaze.x, 0, 'no gaze motion');
  assert.equal(reduced.head.rollDeg, 0, 'no head motion');
  assert.equal(reduced.breathingScale, 1, 'no breathing');
  assert.equal(reduced.intensity, 0, 'no decorative expression transition');
  // The status channel is unaffected.
  assert.equal(
    getAvatarMotionStatusText({ mode: reduced.mode, stylistName: 'Elise' }),
    'Elise is speaking',
  );
});

test('pre-hydration Reduce Motion remains fail closed', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useReducedMotion.ts'), 'utf8');
  assert.match(source, /let reducedMotion = true/, 'motion stays off until the probe settles');
  assert.match(source, /function getServerSnapshot\(\): boolean \{\s*return true;/);
  // Subscriptions are released when the last consumer unsubscribes.
  assert.match(source, /if \(listeners\.size === 0 && subscription\)/);
  assert.match(source, /subscription\.remove\(\)/);
});

test('header renders a live-region status and announces on state change only', () => {
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );
  assert.match(header, /accessibilityLiveRegion="polite"/);
  assert.match(header, /testID="style-chat-avatar-status"/);
  assert.match(header, /AccessibilityInfo\.announceForAccessibility/);
  assert.match(header, /decideMotionAnnouncement/);
  // The announcement effect depends on the semantic mode, not on playback.
  assert.match(header, /\}, \[statusMode, displayName\]\);/);
  assert.doesNotMatch(header, /playbackSeconds/);
  // Visible status text is present even with motion disabled.
  assert.match(header, /\{statusText \?\? ELISE_IDENTITY\.role\}/);
});

test('reduce-motion changes during speech stop nonessential motion at the next event', () => {
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  let reducedMotion = false;
  const controller = controllerModule.createAvatarMotionController({
    clock: () => 1000,
    random: () => 0.5,
    capabilities: {
      threeStateMouth: true, roundMouth: true, blink: true, brows: true,
      gaze: true, headMotion: true, upperBodyMotion: true,
    },
    isReducedMotion: () => reducedMotion,
  });
  controller.reportPlaybackActive(1);
  controller.reportPlaybackMouth(1, 'open');
  reducedMotion = true;
  controller.reportPlaybackMouth(1, 'open');
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mouth, 'closed');
  assert.equal(snapshot.breathingScale, 1);
  assert.equal(
    getAvatarMotionStatusText({ mode: snapshot.mode, stylistName: 'Elise' }),
    'Elise is speaking',
    'status remains available without motion',
  );
});
