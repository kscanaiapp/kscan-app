const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { loadEngine, mouthOnlyCapabilities, snapshot, characterAlignment } = require('./fixtures/avatarEngineHarness');
const ROOT = path.resolve(__dirname, '..');
const screen = () => fs.readFileSync(path.join(ROOT, 'app/style-chat/[sessionId].tsx'), 'utf8');

function footerExpression(source) {
  const ast = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let footer;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'ListFooterComponent') footer = node.initializer.expression.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(footer);
  return footer;
}
function renderFooter(source, promptVisible) {
  const output = ts.transpileModule(`export const footer = (${footerExpression(source)});`, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} }; let accepted = 0; let declined = 0;
  const make = (type, props) => ({ type, props });
  new Function('require', 'module', 'exports', 'ThinkingIndicator', 'weather', 'StyleChatWeatherPrompt', output)(
    () => ({ jsx: make, jsxs: make, Fragment: 'fragment' }), mod, mod.exports,
    { type: 'thinking', props: {} },
    { enabled: true, promptVisible, requesting: false, acceptWeather: async () => { accepted++; }, dismissPrompt: async () => { declined++; } },
    'weather-prompt',
  );
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'weather-prompt') return node;
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) { const result = find(child); if (result) return result; }
    return null;
  }
  return { prompt: find(mod.exports.footer), accepted: () => accepted, declined: () => declined };
}

