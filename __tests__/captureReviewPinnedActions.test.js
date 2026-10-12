'use strict';

/**
 * P-UX-1: on Upload Review the Analyze button could sit below the visible screen.
 *
 * The review was one ScrollView and its two buttons were the last thing in it,
 * under a 4:5 image, the photo strip (with the multi-image Scanner on) and two
 * cards. On a phone the only way forward therefore started off screen, and
 * nothing on the first screenful said there was more below.
 *
 * The buttons now sit in a footer pinned above the bottom safe area, outside the
 * scrolling content. The real components/scan-room/CaptureReview.tsx is executed
 * and the assertions are about WHERE the buttons are in the rendered tree.
 *
 * Not provable here (device only): pixel positions. The tree shape is what makes
 * the footer independent of content height, and that is what is checked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  byTestId,
  createReactNativeStub,
  createRenderer,
  deepStub,
  descendantsOf,
  elementChildren,
  findAll,
  textContent,
  runModule,
} = require('./helpers/componentRenderer');

// The real spacing scale: the safe-area arithmetic is part of what is tested.
const SPACING = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 };

function renderReview(props, { viewport = { width: 390, height: 844 }, bottomInset = 0, mutate } = {}) {
  const renderer = createRenderer();
  const rn = createReactNativeStub();
  rn.useWindowDimensions = () => viewport;
  const { CaptureReview } = runModule('components/scan-room/CaptureReview.tsx', {
    ...renderer.runtimeModules,
    'react-native': rn,
    'react-native-safe-area-context': {
      useSafeAreaInsets: () => ({ top: 0, bottom: bottomInset, left: 0, right: 0 }),
    },
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING },
    '../luxury/LuxuryButton': { LuxuryButton: 'LuxuryButton' },
    '../luxury/StatusPill': { StatusPill: 'StatusPill' },
    './ScanRoomHeader': { ScanRoomHeader: 'ScanRoomHeader' },
  }, mutate ? { mutate } : {});
  return renderer.render(renderer.jsx(CaptureReview, props));
}

const images = (count) => Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, uri: `file:///cache/${index}.jpg` }));
const uploadProps = (count, extra = {}) => ({
  imageUri: 'file:///cache/0.jpg', images: images(count), source: 'upload',
  onRetake() {}, onAnalyze() {}, onAddImage() {}, onRemoveImage() {}, ...extra,
});
const cameraProps = (extra = {}) => ({
  imageUri: 'file:///cache/0.jpg', images: images(1), source: 'camera', onRetake() {}, onAnalyze() {}, ...extra,
});

const flatStyle = (style) => Object.assign({}, ...[].concat(style ?? []).flat(Infinity).filter(Boolean));
const one = (nodes, what) => {
  assert.equal(nodes.length, 1, `expected exactly one ${what}, found ${nodes.length}`);
  return nodes[0];
};
const isIn = (ancestor, testID) => descendantsOf(ancestor, (node) => node.props?.testID === testID).length === 1;
/** The host element the component returns: the parent of the review scroll view. */
const frameOf = (tree) => one(
  findAll(tree, (node) => elementChildren(node).some((child) => child.type === 'ScrollView'
    && child.props?.testID === 'scan-room-review-scroll')),
  'review frame',
);

/** Small Android, small and current iPhones, a tall Android. */
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
];

test('the screen is a fixed frame: scrolling content above, the action footer below', () => {
  const tree = renderReview(uploadProps(1));
  const root = frameOf(tree);
  assert.equal(root.type, 'View');
  assert.equal(flatStyle(root.props.style).flex, 1);

  const children = elementChildren(root);
  assert.deepEqual(children.map((child) => child.type), ['ScrollView', 'View']);
  assert.equal(children[0].props.testID, 'scan-room-review-scroll');
  assert.equal(flatStyle(children[0].props.style).flex, 1, 'the scroll area takes the space the footer leaves');
  assert.equal(children[1].props.testID, 'scan-room-review-actions');
});

test('Analyze is in the pinned footer, never inside the scroll view, at every viewport and photo count', () => {
  for (const viewport of VIEWPORTS) {
    for (const props of [uploadProps(1), uploadProps(5), cameraProps()]) {
      const tree = renderReview(props, { viewport });
      const scroll = one(byTestId(tree, 'scan-room-review-scroll'), 'scroll view');
      const footer = one(byTestId(tree, 'scan-room-review-actions'), 'action footer');
      const label = `${viewport.width}x${viewport.height} ${props.source} x${props.images.length}`;

      one(byTestId(tree, 'scan-room-analyze'), `Analyze button (${label})`);
      assert.equal(isIn(footer, 'scan-room-analyze'), true, `Analyze must be in the footer (${label})`);
      assert.equal(isIn(scroll, 'scan-room-analyze'), false, `Analyze must not scroll away (${label})`);

      const secondary = props.source === 'upload' ? 'scan-room-replace-image' : 'scan-room-retake';
      assert.equal(isIn(footer, secondary), true, `${secondary} must be in the footer (${label})`);
      assert.equal(isIn(scroll, secondary), false);
    }
  }
});

