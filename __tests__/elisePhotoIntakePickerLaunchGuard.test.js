// The photo intake auto-opens the native picker from an effect. This suite pins
// the one property that keeps that to a single gallery: the in-flight claim must
// be taken BEFORE the first await, because the composer passes a fresh inline
// `onClose` on every render and `startPicker` depends on it — so the effect
// re-fires while the user is still standing in the gallery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function sameDeps(left, right) {
  return Boolean(
    left &&
      right &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index])),
  );
}

function createRenderer() {
  const registry = new Map();
  let active = null;

  function slotsFor(id) {
    let entry = registry.get(id);
    if (!entry) {
      entry = { slots: [], cursor: 0, queued: [] };
      registry.set(id, entry);
    }
    return entry;
  }

  const react = {
    useState(initial) {
      const entry = active;
      const index = entry.cursor++;
      if (!entry.slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = (next) => {
          const resolved = typeof next === 'function' ? next(slot.value) : next;
          slot.value = resolved;
        };
        entry.slots[index] = slot;
      }
      return [entry.slots[index].value, entry.slots[index].set];
    },
    useRef(initial) {
      const entry = active;
      const index = entry.cursor++;
      if (!entry.slots[index]) entry.slots[index] = { value: { current: initial } };
      return entry.slots[index].value;
    },
    useMemo(factory, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.slots[index] = { value: factory(), deps };
      }
      return entry.slots[index].value;
    },
    useCallback(callback, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.slots[index] = { value: callback, deps };
      }
      return entry.slots[index].value;
    },
    useEffect(effect, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.queued.push({ index, effect, deps, cleanup: previous?.cleanup });
      }
    },
  };

  return {
    react,
    /** One commit of the component function, then its due effects. */
    render(Component, props) {
      const entry = slotsFor('root');
      const previous = active;
      active = entry;
      entry.cursor = 0;
      entry.queued = [];
      try {
        Component(props);
      } finally {
        active = previous;
      }
      const pending = entry.queued;
      entry.queued = [];
      for (const queued of pending) {
        if (typeof queued.cleanup === 'function') queued.cleanup();
        const cleanup = queued.effect();
        entry.slots[queued.index] = {
          deps: queued.deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        };
      }
    },
  };
}