test('full weather disclosure scrolls with messages and retains both consent actions while keyboard stays open', async () => {
  const h = renderFooter(screen(), true);
  assert.ok(h.prompt, 'large consent prompt must be in the scrollable FlatList footer');
  await h.prompt.props.onUseWeather(); await h.prompt.props.onNotNow();
  assert.equal(h.accepted(), 1); assert.equal(h.declined(), 1);
  assert.equal(renderFooter(screen(), false).prompt, null);
  assert.match(screen(), /keyboardShouldPersistTaps="handled"/);
  assert.match(screen(), /<KeyboardAvoidingView[\s\S]*keyboardVerticalOffset=\{0\}/);
  assert.match(screen(), /composerWrap: \{\s*flexShrink: 0/);
});

test('small keyboard viewport and large disclosure text do not spend fixed composer space', () => {
  const h = renderFooter(screen(), true);
  for (const [remainingViewport, composer, compactControls, promptContent] of [
    [190, 76, 42, 285], [220, 108, 48, 480], [155, 72, 32, 560],
  ]) {
    // The render tree determines whether disclosure height is fixed or scroll
    // content. These are pressure cases, not a substitute for device layout.
    const fixedPromptHeight = h.prompt ? 0 : promptContent;
    const scrollingViewport = remainingViewport - composer - compactControls - fixedPromptHeight;
    assert.ok(scrollingViewport > 0, 'composer must fit above IME at each pressure case');
    assert.ok(promptContent > scrollingViewport, 'disclosure needs scrolling rather than clipping');
  }
});

function runtime(alignment = characterAlignment('aaaaaaaaaaaa', .08, .2)) {
  const { AvatarRuntime } = loadEngine();
  const value = new AvatarRuntime({ config: { transitionMs: 160 } });
  value.loadAvatar({ avatarId: 'stylist_portrait_05', capabilities: mouthOnlyCapabilities({ mouthHalfOpen: false }) });
  value.beginSpeech({ generation: 1, alignment });
  return value;
}
function at(value, seconds, extra = {}) {
  return value.update(snapshot({ playbackPositionSeconds: seconds, hostNowMs: seconds * 1000, ...extra }));
}

test('engine transition retains the previous approved mouth source at the next playback callback', () => {
  const value = runtime(); at(value, 0);
  const first = at(value, .08).mouthTransition;
  assert.equal(first.from, 'closed'); assert.equal(first.to, 'open'); assert.equal(first.progress, 0);
  const middle = at(value, .16).mouthTransition;
  assert.equal(middle.from, 'closed', 'the old implementation incorrectly replaced from with target');
  assert.equal(middle.to, 'open'); assert.ok(Math.abs(middle.progress - .5) < .0001);
  assert.equal(at(value, .25).mouthTransition, null);
});

test('quick closed/open reversal preserves the current blend instead of snapping to a full old target', () => {
  const value = runtime(characterAlignment('am', .08, .12)); at(value, 0); at(value, .08); at(value, .16);
  const reverse = at(value, .2).mouthTransition;
  assert.equal(reverse.from, 'open'); assert.equal(reverse.to, 'closed');
  assert.ok(Math.abs(reverse.progress - .0625) < .001, 'new closed opacity equals the prior closed contribution');
});

test('end, interruption, stale scope and Reduce Motion return neutral without a lingering blend', () => {
  for (const gate of [{ phase: 'idle', playing: false }, { phase: 'stopping', interrupted: true }, { foreground: false }, { reduceMotion: true }, { speechGeneration: 0 }, { avatarId: 'other-avatar' }]) {
    const value = runtime(); at(value, 0); at(value, .08);
    const frame = at(value, .16, gate);
    assert.equal(frame.mouthTransition, null, JSON.stringify(gate));
    assert.equal(frame.mouthState, 'closed', JSON.stringify(gate));
  }
});

function renderAvatar(changes = {}) {
  const source = fs.readFileSync(path.join(ROOT, 'components/stylist/AnimatedStylistAvatar.tsx'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const mod = { exports: {} };
  const make = (type, props) => ({ type, props });
  const dependencies = {
    react: { useMemo: (fn) => fn(), useEffect() {}, useRef: (current) => ({ current }) },
    'react/jsx-runtime': { jsx: make, jsxs: make },
    'react-native': { Animated: { Value: class {}, View: 'animated' }, View: 'view', Image: 'image', StyleSheet: { create: (x) => x, absoluteFillObject: {} } },
    '../../constants/stylistIdentity': {
      STYLIST_AVATAR_PRESET_BY_ID: new Map([['stylist_portrait_01', { kind: 'portrait', availability: 'ready', source: 20 }]]),
      getStylistMouthMotionConfig: () => ({ speakingMotionMode: 'mouth_states', mouthRegion: { x: .39, y: .7, width: .27, height: .09 }, mouthStateSources: { closed: 10, open: 11 } }),
    },
    './StylistAvatar': { StylistAvatar: 'base-portrait' },
  };
  new Function('require', 'module', 'exports', output)((id) => {
    assert.ok(id in dependencies, id); return dependencies[id];
  }, mod, mod.exports);
  const tree = mod.exports.AnimatedStylistAvatar({ avatarId: 'stylist_portrait_01', state: 'speaking', mouthState: 'open',
    mouthTransition: { from: 'closed', to: 'open', progress: .5, durationMs: 160 }, ...changes });
  const layers = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function' && node.type.name === 'MouthStateLayer') layers.push(node.type(node.props));
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) visit(child);
  }
  visit(tree); return { layers, source };
}

test('renderer consumes engine midpoint using approved opaque underlay and partial target, without another mouth clock', () => {
  const { layers, source } = renderAvatar();
  assert.equal(layers.length, 2);
  assert.equal(layers[0].props.children.props.source, 10);
  assert.equal(layers[0].props.style.opacity, 1, 'opaque old crop prevents a neutral-base flash');
  assert.equal(layers[1].props.children.props.source, 11);
  assert.equal(layers[1].props.style.opacity, .5);
  for (const layer of layers) assert.equal(layer.props.children.props.fadeDuration, 0);
  const mouthCode = source.slice(source.indexOf('function MouthStateLayer'), source.indexOf('export function AnimatedStylistAvatar'));
  assert.doesNotMatch(mouthCode, /Animated\.|setInterval|setTimeout|Date\.now/);
  assert.equal(loadEngine().DEFAULT_AVATAR_ENGINE_CONFIG.transitionMs, 160);
});

test('renderer immediately removes all mouth layers on neutral/end/Reduce Motion and safely resolves missing half-open art', () => {
  for (const changes of [{ state: 'idle' }, { state: 'static' }, { reducedMotion: true }]) {
    assert.equal(renderAvatar(changes).layers.length, 0);
  }
  const unsupported = renderAvatar({ mouthState: 'halfOpen', mouthTransition: { from: 'closed', to: 'halfOpen', progress: .5, durationMs: 160 } });
  assert.equal(unsupported.layers.length, 1);
  assert.equal(unsupported.layers[0].props.children.props.source, 10);
  for (const progress of [NaN, -1, 2]) assert.equal(renderAvatar({ mouthTransition: { from: 'closed', to: 'open', progress, durationMs: 160 } }).layers.length, 1);
  for (const transition of [
    { from: 'unknown', to: 'open' }, { from: 'closed', to: 'unknown' },
    { from: 'open', to: 'closed' },
  ]) {
    const invalid = renderAvatar({ mouthTransition: { ...transition, progress: .5, durationMs: 160 } });
    assert.equal(invalid.layers.length, 1);
    assert.equal(invalid.layers[0].props.children.props.source, 11, 'invalid transition keeps the current valid mouth state');
  }
});

test('quick reversal preserves actual composited RGB weights on the rendered opaque underlay', () => {
  const value = runtime(characterAlignment('am', .08, .12)); at(value, 0); at(value, .08); at(value, .16);
  const transition = at(value, .2).mouthTransition;
  const closed = [90, 40, 25], open = [210, 185, 165];
  const colors = { 10: closed, 11: open };
  const { layers } = renderAvatar({ mouthState: 'closed', mouthTransition: transition });
  let pixel = [15, 15, 15]; // base must contribute zero behind the opaque crop.
  for (const layer of layers) {
    const opacity = layer.props.style.opacity;
    const color = colors[layer.props.children.props.source];
    pixel = pixel.map((channel, i) => channel * (1 - opacity) + color[i] * opacity);
  }
  // At reversal time120ms, ease(.75)=.9375 of the old OPEN target.
  const expected = closed.map((channel, i) => channel * .0625 + open[i] * .9375);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(pixel[i] - expected[i]) < 1e-8);
});
