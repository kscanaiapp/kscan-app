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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    Date,
    setTimeout,
    clearTimeout,
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

const FULL_CAPABILITIES = Object.freeze({
  threeStateMouth: true,
  roundMouth: true,
  blink: true,
  brows: true,
  gaze: true,
  headMotion: true,
  upperBodyMotion: true,
});

function loadStack() {
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  controllerModule.resetSharedAvatarMotionControllerForTests();
  const acknowledgement = transpileModule('services/avatarAcknowledgement.ts', {
    './avatarMotionController': controllerModule,
  });
  acknowledgement.resetAvatarAcknowledgementForTests();
  const controller = controllerModule.getSharedAvatarMotionController();
  return { contract, controllerModule, acknowledgement, controller };
}

test('tap while idle produces exactly one restrained acknowledgement', () => {
  const { acknowledgement, controller } = loadStack();
  const events = [];
  acknowledgement.subscribeToAvatarAcknowledgement((event) => events.push(event.name));

  const outcome = acknowledgement.acknowledgeAvatarTap({ nowMs: 10_000, reducedMotion: false });
  assert.equal(outcome, 'acknowledged');
  assert.deepEqual(events, ['avatar_acknowledged']);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'reacting');
  assert.equal(snapshot.expression, 'warm', 'brief warm expression');
});

test('tap while listening acknowledges; tap while speaking or thinking never does', () => {
  // Listening permits the acknowledgement.
  const listening = loadStack();
  listening.controller.requestMode('listening', 1);
  assert.equal(
    listening.acknowledgement.acknowledgeAvatarTap({ nowMs: 10_000, reducedMotion: false }),
    'acknowledged',
  );

  // Speaking is never interrupted.
  const speaking = loadStack();
  speaking.controller.reportPlaybackActive(1);
  speaking.controller.reportPlaybackMouth(1, 'halfOpen');
  const before = speaking.controller.getSnapshot();
  assert.equal(
    speaking.acknowledgement.acknowledgeAvatarTap({ nowMs: 10_000, reducedMotion: false }),
    'busy',
  );
  const after = speaking.controller.getSnapshot();
  assert.equal(after.mode, 'speaking', 'speech continues untouched');
  assert.equal(after.mouth, before.mouth, 'mouth animation untouched');
  assert.equal(after.speaking, true);

  // Thinking is not preempted either.
  const thinking = loadStack();
  thinking.controller.requestMode('thinking', 1);
  assert.equal(
    thinking.acknowledgement.acknowledgeAvatarTap({ nowMs: 10_000, reducedMotion: false }),
    'busy',
  );
  assert.equal(thinking.controller.getSnapshot().mode, 'thinking');
});

test('rapid repeated taps collapse into a single acknowledgement per cooldown', () => {
  const { acknowledgement } = loadStack();
  const events = [];
  acknowledgement.subscribeToAvatarAcknowledgement(() => events.push(1));
  const { cooldownMs } = acknowledgement.ACKNOWLEDGEMENT_POLICY;

  assert.equal(acknowledgement.acknowledgeAvatarTap({ nowMs: 1_000, reducedMotion: true }), 'acknowledged');
  for (let tapMs = 1_050; tapMs < 1_000 + cooldownMs; tapMs += 200) {
    assert.equal(
      acknowledgement.acknowledgeAvatarTap({ nowMs: tapMs, reducedMotion: true }),
      'cooldown',
      `tap at ${tapMs} suppressed`,
    );
  }
  assert.equal(
    acknowledgement.acknowledgeAvatarTap({ nowMs: 1_000 + cooldownMs, reducedMotion: true }),
    'acknowledged',
    'a tap after the cooldown acknowledges again',
  );
  assert.equal(events.length, 2);
});

test('Reduce Motion: the semantic event fires but no motion or expression changes', () => {
  const { acknowledgement, controller } = loadStack();
  const events = [];
  acknowledgement.subscribeToAvatarAcknowledgement((event) => events.push(event.name));
  const outcome = acknowledgement.acknowledgeAvatarTap({ nowMs: 5_000, reducedMotion: true });
  assert.equal(outcome, 'acknowledged');
  assert.deepEqual(events, ['avatar_acknowledged']);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'idle', 'no motion mode change under Reduce Motion');
  assert.equal(snapshot.expression, 'neutral');
});

test('acknowledgement never touches speech: no restart of completed speech', () => {
  const { acknowledgement, controller } = loadStack();
  // Speech completed: back to idle.
  controller.reportPlaybackActive(3);
  controller.reportPlaybackEnded(3);
  assert.equal(controller.getSnapshot().mode, 'idle');
  acknowledgement.acknowledgeAvatarTap({ nowMs: 9_000, reducedMotion: false });
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'reacting');
  assert.equal(snapshot.speaking, false, 'no speech restarted');
  // The module has no path to the speech pipeline at all.
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarAcknowledgement.ts'), 'utf8');
  const imports = source.match(/^import[\s\S]*?from '[^']+';/gm) ?? [];
  assert.equal(imports.length, 1);
  assert.match(imports[0], /avatarMotionController/);
  assert.doesNotMatch(source, /avatarSpeech|playStylistAudio|speakAvatarMessage/);
});

test('no backend, provider, or network reachability from tap handling', () => {
  for (const relative of [
    'services/avatarAcknowledgement.ts',
    'hooks/useAvatarTapAcknowledgement.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(code, /fetch\(|supabase|invoke\(|axios|http/i, relative);
  }
});

test('the reaction self-expires and a later state proceeds normally', () => {
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  const clockBox = { nowMs: 50_000 };
  const controller = controllerModule.createAvatarMotionController({
    clock: () => clockBox.nowMs,
    random: () => 0.5,
    capabilities: FULL_CAPABILITIES,
    isReducedMotion: () => false,
  });
  assert.equal(controller.requestMode('reacting'), true);
  clockBox.nowMs += controllerModule.MOTION_TRANSITION_POLICY.reactionDurationMs + 1;
  assert.equal(controller.requestMode('thinking'), true, 'reaction expired; next state proceeds');
});

test('header wiring: pressable avatar only with the flag on, with role, label, and cooldown-safe handler', () => {
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );
  assert.match(header, /useAvatarTapAcknowledgement/);
  assert.match(header, /tapAcknowledgementEnabled \? \(/);
  assert.match(header, /accessibilityRole="button"/);
  assert.match(header, /accessibilityLabel=\{`Say hello to \$\{displayName\}`\}/);
  assert.match(header, /onPress=\{onAvatarPress\}/);
  // Flag off: the original non-interactive wrapper remains.
  assert.match(header, /accessibilityElementsHidden/);

  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarTapAcknowledgement.ts'), 'utf8');
  assert.match(hook, /if \(!enabled\) return;/, 'flag off means a complete no-op');
  assert.match(hook, /announceForAccessibility/, 'Reduce Motion fallback announcement');
  assert.match(hook, /clearTimeout\(revertTimerRef\.current\)/, 'expression revert timer is cleaned up');
  assert.match(hook, /return \(\) => \{/, 'unmount cleanup exists');
});