test('the footer is an ordinary in-flow sibling, so content cannot hide underneath it', () => {
  const footer = one(byTestId(renderReview(uploadProps(5)), 'scan-room-review-actions'), 'action footer');
  const style = flatStyle(footer.props.style);
  assert.notEqual(style.position, 'absolute');
  assert.equal(style.borderTopWidth, 1);
});

test('the footer clears the bottom safe area, and never drops below a comfortable minimum', () => {
  const paddingFor = (bottomInset) => flatStyle(
    one(byTestId(renderReview(uploadProps(1), { bottomInset }), 'scan-room-review-actions'), 'action footer').props.style,
  ).paddingBottom;
  assert.equal(paddingFor(0), SPACING.md, 'no inset (hardware buttons): the minimum padding');
  assert.equal(paddingFor(8), SPACING.md);
  assert.equal(paddingFor(34), 34, 'iPhone home indicator');
  assert.equal(paddingFor(48), 48, 'Android three-button navigation');
});

test('the review content still scrolls: photo strip, cards and the privacy note stay in the scroll view', () => {
  const tree = renderReview(uploadProps(5));
  const scroll = one(byTestId(tree, 'scan-room-review-scroll'), 'scroll view');
  const removes = descendantsOf(scroll, (node) => /^scan-room-remove-image-\d+$/.test(node.props?.testID ?? ''));
  assert.equal(removes.length, 5);
  const text = textContent(scroll);
  assert.match(text, /Upload Review/);
  assert.match(text, /5 images selected/);
  assert.match(text, /Ready to analyze/);
  assert.match(text, /Private by design\./);
});

test('the buttons keep their behaviour, labels and disabled state', () => {
  let analyzed = 0;
  let replaced = 0;
  const tree = renderReview(uploadProps(2, { onAnalyze: () => { analyzed += 1; }, onRetake: () => { replaced += 1; } }));
  const analyze = one(byTestId(tree, 'scan-room-analyze'), 'Analyze button');
  const replace = one(byTestId(tree, 'scan-room-replace-image'), 'Replace button');
  assert.equal(analyze.props.title, 'Analyze Scan');
  assert.equal(analyze.props.variant, 'primary');
  assert.equal(analyze.props.disabled, false);
  assert.equal(replace.props.title, 'Replace Image');
  analyze.props.onPress();
  replace.props.onPress();
  assert.deepEqual([analyzed, replaced], [1, 1]);

  const busy = renderReview(uploadProps(2, { isAnalyzing: true }));
  const busyAnalyze = one(byTestId(busy, 'scan-room-analyze'), 'Analyze button');
  assert.equal(busyAnalyze.props.title, 'ANALYZING…');
  assert.equal(busyAnalyze.props.disabled, true);
  assert.equal(one(byTestId(busy, 'scan-room-replace-image'), 'Replace button').props.disabled, true);

  assert.equal(one(byTestId(renderReview(cameraProps()), 'scan-room-retake'), 'Retake button').props.title, 'Retake');
});

test('there is exactly one of each action (nothing was duplicated into the footer)', () => {
  const tree = renderReview(uploadProps(3));
  assert.equal(findAll(tree, (node) => node.type === 'LuxuryButton').length, 2);
});

test('NEGATIVE CONTROL: with the buttons back inside the scroll view, these checks fail', () => {
  // Rebuild the pre-repair shape: the footer becomes the scroll view's last child.
  const backIntoScroll = (source) => {
    // Anchored at the line start: the photo strip has its own, deeper, ScrollView.
    const scrollClose = '\n    </ScrollView>\n';
    const frameClose = '      </View>\n    </View>\n  );\n}';
    assert.equal(source.split(scrollClose).length, 2, 'the scroll view close is not where this control expects it');
    assert.equal(source.split(frameClose).length, 2, 'the frame close is not where this control expects it');
    return source
      .replace(scrollClose, '\n')
      .replace(frameClose, '      </View>\n    </ScrollView>\n    </View>\n  );\n}');
  };
  const tree = renderReview(uploadProps(5), { mutate: backIntoScroll });
  const scroll = one(byTestId(tree, 'scan-room-review-scroll'), 'scroll view');
  assert.equal(isIn(scroll, 'scan-room-analyze'), true, 'the mutant puts Analyze back in the scroll view');
  assert.deepEqual(elementChildren(frameOf(tree)).map((child) => child.type), ['ScrollView']);
});
