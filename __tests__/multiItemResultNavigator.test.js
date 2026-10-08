const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, createReactNativeStub, runModule, deepStub, findAll, textContent } = require('./helpers/componentRenderer');

function render(props) {
  const renderer = createRenderer();
  const { MultiItemResultNavigator } = runModule('components/scan-results/MultiItemResultNavigator.tsx', {
    ...renderer.runtimeModules, 'react-native': createReactNativeStub(),
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SPACING: deepStub() },
  });
  return renderer.render(renderer.jsx(MultiItemResultNavigator, props));
}
const candidate = { id: 'image-b:garment', label: 'Blue dress', category: 'dress', subtype: null,
  primaryColor: 'blue', sourceImageId: 'image-b', sourceImageIndex: 1 };
const ready = { id: 'ready', label: 'Coat', sourceImageIndex: 0, detailStatus: 'complete' };
const queued = { id: 'queued', label: 'Dress', sourceImageIndex: 1, detailStatus: 'complete' };
function byId(tree, id) { return findAll(tree, (node) => node.props?.testID === id)[0]; }

test('review selection explicitly toggles the candidate ID and announces its source image', () => {
  const selected = [];
  const tree = render({ mode: 'review', imageCount: 2, candidates: [candidate],
    selectedCandidateIds: [], onToggleCandidate: (id) => selected.push(id) });
  const control = byId(tree, 'multi-item-candidate-0');
  assert.equal(control.props.accessibilityRole, 'checkbox');
  assert.match(control.props.accessibilityLabel, /from image 2/);
  control.props.onPress();
  assert.deepEqual(selected, [candidate.id]);
});

test('processing selection is frozen and displays the current queue state', () => {
  const tree = render({ mode: 'processing', imageCount: 2, candidates: [candidate],
    selectedCandidateIds: [candidate.id], itemStates: { [candidate.id]: 'analyzing' } });
  const control = byId(tree, 'multi-item-candidate-0');
  assert.equal(control.props.disabled, true);
  assert.equal(control.props.onPress, undefined);
  assert.match(textContent(tree), /ANALYZING/);
});

test('progressive results show pending chips while bulk action labels count only analyzed items', () => {
  const tree = render({ imageCount: 2, items: [ready, queued], selectedItemId: 'ready',
    itemStates: { ready: 'ready', queued: 'queued' }, onSaveAll: () => {}, onAddAllToDressingRoom: () => {} });
  assert.equal(byId(tree, 'multi-item-result-1').props.disabled, true);
  assert.equal(byId(tree, 'multi-item-save-all').props.accessibilityLabel, 'Save all 1 analyzed items');
  assert.equal(byId(tree, 'multi-item-add-all-room').props.accessibilityLabel, 'Add all 1 analyzed items to a Dressing Room');
});

test('quota resume and partial retry require separate explicit user presses', () => {
  const calls = [];
  const tree = render({ imageCount: 2, items: [{ ...ready, detailStatus: 'partial' }],
    onResumeQueue: () => calls.push('resume'), resumeCount: 2,
    onRetryPartialItem: () => calls.push('retry') });
  assert.deepEqual(calls, []);
  byId(tree, 'multi-item-resume').props.onPress();
  byId(tree, 'multi-item-retry-partial').props.onPress();
  assert.deepEqual(calls, ['resume', 'retry']);
  assert.match(textContent(tree), /PARTIAL/);
});

test('failed siblings remain non-savable but expose an explicit retry while ready sibling is visible', () => {
  const calls = [];
  const tree = render({ imageCount: 2, items: [ready, queued], selectedItemId: 'ready',
    itemStates: { ready: 'ready', queued: 'failed' }, failedCount: 1,
    onRetryFailedItems: () => calls.push('failed-only') });
  assert.equal(byId(tree, 'multi-item-result-1').props.disabled, true);
  assert.deepEqual(calls, []);
  byId(tree, 'multi-item-retry-failed').props.onPress();
  assert.deepEqual(calls, ['failed-only']);
});
