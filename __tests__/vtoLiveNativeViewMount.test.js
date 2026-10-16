// The Live panel must mount the existing native view, because every native
// session command addresses "the one mounted Live view". This proves what is
// mounted, when, with what props, and that Start is gated on it. It proves
// nothing about pixels or a physical camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRenderer, runModule, deepStub, findAll } = require('./helpers/componentRenderer');

const ROOT = path.resolve(__dirname, '..');

function load({ viewManager }) {
  const r = createRenderer();
  const asked = [];
  const modules = {
    ...r.runtimeModules,
    'react-native': {
      View: 'View', Text: 'Text', Image: 'Image', ActivityIndicator: 'ActivityIndicator',
      StyleSheet: { create: (s) => s, absoluteFill: { position: 'absolute' } },
    },
    'expo-modules-core': {
      requireNativeViewManager: (name) => {
        asked.push(name);
        if (viewManager === 'throw') throw new Error('no view manager');
        return viewManager;
      },
    },
    '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SPACING: deepStub() },
    '../luxury': { InlineNotice: 'InlineNotice', PrimaryButton: 'PrimaryButton', SecondaryButton: 'SecondaryButton', TertiaryButton: 'TertiaryButton' },
    '../../types/vtoLive': { LIVE_VTO_PROCESSING_NOTE: 'note' },
    '../../services/vto/vtoLiveSession': {},
  };
  const view = runModule('components/vto/VtoLiveNativeView.tsx', modules);
  const panel = runModule('components/vto/VtoLivePanel.tsx', { ...modules, './VtoLiveNativeView': view });
  const props = (entered) => ({
    session: { state: entered ? 'READY' : 'INITIALIZING', error: null }, entered, photorealFailure: null,
    previewUri: null, photorealPending: false, onEnter() {}, onClose() {}, onSwitchToAiPhoto() {},
    onRequestPhotoreal() {}, onCapturePreview() {}, onDismissPhotorealFailure() {},
  });
  return { r, panel, view, asked, props };
}

const NATIVE = 'KScanLiveVtoView';
const nativeViews = (tree) => findAll(tree, (n) => n.type === NATIVE);
const startButton = (tree) => findAll(tree, (n) => n.props?.testID === 'vto-live-enter')[0];

test('the lookup asks for the registered module name and returns the view', () => {
  const { view } = load({ viewManager: NATIVE });
  const asked = [];
  const resolved = view.resolveLiveVtoNativeView({ requireNativeViewManager: (n) => { asked.push(n); return NATIVE; } });
  assert.equal(resolved, NATIVE);
  assert.deepEqual(asked, ['KScanLiveVto']);
});

test('a missing or throwing view manager is absence, never an exception', () => {
  for (const viewManager of [undefined, null, 'throw']) {
    const { view } = load({ viewManager });
    assert.equal(view.resolveLiveVtoNativeView({ requireNativeViewManager: () => { if (viewManager === 'throw') throw new Error('x'); return viewManager; } }), null);
  }
});

test('the panel mounts exactly one native view before Start Live, and keeps it after entering', () => {
  const { r, panel, props } = load({ viewManager: NATIVE });
  const before = r.render(r.jsx(panel.VtoLivePanel, props(false)));
  assert.equal(nativeViews(before).length, 1, 'mounted before Start so start() has a view to address');
  const after = r.render(r.jsx(panel.VtoLivePanel, props(true)));
  assert.equal(nativeViews(after).length, 1, 'still exactly one once Live has been entered');
});

test('the native view carries layout props only: no data in, no per-frame callback out', () => {
  const { r, panel, props } = load({ viewManager: NATIVE });
  const [node] = nativeViews(r.render(r.jsx(panel.VtoLivePanel, props(false))));
  assert.deepEqual(Object.keys(node.props).sort(), ['collapsable', 'onLayout', 'style', 'testID']);
  assert.equal(node.props.collapsable, false);
});

test('Start Live is disabled until the native view reports a layout, then enabled', () => {
  const { r, panel, props } = load({ viewManager: NATIVE });
  assert.equal(startButton(r.render(r.jsx(panel.VtoLivePanel, props(false)))).props.disabled, true);
  nativeViews(r.render(r.jsx(panel.VtoLivePanel, props(false))))[0].props.onLayout({});
  assert.equal(startButton(r.render(r.jsx(panel.VtoLivePanel, props(false)))).props.disabled, false);
});

test('with no native view (module absent, dev harness) nothing is mounted and Start is not gated', () => {
  const { r, panel, props } = load({ viewManager: null });
  const tree = r.render(r.jsx(panel.VtoLivePanel, props(false)));
  assert.equal(nativeViews(tree).length, 0);
  assert.equal(startButton(tree).props.disabled, false);
});

test('the native view is mounted from the Live panel only', () => {
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!['node_modules', '__tests__', 'modules'].includes(entry.name)) walk(rel); continue; }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      if (rel === 'components/vto/VtoLiveNativeView.tsx' || rel === 'components/vto/VtoLivePanel.tsx') continue;
      if (/VtoLiveNativeView|requireNativeViewManager\(\s*['"]KScanLiveVto/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) offenders.push(rel);
    }
  })('.');
  const walkDirs = ['components', 'app', 'hooks', 'services'];
  const found = offenders.filter((f) => walkDirs.some((d) => f.startsWith(`${d}/`)) || f === 'app.js');
  assert.deepEqual(found, [], 'exactly one surface may mount the single Live view');
});