function transpile(rel) {
  const filename = path.join(ROOT, rel);
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

/**
 * Mounts the intake with a gallery that never returns, which is exactly the
 * window the defect lives in: the user is looking at the picker and the chat
 * behind it keeps re-rendering.
 */
function mountWithOpenPicker() {
  const renderer = createRenderer();
  const calls = { launches: 0, permissions: 0 };

  const imagePicker = {
    requestMediaLibraryPermissionsAsync: async () => {
      calls.permissions += 1;
      return { status: 'granted' };
    },
    // Never settles: the gallery stays open for the rest of the test.
    launchImageLibraryAsync: () => {
      calls.launches += 1;
      return new Promise(() => {});
    },
  };

  const passthroughComponent = (name) => name;
  // Elements are never walked here — only the hook order and the picker calls
  // matter — so the runtime just needs to return something inert.
  const element = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null });
  const stubs = {
    react: { ...renderer.react, default: renderer.react },
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': {
      ActivityIndicator: 'ActivityIndicator',
      Alert: { alert: () => {} },
      Image: 'Image',
      Modal: 'Modal',
      ScrollView: 'ScrollView',
      StyleSheet: { create: (styles) => styles },
      Text: 'Text',
      View: 'View',
    },
    'expo-image-picker': imagePicker,
    'expo-image-manipulator': { manipulateAsync: async () => ({ uri: 'file:///m.jpg' }) },
    '../StyleObjectCards': { TextField: passthroughComponent('TextField') },
    '../luxury': {
      InlineNotice: 'InlineNotice',
      PrimaryButton: 'PrimaryButton',
      SecondaryButton: 'SecondaryButton',
    },
    '../../constants/theme': {
      // StyleSheet definitions spread nested theme groups, so every lookup has
      // to yield an object rather than a bare value.
      LUXURY: new Proxy({}, { get: () => new Proxy({}, { get: () => '#000' }) }),
      SPACING: new Proxy({}, { get: () => 0 }),
    },
    '../../services/privacyImageSanitizer': {
      getPrivacySanitizerStatus: () => ({ faceBlurApplied: true, plateMaskApplied: true }),
      sanitizeImageBeforeUpload: async (uri) => uri,
    },
    '../../services/scanIdentification': { identifyScanImage: async () => ({ ok: true }) },
    '../../services/scanIdentificationMapper': { mapScanIdentifyToAnalysis: () => ({}) },
    '../../services/actorContext': { createActorRequest: () => ({ actorId: 'actor-a' }) },
    '../../types/styleChatAttachments': {},
    '../../services/closetCandidateLibrary': {
      createClosetCandidate: async () => ({ ok: true }),
      deleteClosetCandidate: async () => ({ ok: true }),
      getClosetCandidate: async () => null,
      transitionClosetCandidate: async () => ({ ok: true }),
      updateClosetCandidate: async () => ({ ok: true }),
    },
    '../../services/closetCandidatePromotion': {
      promoteSelectedClosetCandidates: async () => ({ ok: true }),
    },
    '../../types/fashionIdentificationV2': {},
    '../../services/style-chat/eliseDirectImageIdentification': {
      identifyDirectImageForStyle: async () => ({ kind: 'cancelled' }),
    },
    '../../services/style-chat/eliseIdentificationV2': {
      beginEliseV2Session: () => ({ enabled: false }),
    },
    '../../services/style-chat/eliseFashionContextV2': {
      describeIdentification: () => '',
      groundableItems: () => [],
      primaryColorOf: () => '',
      summaryOf: () => '',
    },
  };

  const { StyleChatPhotoIntake } = runModule(
    'components/style-chat/StyleChatPhotoIntake.tsx',
    (spec) => {
      if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
      throw new Error(`Unexpected StyleChatPhotoIntake import: ${spec}`);
    },
  );

  return { renderer, calls, StyleChatPhotoIntake };
}

/** The composer's real prop shape: a fresh inline `onClose` on every render. */
const freshProps = () => ({
  visible: true,
  onClose: () => {},
  onAttached: () => {},
  onClosetOutcome: () => {},
});

test('a re-render while the gallery is open does not launch a second picker', async () => {
  const { renderer, calls, StyleChatPhotoIntake } = mountWithOpenPicker();

  renderer.render(StyleChatPhotoIntake, freshProps());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.launches, 1, 'opening the sheet must launch exactly one picker');

  // The chat behind the modal re-renders (a message lands, isSending flips).
  // Each one hands the intake a brand-new onClose identity.
  for (let i = 0; i < 5; i += 1) {
    renderer.render(StyleChatPhotoIntake, freshProps());
    await Promise.resolve();
    await Promise.resolve();
  }

  assert.equal(
    calls.launches,
    1,
    'the in-flight claim must be held across re-renders while the gallery is open',
  );
});

test('the in-flight claim is taken before the first await, not after the picker returns', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatPhotoIntake.tsx'),
    'utf8',
  );
  const raw = source.match(/const startPicker = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/)?.[1];
  assert.ok(raw, 'startPicker must remain a single readable callback');
  // Prose about awaits and guards is not code; only real statements decide this.
  const body = raw.replace(/\/\/[^\n]*/g, '');

  const claim = body.indexOf('inFlightRef.current = true');
  const firstAwait = body.indexOf('await');
  assert.notEqual(claim, -1, 'startPicker must claim the in-flight guard');
  assert.notEqual(firstAwait, -1, 'startPicker must await the picker');
  assert.ok(
    claim < firstAwait,
    'the guard must be claimed before the first await, or the auto-open effect can re-enter',
  );
});

test('the auto-open effect stays gated on the in-flight claim', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatPhotoIntake.tsx'),
    'utf8',
  );
  assert.match(
    source,
    /if \(visible && step === 'idle' && !inFlightRef\.current\) \{\s*void startPicker\(\);/,
    'the single auto-open owner must keep reading the guard',
  );
});
