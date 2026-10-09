'use strict';

/**
 * Matrix points 1 and 2 at the control level: the pre-analysis review surface
 * that lets a user order, add and remove photos. The real
 * components/scan-room/CaptureReview.tsx is executed; only theme tokens, the
 * safe-area hook and three presentational siblings are stand-ins.
 *
 * Not provable here (device only): the native picker UI and its own ordering.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  byTestId,
  createReactNativeStub,
  createRenderer,
  deepStub,
  findAll,
  runModule,
  textContent,
} = require('./helpers/componentRenderer');

function renderReview(props) {
  const renderer = createRenderer();
  const rn = createReactNativeStub();
  rn.useWindowDimensions = () => ({ width: 390, height: 844 });
  const { CaptureReview } = runModule('components/scan-room/CaptureReview.tsx', {
    ...renderer.runtimeModules,
    'react-native': rn,
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING: deepStub() },
    '../luxury/LuxuryButton': { LuxuryButton: 'LuxuryButton' },
    '../luxury/StatusPill': { StatusPill: 'StatusPill' },
    './ScanRoomHeader': { ScanRoomHeader: 'ScanRoomHeader' },
  });
  return renderer.render(renderer.jsx(CaptureReview, props));
}

const images = (count) => Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, uri: `file:///cache/${index}.jpg` }));
const base = (count, extra = {}) => ({
  imageUri: 'file:///cache/0.jpg', images: images(count), source: 'upload',
  onRetake() {}, onAnalyze() {}, onAddImage() {}, onRemoveImage() {}, ...extra,
});

test('1/2: the review shows every selected photo in order with its position label', () => {
  for (const count of [1, 2, 5]) {
    const tree = renderReview(base(count));
    const text = textContent(tree);
    assert.match(text, count === 1 ? /1 image selected/ : new RegExp(`${count} images selected`));
    for (let index = 1; index <= count; index += 1) assert.match(text, new RegExp(`Image\\s+${index}\\b`));
    const removes = findAll(tree, (node) => /^scan-room-remove-image-\d+$/.test(node.props?.testID ?? ''));
    assert.equal(removes.length, count);
  }
});

test('2: Add image is offered below five photos and withdrawn at five', () => {
  assert.equal(byTestId(renderReview(base(1)), 'scan-room-add-image').length, 1);
  assert.equal(byTestId(renderReview(base(4)), 'scan-room-add-image').length, 1);
  assert.equal(byTestId(renderReview(base(5)), 'scan-room-add-image').length, 0);
});

test('2: each Remove control removes exactly its own photo by id, and Add image opens the picker', () => {
  const removed = [];
  let added = 0;
  const tree = renderReview(base(3, { onRemoveImage: (id) => removed.push(id), onAddImage: () => { added += 1; } }));
  byTestId(tree, 'scan-room-remove-image-1')[0].props.onPress();
  byTestId(tree, 'scan-room-remove-image-2')[0].props.onPress();
  byTestId(tree, 'scan-room-add-image')[0].props.onPress();
  assert.deepEqual(removed, ['asset-1', 'asset-2']);
  assert.equal(added, 1);
});

test('1: with the multi-image controls withheld the review is the ordinary single-photo review', () => {
  const tree = renderReview({
    imageUri: 'file:///cache/0.jpg', images: images(1), source: 'camera', onRetake() {}, onAnalyze() {},
  });
  assert.equal(byTestId(tree, 'scan-room-add-image').length, 0);
  assert.equal(findAll(tree, (node) => /^scan-room-remove-image-/.test(node.props?.testID ?? '')).length, 0);
});
