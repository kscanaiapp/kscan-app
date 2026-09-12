// Avatar V10 -> Elise: accessibility posture.
//
// Three separate claims, each executed rather than described:
//
//   1. Reduce Motion is read through ONE cross-platform accessibility API, so
//      iOS "Reduce Motion" and Android "Remove animations" are the same switch
//      to this code — there is no platform branch to get wrong.
//   2. With motion reduced the avatar is still USEFUL: SPEAKING and THINKING
//      stay distinguishable from IDLE through the header's existing status
//      channel, which is what keeps a held-static face from reading as silence.
//   3. The avatar is decorative. It announces nothing to a screen reader and
//      takes no focus, on either platform.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const { loadTsModule, executableSource } = require('./fixtures/avatarEngineHarness');

const { deriveAvatarPresentation } = loadTsModule('services/avatars/avatarPresentation.ts');

// -- 1. One cross-platform accessibility authority ---------------------------

/**
 * Executes hooks/useReducedMotion.ts against a fake AccessibilityInfo.
 *
 * `platform` only names which OS setting the fake is standing in for: React
 * Native routes both to `isReduceMotionEnabled` / `reduceMotionChanged`, and
 * proving that both drive identical behaviour here is the point.
 */
function loadReducedMotion({ initial, settle }) {
  const listeners = new Map();
  let removeCalls = 0;
  const accessibility = {
    addEventListener(event, handler) {
      listeners.set(event, handler);
      return {
        remove: () => {
          removeCalls += 1;
          listeners.delete(event);
        },
      };
    },
    isReduceMotionEnabled: () => settle
      ? Promise.resolve(initial)
      : new Promise(() => {}),
  };

  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useReducedMotion.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const captured = {};
  const mod = { exports: {} };
  const sandbox = {
    Promise,
    Set,
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === 'react') {
        return {
          useSyncExternalStore: (subscribe, getSnapshot) => {
            captured.subscribe = subscribe;
            captured.getSnapshot = getSnapshot;
            return getSnapshot();
          },
        };
      }
      if (specifier === 'react-native') return { AccessibilityInfo: accessibility };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename: 'useReducedMotion.ts' });

  return {
    hook: mod.exports.useReducedMotion,
    captured,
    emit: (value) => listeners.get('reduceMotionChanged')?.(value),
    listenerCount: () => listeners.size,
    removeCalls: () => removeCalls,
  };
}

test('REDUCE MOTION: motion stays off until the native preference is actually known', () => {
  // Unresolved native read: the hook must not animate a first frame optimistically.
  const pending = loadReducedMotion({ initial: false, settle: false });
  assert.equal(pending.hook(), true, 'motion must default off while the setting is unknown');
});

test('REDUCE MOTION: one API serves iOS Reduce Motion and Android Remove Animations', async () => {
  for (const platform of ['ios', 'android']) {
    const lane = loadReducedMotion({ initial: true, settle: true });
    assert.equal(lane.hook(), true, platform);
    const unsubscribe = lane.captured.subscribe(() => {});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lane.captured.getSnapshot(), true, `${platform}: enabled setting not observed`);

    // The user turns it off mid-session; both platforms deliver the same event.
    lane.emit(false);
    assert.equal(lane.captured.getSnapshot(), false, `${platform}: change event ignored`);
    lane.emit(true);
    assert.equal(lane.captured.getSnapshot(), true, `${platform}: change event ignored`);

    unsubscribe();
    assert.equal(lane.listenerCount(), 0, `${platform}: the subscription leaked`);
    assert.equal(lane.removeCalls(), 1, platform);
  }

  // Structural: there is no platform branch to diverge.
  const source = executableSource('hooks/useReducedMotion.ts');
  assert.equal(/Platform\.OS|Platform\.select|isReduceTransparency/.test(source), false);
  assert.match(source, /isReduceMotionEnabled/);
  assert.match(source, /reduceMotionChanged/);
});

// -- 2. The avatar stays useful with motion reduced --------------------------

function presentation(overrides) {
  return deriveAvatarPresentation({
    playbackPhase: 'idle',
    playbackScopeMatches: false,
    playbackActive: false,
    utteranceGeneration: 0,
    eliseProcessing: false,
    listening: false,
    reduceMotion: true,
    mouthCapable: true,
    assetsAvailable: true,
    ...overrides,
  });
}

