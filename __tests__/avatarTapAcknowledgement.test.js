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

/* ------------------------------------------------------------------ */
/* KSB29-M01 — repeated taps must keep working                         */
/* ------------------------------------------------------------------ */

/** The same stack, with a controllable clock so reaction expiry is exact. */
function loadStackWithClock() {
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  let nowMs = 10_000;
  const controller = controllerModule.createAvatarMotionController({
    clock: () => nowMs,
    capabilities: FULL_CAPABILITIES,
  });
  const acknowledgement = transpileModule('services/avatarAcknowledgement.ts', {
    './avatarMotionController': {
      ...controllerModule,
      getSharedAvatarMotionController: () => controller,
    },
  });
  acknowledgement.resetAvatarAcknowledgementForTests();
  return {
    acknowledgement,
    controller,
    controllerModule,
    advance: (ms) => { nowMs += ms; },
    now: () => nowMs,
  };
}

test('KSB29-M01: a second tap is acknowledged once the reaction has expired', () => {
  const { acknowledgement, controller, advance, now } = loadStackWithClock();

  assert.equal(
    acknowledgement.acknowledgeAvatarTap({ nowMs: now(), reducedMotion: false }),
    'acknowledged',
    'the first tap must be acknowledged',
  );

  // THE DEFECT: `reacting` self-expires against the clock but nothing writes
  // the stored mode back, so `getSnapshot().mode` stays 'reacting' forever.
  // Reading it made every later tap 'busy' -- the feature worked exactly once
  // per app run.
  advance(5_000); // past both the 700ms reaction and the 2500ms cooldown
  assert.equal(controller.getSnapshot().mode, 'reacting', 'the stored mode is still stale');
  assert.equal(
    controller.getEffectiveMode(),
    'idle',
    'but the EFFECTIVE mode has returned to idle',
  );

  assert.equal(
    acknowledgement.acknowledgeAvatarTap({ nowMs: now(), reducedMotion: false }),
    'acknowledged',
    'a later tap must be acknowledged again',
  );
});

test('KSB29-M01: a tap DURING the reaction is still refused', () => {
  // The exemption must not become "always allow". While the reaction is genuinely
  // running, a tap is still busy -- an acknowledgement may not preempt itself.
  const { acknowledgement, advance, now } = loadStackWithClock();
  assert.equal(
    acknowledgement.acknowledgeAvatarTap({ nowMs: now(), reducedMotion: false }),
    'acknowledged',
  );
  advance(300); // inside the 700ms reaction
  assert.equal(
    acknowledgement.acknowledgeAvatarTap({ nowMs: now(), reducedMotion: false }),
    'busy',
  );
});

test('KSB29-M01: speaking and thinking still refuse a tap after expiry logic', () => {
  // Reaction expiry must not have weakened the genuine priority states: a tap
  // may never interrupt speech.
  const { acknowledgement, controller, advance, now } = loadStackWithClock();
  controller.requestMode('thinking');
  advance(5_000);
  assert.equal(
    acknowledgement.acknowledgeAvatarTap({ nowMs: now(), reducedMotion: false }),
    'busy',
    'thinking is not a self-expiring state and must still refuse',
  );
});

/* ------------------------------------------------------------------ */
/* KSB29-M02 — the acknowledgement must be OBSERVABLE                  */
/* ------------------------------------------------------------------ */

test('KSB29-M02: a tap produces a visible brow change through the real rules', () => {
  const { acknowledgement, controller, now } = loadStackWithClock();
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const rules = transpileModule('services/avatarExpressionRules.ts', {
    './avatarMotionState': contract,
  });

  // Before the tap: nothing to show.
  assert.equal(
    rules.resolveBrowState('neutral', 'idle', FULL_CAPABILITIES, false),
    'neutral',
  );

  acknowledgement.acknowledgeAvatarTap({ nowMs: now(), reducedMotion: false });

  // The controller now holds the pair the expression rules already understood.
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'reacting');
  assert.equal(snapshot.expression, 'warm');

  // THE POINT OF M02: that pair renders as something the user can see. The rule
  // existed all along; the header delivered neither value, so the tap was
  // computed and thrown away.
  assert.equal(
    rules.resolveBrowState(snapshot.expression, snapshot.mode, FULL_CAPABILITIES, false),
    'raised',
    'the acknowledgement must be visible, not merely recorded',
  );
});

test('KSB29-M02: the header reports both the reacting state and the expression', () => {
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );

  // Without a `reacting` branch the renderer silently kept showing idle.
  assert.match(header, /conversationMode === 'reacting'/);
  assert.match(header, /avatarState = 'reacting'/);

  // ...and without the expression the brow rule could never fire.
  assert.match(header, /useAvatarMotionExpression/);
  const expressionProps = header.match(/expression=\{conversationExpression\}/g) || [];
  assert.equal(expressionProps.length, 2, 'both avatar renders must carry the expression');

  // Priority is preserved: an acknowledgement may not mask speech or thinking.
  const speakingIndex = header.indexOf("avatarState = 'speaking'");
  const thinkingIndex = header.indexOf("avatarState = 'thinking'");
  const reactingIndex = header.indexOf("avatarState = 'reacting'");
  assert.ok(speakingIndex < reactingIndex && thinkingIndex < reactingIndex);
});

test('KSB29-M02: a reaction is not announced to assistive technology', () => {
  // The acknowledgement is a brief visual courtesy. Announcing it would
  // interrupt a screen-reader user mid-sentence to report no state change.
  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );
  assert.match(header, /avatarState === 'reacting' \? 'idle' : avatarState/);
});

test('KSB29-M02: Reduce Motion still yields no expression change', () => {
  // Unchanged contract: under Reduce Motion the semantic event fires and the
  // UI announces it textually, but no motion or expression is set.
  const { acknowledgement, controller, now } = loadStackWithClock();
  acknowledgement.acknowledgeAvatarTap({ nowMs: now(), reducedMotion: true });
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'idle');
  assert.equal(snapshot.expression, 'neutral');
});