test('REDUCE MOTION: every state is still distinguishable from IDLE', () => {
  const idle = presentation({});
  const speaking = presentation({
    playbackPhase: 'playing',
    playbackScopeMatches: true,
    playbackActive: true,
    utteranceGeneration: 3,
  });
  const thinking = presentation({ eliseProcessing: true });

  // All three hold the face static — that is the settled K Scan interpretation
  // of Reduce Motion, and it includes mouth motion.
  for (const state of [idle, speaking, thinking]) {
    assert.equal(state.rendererState, 'static');
  }

  // And all three are still told apart, by the status channel rather than the
  // face. A signature per state, none of them equal to IDLE's.
  const signature = (p) => `${p.statusSpeaking}:${p.statusThinking}`;
  assert.equal(signature(idle), 'false:false');
  assert.equal(signature(speaking), 'true:false');
  assert.equal(signature(thinking), 'false:true');
  assert.notEqual(signature(speaking), signature(idle));
  assert.notEqual(signature(thinking), signature(idle));
});

test('REDUCE MOTION: the header keeps its status channel independent of motion', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  // The status dot follows the projection, which does not read Reduce Motion
  // for its state. A regression that gated it on `!reducedMotion` would make
  // reduced-motion SPEAKING identical to IDLE.
  assert.match(header, /presentation\.statusSpeaking \|\| presentation\.statusThinking/);
  assert.equal(/reducedMotion && styles\.statusDot|!reducedMotion \? styles\.statusDot/.test(header), false);
  // Motion itself IS gated: the ticker and the renderer both stop.
  assert.match(header, /enabled: !reducedMotion/);
  assert.match(header, /reduceMotion: reducedMotion/);
});

test('REDUCE MOTION: the engine returns a neutral frame and draws no mouth', () => {
  const { AvatarRuntime } = loadTsModule('services/avatars/engine/index.ts');
  const runtime = new AvatarRuntime();
  runtime.loadAvatar({
    avatarId: 'stylist_portrait_05',
    capabilities: {
      base: true,
      mouthClosed: true,
      mouthHalfOpen: true,
      mouthOpen: true,
      mouthRound: false,
      mouthWide: false,
      eyes: false,
      brows: false,
      gaze: false,
      compositeMotion: true,
      tapAcknowledgement: true,
    },
  });
  const frame = runtime.update({
    avatarId: 'stylist_portrait_05',
    speechGeneration: 1,
    phase: 'playing',
    playing: true,
    playbackPositionSeconds: 0.4,
    playbackAvailable: true,
    hostNowMs: 400,
    foreground: true,
    reduceMotion: true,
    motionEpoch: 0,
    motionEnabled: true,
    lipSyncEnabled: true,
  });
  assert.equal(frame.mouthState, 'closed');
  assert.equal(frame.shouldRenderMouth, false);
  assert.equal(frame.diagnostics.reason, 'reduced-motion');
  assert.equal(frame.headMotion.rotateDeg, 0);
  assert.equal(frame.breathing.scale, 1);
});

// -- 3. The avatar is decorative to assistive technology ---------------------

test('A11Y: the avatar announces nothing and takes no focus', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');

  // The avatar wrapper is hidden from the accessibility tree on both platforms:
  // accessibilityElementsHidden is the iOS property, importantForAccessibility
  // the Android one. Both are required, and both are present.
  const wrap = header.slice(header.indexOf('styles.avatarWrap'));
  assert.match(wrap, /accessibilityElementsHidden/);
  assert.match(wrap, /importantForAccessibility: "no-hide-descendants"|importantForAccessibility="no-hide-descendants"/);

  // The header's own identity text remains the accessible element.
  assert.match(header, /accessibilityRole: "header"|accessibilityRole="header"/);

  // Nothing in the avatar path asks for focus or announces a change.
  assert.equal(/setAccessibilityFocus|announceForAccessibility|accessibilityLiveRegion/.test(header), false);
});

test('A11Y: the status dot is decorative, not an announcement', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  const dot = header.slice(header.indexOf('styles.statusDot'));
  assert.match(dot, /accessibilityElementsHidden/);
  assert.match(dot, /no-hide-descendants/);
});

test('A11Y: the mouth overlay and the inspector are both hidden from the tree', () => {
  const renderer = executableSource('components/stylist/AnimatedStylistAvatar.tsx');
  const overlay = renderer.slice(renderer.indexOf('pointerEvents'));
  assert.match(overlay, /accessible: false|accessible=\{false\}/);
  assert.match(overlay, /accessibilityElementsHidden/);
  assert.match(overlay, /no-hide-descendants/);

  const inspector = executableSource('components/style-chat/AvatarStateInspector.tsx');
  assert.match(inspector, /accessibilityElementsHidden/);
  assert.match(inspector, /no-hide-descendants/);
  assert.equal(/setAccessibilityFocus|announceForAccessibility/.test(inspector), false);
});

test('A11Y: a screen-reader user is never given avatar speech instead of text', () => {
  // Pre-existing product rule, re-pinned because the projection now sits
  // between the store and the screen: speech is suppressed outright while a
  // screen reader is active, so the avatar has nothing to animate.
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  assert.match(hook, /screenReaderReady/);
  assert.match(hook, /!screenReaderEnabled/);
  assert.match(hook, /canSpeakNewMessages/);
});
