'use strict';

/**
 * iOS: a sheet that must appear ABOVE a scan result has to be mounted INSIDE the
 * result's own <Modal>, not beside it.
 *
 * ROOT CAUSE (WP-SCAN-05, "Add to Dressing Room" from a Scan Result did nothing on iOS).
 * ScanResultV2 and AnalysisCard each render inside a native <Modal>. On iOS a
 * Modal is presented from the view controller that CONTAINS its host view
 * (react-native/React/Fabric/.../RCTModalHostViewComponentView.mm presents from
 * `[self reactViewController]`, the first UIViewController up the responder chain;
 * Libraries/Modal/Modal.js has no stack or queue). A sibling Modal therefore
 * resolves to the controller that is ALREADY presenting the result, and UIKit
 * refuses to present a second view controller from it. React Native gets no
 * failure callback, so the tap looks like a no-op. A Modal declared inside the
 * first Modal's children resolves to that Modal's own controller and presents.
 * Android stacks Dialogs and never had the problem.
 *
 * The UIKit refusal is platform behaviour and cannot be observed from Node: this
 * file pins the TOPOLOGY that makes it impossible (the sheet is a descendant of the
 * result's Modal), not the refusal itself. Confirm on an iOS simulator or device.
 *
 * `overlay` is the seam: ScanResultV2 and AnalysisCard render it as the LAST child
 * inside their Modal, and app.js / app/library.tsx pass the sheet through it.
 * Precedent: components/vto/VtoSaveToDressingRoom.tsx is mounted inside
 * VirtualTryOnSheet's Modal.
 *
 * The component checks EXECUTE the real modules under __tests__/helpers/
 * componentRenderer.js. The app.js and library.tsx checks read the TypeScript AST,
 * because which element is a sibling of which is not a question a substring search
 * can answer. Every negative control mutates the real source and must be reported;
 * the loader refuses a mutation that changes nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const {
  byTestId,
  byType,
  createReactNativeStub,
  createRenderer,
  deepStub,
  descendantsOf,
  elementChildren,
  jsxAttribute,
  jsxElementsNamed,
  jsxTagNameOf,
  parseSource,
  readSource,
  runModule,
  walkAst,
} = require('./helpers/componentRenderer');

const OVERLAY_ID = 'overlay-sentinel';
const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 };

function theme() {
  return {
    COLORS: deepStub(),
    LUXURY: deepStub(),
    LAYOUT: deepStub(),
    MOTION: deepStub(),
    RADIUS: deepStub(),
    SHADOWS: deepStub(),
    SPACING,
    TYPOGRAPHY: deepStub(),
    card: deepStub(),
  };
}

// ── Loading the real surfaces ────────────────────────────────────────────────

function loadResultSurfaceModal(renderer, options = {}) {
  return runModule(
    'components/scan-results/ResultSurfaceModal.tsx',
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub(),
    },
    options,
  );
}

/**
 * `probe.wrapperLoaded` records that the unrepaired-or-repaired surface really asked
 * for the Modal wrapper: a negative control that mutates a wrapper nobody loaded
 * proves nothing.
 */
function loadScanResultV2(renderer, { mutateV2, mutateWrapper, probe } = {}) {
  const modules = {
    ...renderer.runtimeModules,
    'react-native': createReactNativeStub(),
    'react-native-safe-area-context': {
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    },
    'expo-router': { useRouter: () => ({ canGoBack: () => false, back() {} }) },
    '../../hooks/useResponsiveLayout': {
      useResponsiveLayout: () => ({ height: 844, modalMaxWidth: 560 }),
    },
    '../../hooks/useFeatureFreeze': {
      useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }),
    },
    '../../constants/theme': theme(),
    './ScanResultHero': { ScanResultHero: 'ScanResultHero' },
    './StyleMatchPanel': { StyleMatchPanel: 'StyleMatchPanel' },
    './StyleAnalysisSection': { StyleAnalysisSection: 'StyleAnalysisSection' },
    './SimilarFindsShelf': { SimilarFindsShelf: 'SimilarFindsShelf' },
    './PurchaseOptionsPanel': { PurchaseOptionsPanel: 'PurchaseOptionsPanel' },
    './MultiItemCommerceSection': { MultiItemCommerceSection: 'MultiItemCommerceSection' },
    './ScanResultActionRow': { ScanResultActionRow: 'ScanResultActionRow' },
    '../luxury/EmptyStateCard': { EmptyStateCard: 'EmptyStateCard' },
    './types': {
      mapLegacyToV2: (legacy) =>
        legacy
          ? { title: 'Camel coat', category: 'Coat', styleAnalysis: legacy.result, analysisText: legacy.result }
          : null,
    },
    '../../constants/featureFlags': { SCAN_RESULTS_DEMO_UI_ENABLED: false },
    '../free-tier/ScanResultUtilityFooter': { ScanResultUtilityFooter: 'ScanResultUtilityFooter' },
    '../../data/scan-results-demo': { getDemoScanResultV2: () => ({}) },
    '../AnalysisCard': { resolvePurchaseShelfMode: () => 'hidden' },
    // Lazy: the unrepaired ScanResultV2 never asks for it.
    get './ResultSurfaceModal'() {
      if (probe) probe.wrapperLoaded = true;
      return loadResultSurfaceModal(renderer, { mutate: mutateWrapper });
    },
  };
  return runModule('components/scan-results/ScanResultV2.tsx', modules, { mutate: mutateV2 });
}

function loadAnalysisCard(renderer, { mutateCard, mutateWrapper, probe } = {}) {
  const modules = {
    ...renderer.runtimeModules,
    'react-native': createReactNativeStub(),
    'react-native-safe-area-context': {
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    },
    './MetadataChip': { MetadataChip: 'MetadataChip' },
    './ProductShelf': { ProductShelf: 'ProductShelf' },
    './scan/ScanResultCard': { ScanResultCard: 'ScanResultCard' },
    './SecondhandShelf': { SecondhandShelf: 'SecondhandShelf' },
    './SneakerMatchCard': { SneakerMatchCard: 'SneakerMatchCard' },
    '../hooks/useFeatureFreeze': {
      useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }),
    },
    '../hooks/useResponsiveLayout': {
      useResponsiveLayout: () => ({ height: 844, modalMaxWidth: 560 }),
    },
    '../contexts/AiOutputReportingContext': {
      useAiOutputReporting: () => ({ openAiOutputReport() {} }),
    },
    '../constants/theme': theme(),
    './free-tier/SavedItemUtilityPanel': { SavedItemUtilityPanel: 'SavedItemUtilityPanel' },
    '../services/free-tier/itemNormalization': {
      normalizeItem: (item) => item,
      normalizeItems: (items) => items,
    },
    // The shelf's empty-state copy. Real, not stubbed: it is pure and has no imports,
    // and AnalysisCard feeds its output straight into the (stubbed) shelf.
    '../services/commerceShelfState': runModule('services/commerceShelfState.ts', {}),
    // Lazy: the unrepaired AnalysisCard never asks for it.
    get './scan-results/ResultSurfaceModal'() {
      if (probe) probe.wrapperLoaded = true;
      return loadResultSurfaceModal(renderer, { mutate: mutateWrapper });
    },
  };
  return runModule('components/AnalysisCard.tsx', modules, { mutate: mutateCard });
}

const ANALYSIS = {
  result: 'A camel wool coat with a relaxed shoulder.',
  metadata: { category: 'Coat', color: 'Camel', silhouette: 'Relaxed' },
  products: [],
  purchaseOptions: [],
};

function renderScanResultV2(options = {}) {
  const renderer = createRenderer();
  const { ScanResultV2 } = loadScanResultV2(renderer, options);
  return renderer.render(
    renderer.jsx(ScanResultV2, {
      analysis: ANALYSIS,
      scanImageUri: 'file:///scan.jpg',
      scanSourceId: 'scan_1',
      onDismiss() {},
      onAddToDressingRoom() {},
      overlay: options.noOverlay ? undefined : renderer.jsx('View', { testID: OVERLAY_ID }),
    }),
  );
}

function renderAnalysisCard(options = {}) {
  const renderer = createRenderer();
  const { AnalysisCard } = loadAnalysisCard(renderer, options);
  return renderer.render(
    renderer.jsx(AnalysisCard, {
      result: ANALYSIS.result,
      metadata: ANALYSIS.metadata,
      scanSourceId: 'scan_1',
      onDismiss() {},
      onAddToDressingRoom() {},
      overlay: options.noOverlay ? undefined : renderer.jsx('View', { testID: OVERLAY_ID }),
    }),
  );
}

/** Problems with where the overlay sits; empty when it is the last child of the one Modal. */
function overlayPlacementProblems(tree) {
  const modals = byType(tree, 'Modal');
  if (modals.length !== 1) return [`expected exactly one Modal, found ${modals.length}`];
  const [modal] = modals;
  const problems = [];
  const inside = descendantsOf(modal, (node) => node.props?.testID === OVERLAY_ID);
  if (inside.length === 0) problems.push('the overlay is not rendered inside the result Modal');
  if (byTestId(tree, OVERLAY_ID).length > inside.length) {
    problems.push('the overlay is also rendered outside the result Modal');
  }
  if (inside.length > 0 && elementChildren(modal).at(-1)?.props?.testID !== OVERLAY_ID) {
    problems.push('the overlay is not the LAST child of the Modal');
  }
  return problems;
}

// ── Component contract: the overlay lives inside the Modal ───────────────────

test('iOS sheet nesting: ScanResultV2 mounts its overlay as the last child INSIDE its one Modal', () => {
  assert.deepEqual(overlayPlacementProblems(renderScanResultV2()), []);
});

test('iOS sheet nesting: AnalysisCard mounts its overlay as the last child INSIDE its one Modal', () => {
  assert.deepEqual(overlayPlacementProblems(renderAnalysisCard()), []);
});

test('iOS sheet nesting: a result surface without an overlay mounts nothing extra in its Modal', () => {
  for (const tree of [renderScanResultV2({ noOverlay: true }), renderAnalysisCard({ noOverlay: true })]) {
    const [modal] = byType(tree, 'Modal');
    assert.equal(byType(tree, 'Modal').length, 1);
    assert.equal(byTestId(tree, OVERLAY_ID).length, 0);
    assert.equal(elementChildren(modal).length, 1, 'the Modal holds only the surface itself');
  }
});

// ── app.js and app/library.tsx topology (AST) ────────────────────────────────

const RESULT_SURFACES = ['ScanResultV2', 'AnalysisCard'];
const SHEET = 'AddScanToDressingRoomModal';

function isInsideOverlayAttribute(node) {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isJsxAttribute(cursor) && cursor.name.getText() === 'overlay') return true;
  }
  return false;
}

function nearestJsxContainer(node) {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isJsxElement(cursor) || ts.isJsxFragment(cursor)) return cursor;
  }
  return null;
}

function variableInitializer(sourceFile, name) {
  for (const node of walkAst(sourceFile)) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name) return node.initializer ?? null;
  }
  return null;
}

function containsJsx(node, tagName) {
  for (const inner of walkAst(node)) {
    if (jsxTagNameOf(inner) === tagName) return true;
  }
  return false;
}

/** The sheet may never be a JSX sibling of a result surface (it would be presented from the controller that is already presenting it). */
function siblingProblems(sourceFile) {
  const surfaces = RESULT_SURFACES.flatMap((name) => jsxElementsNamed(sourceFile, name));
  const problems = [];
  for (const sheet of jsxElementsNamed(sourceFile, SHEET)) {
    if (isInsideOverlayAttribute(sheet)) continue;
    const container = nearestJsxContainer(sheet);
    if (!container) continue;
    const shared = surfaces.filter(
      (surface) => surface.pos >= container.pos && surface.end <= container.end,
    );
    if (shared.length > 0) {
      problems.push(
        `<${SHEET}> is a JSX sibling of <${shared.map(jsxTagNameOf).join('>, <')}>: on iOS it would be presented from the controller that is already presenting the result`,
      );
    }
  }
  return problems;
}

/** Each surface must receive the sheet through `overlay`, resolving to an element that renders the sheet. */
function overlayWiringProblems(sourceFile, expectedSurfaces) {
  const problems = [];
  const surfaces = RESULT_SURFACES.flatMap((name) => jsxElementsNamed(sourceFile, name));
  if (surfaces.length !== expectedSurfaces) {
    problems.push(`expected ${expectedSurfaces} result surface(s), found ${surfaces.length}`);
  }
  for (const surface of surfaces) {
    const tag = jsxTagNameOf(surface);
    const overlay = jsxAttribute(surface, 'overlay');
    if (!overlay || !overlay.initializer || !ts.isJsxExpression(overlay.initializer) || !overlay.initializer.expression) {
      problems.push(`<${tag}> receives no overlay, so the sheet cannot mount inside its Modal`);
      continue;
    }
    const expression = overlay.initializer.expression;
    const resolved = ts.isIdentifier(expression) ? variableInitializer(sourceFile, expression.text) : expression;
    if (!resolved || !containsJsx(resolved, SHEET)) {
      problems.push(`<${tag} overlay> does not render <${SHEET}>`);
    }
  }
  return problems;
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** app.js mounts ONE sheet: the overlay while a result surface is up, the top level otherwise. */
function appSingleInstanceProblems(sourceFile) {
  const problems = [];

  const gate = variableInitializer(sourceFile, 'resultSurfaceVisible');
  if (!gate) {
    problems.push('app.js does not declare resultSurfaceVisible');
  } else if (normalize(gate.getText()) !== "status === 'result' && !perceiving && !isReturningToElise") {
    problems.push(`resultSurfaceVisible is "${normalize(gate.getText())}", not the condition that mounts a result surface`);
  }

  const surfaceChoice = [...walkAst(sourceFile)].find(
    (node) => ts.isConditionalExpression(node) && node.condition.getText() === 'SCAN_RESULTS_V2_UI_ENABLED',
  );
  let surfacesGated = false;
  for (let cursor = surfaceChoice?.parent; cursor; cursor = cursor.parent) {
    if (
      ts.isBinaryExpression(cursor) &&
      cursor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      cursor.left.getText() === 'resultSurfaceVisible'
    ) {
      surfacesGated = true;
      break;
    }
  }
  if (!surfacesGated) {
    problems.push('the result surfaces are not gated by resultSurfaceVisible, so the fallback mount can disagree with what is shown');
  }

  const declared = variableInitializer(sourceFile, 'addScanToRoomModal');
  if (!declared || !containsJsx(declared, SHEET)) {
    problems.push(`addScanToRoomModal does not hold <${SHEET}>`);
  }

  const topLevelUses = [...walkAst(sourceFile)].filter(
    (node) =>
      ts.isIdentifier(node) &&
      node.text === 'addScanToRoomModal' &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !isInsideOverlayAttribute(node),
  );
  if (topLevelUses.length === 0) {
    problems.push('the sheet is never mounted when no result surface is up (the preview / non-fashion / error buttons would be dead)');
  }
  for (const use of topLevelUses) {
    let gatedOff = false;
    for (let cursor = use.parent; cursor; cursor = cursor.parent) {
      if (
        ts.isConditionalExpression(cursor) &&
        cursor.condition.getText() === 'resultSurfaceVisible' &&
        cursor.whenTrue.getText() === 'null' &&
        cursor.whenFalse === use
      ) {
        gatedOff = true;
        break;
      }
    }
    if (!gatedOff) {
      problems.push('the sheet is mounted at the top level while a result surface can be up: two instances, one of them a sibling Modal');
    }
  }
  return problems;
}

/** The status effect (the one that tracks `prevStatus`) must drop a latched sheet flag. */
function appFlagResetProblems(sourceFile) {
  const statusEffect = [...walkAst(sourceFile)].find(
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText() === 'useEffect' &&
      node.getText().includes('prevStatus.current'),
  );
  if (!statusEffect) return ['app.js has no status effect (the one that tracks prevStatus) to reset the sheet flag in'];

  const problems = [];
  // The reset must actually RUN: an unconditional statement of the branch that is not
  // after a `return` (a call parked below `return;` is dead code and the latch would be
  // back, while a substring check would still see it).
  const callsReset = (branchBody) => {
    const statements = ts.isBlock(branchBody) ? [...branchBody.statements] : [branchBody];
    for (const statement of statements) {
      if (ts.isReturnStatement(statement)) return false;
      if (
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        statement.expression.getText() === 'setScanRoomModalVisible(false)'
      ) {
        return true;
      }
    }
    return false;
  };
  const branches = [
    ["status === 'processing'", 'a new analysis starts'],
    ["status === 'idle' || status === 'error' || status === 'non-fashion'", 'the result is dismissed or the scan is reset'],
  ];
  for (const [condition, moment] of branches) {
    const branch = [...walkAst(statusEffect)].find(
      (node) => ts.isIfStatement(node) && normalize(node.expression.getText()) === condition,
    );
    if (!branch) problems.push(`the status effect has no "${condition}" branch to reset the sheet flag in`);
    else if (!callsReset(branch.thenStatement)) {
      problems.push(`scanRoomModalVisible is not reset when ${moment}, so a refused presentation could latch the flag`);
    }
  }
  return problems;
}

const appSource = () => readSource('app.js');
const librarySource = () => readSource('app/library.tsx');

test('iOS sheet nesting: app.js hands the sheet to both result surfaces through overlay and never mounts it beside them', () => {
  const sourceFile = parseSource(appSource(), 'app.js');
  assert.deepEqual(overlayWiringProblems(sourceFile, 2), []);
  assert.deepEqual(siblingProblems(sourceFile), []);
});

test('iOS sheet nesting: app.js mounts exactly one sheet: the overlay while a result surface is up, the top level otherwise', () => {
  assert.deepEqual(appSingleInstanceProblems(parseSource(appSource(), 'app.js')), []);
});

test('iOS sheet nesting: app.js drops a latched sheet flag when a scan starts or the result is dismissed', () => {
  assert.deepEqual(appFlagResetProblems(parseSource(appSource(), 'app.js')), []);
});

test('iOS sheet nesting: the Library mounts the sheet through AnalysisCard overlay, never beside it', () => {
  const sourceFile = parseSource(librarySource(), 'library.tsx');
  assert.equal(jsxElementsNamed(sourceFile, SHEET).length, 1, 'one sheet in the Library');
  assert.deepEqual(overlayWiringProblems(sourceFile, 1), []);
  assert.deepEqual(siblingProblems(sourceFile), []);
});

// ── Negative controls: each mutation of the real source must be reported ─────

// The overlay is the one JSX line consisting only of `{overlay}`; these mutate that
// line, so they hold whatever else the wrapper renders around its children.
const DROP_OVERLAY_LINE = (source) => source.replace(/\n[ \t]*\{overlay\}[ \t]*(?=\r?\n)/, '');
const OVERLAY_FIRST = (source) =>
  source.replace(
    /(<Modal[^>]*>\s*)([\s\S]*?)(\s*)\{overlay\}(\s*<\/Modal>)/,
    '$1{overlay}$3$2$4',
  );

/** Replace `from` with `to` in a source text, refusing a control that would change nothing. */
function mutated(source, from, to) {
  const next = source.replace(from, to);
  assert.notEqual(next, source, `mutation ${String(from)} matched nothing: the negative control is vacuous`);
  return next;
}

test('NEGATIVE CONTROL: a Modal wrapper that drops the overlay is reported (ScanResultV2 and AnalysisCard)', () => {
  const v2Probe = {};
  const cardProbe = {};
  const v2 = renderScanResultV2({ mutateWrapper: DROP_OVERLAY_LINE, probe: v2Probe });
  const card = renderAnalysisCard({ mutateWrapper: DROP_OVERLAY_LINE, probe: cardProbe });
  assert.equal(v2Probe.wrapperLoaded, true, 'ScanResultV2 never used the mutated wrapper');
  assert.equal(cardProbe.wrapperLoaded, true, 'AnalysisCard never used the mutated wrapper');
  assert.deepEqual(overlayPlacementProblems(v2), ['the overlay is not rendered inside the result Modal']);
  assert.deepEqual(overlayPlacementProblems(card), ['the overlay is not rendered inside the result Modal']);
});

test('NEGATIVE CONTROL: a Modal wrapper that renders the overlay FIRST is reported', () => {
  const probe = {};
  const problems = overlayPlacementProblems(renderScanResultV2({ mutateWrapper: OVERLAY_FIRST, probe }));
  assert.equal(probe.wrapperLoaded, true, 'ScanResultV2 never used the mutated wrapper');
  assert.deepEqual(problems, ['the overlay is not the LAST child of the Modal']);
});

test('NEGATIVE CONTROL: a surface that stops forwarding overlay to its Modal is reported', () => {
  const v2 = renderScanResultV2({ mutateV2: (source) => source.replace('overlay={overlay}', '') });
  const card = renderAnalysisCard({ mutateCard: (source) => source.replace('overlay={overlay}', '') });
  assert.deepEqual(overlayPlacementProblems(v2), ['the overlay is not rendered inside the result Modal']);
  assert.deepEqual(overlayPlacementProblems(card), ['the overlay is not rendered inside the result Modal']);
});

test('the placement check itself tells inside, outside and misordered overlays apart', () => {
  const node = (type, props = {}, children = []) => ({ type, props, children });
  const sentinel = () => node('View', { testID: OVERLAY_ID });
  const inside = node('Root', {}, [node('Modal', {}, [node('View'), sentinel()])]);
  const outside = node('Root', {}, [node('Modal', {}, [node('View')]), sentinel()]);
  const first = node('Root', {}, [node('Modal', {}, [sentinel(), node('View')])]);
  const twoModals = node('Root', {}, [node('Modal'), node('Modal')]);
  assert.deepEqual(overlayPlacementProblems(inside), []);
  assert.deepEqual(overlayPlacementProblems(outside), [
    'the overlay is not rendered inside the result Modal',
    'the overlay is also rendered outside the result Modal',
  ]);
  assert.deepEqual(overlayPlacementProblems(first), ['the overlay is not the LAST child of the Modal']);
  assert.deepEqual(overlayPlacementProblems(twoModals), ['expected exactly one Modal, found 2']);
});

const FALLBACK_MOUNT = '{resultSurfaceVisible ? null : addScanToRoomModal}';

test('NEGATIVE CONTROL: re-introducing the sibling in app.js is reported, exactly once', () => {
  const sourceFile = parseSource(
    mutated(
      appSource(),
      FALLBACK_MOUNT,
      '<AddScanToDressingRoomModal visible={scanRoomModalVisible} onClose={() => setScanRoomModalVisible(false)} />',
    ),
    'app.js',
  );
  const problems = siblingProblems(sourceFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /JSX sibling of <ScanResultV2>, <AnalysisCard>/);
});

test('NEGATIVE CONTROL: dropping overlay from both surfaces in app.js is reported', () => {
  const sourceFile = parseSource(mutated(appSource(), /overlay=\{addScanToRoomModal\}/g, ''), 'app.js');
  const problems = overlayWiringProblems(sourceFile, 2);
  assert.equal(problems.filter((problem) => /receives no overlay/.test(problem)).length, 2);
});

test('NEGATIVE CONTROL: an overlay that does not resolve to the sheet is reported', () => {
  const sourceFile = parseSource(
    mutated(appSource(), /overlay=\{addScanToRoomModal\}/g, 'overlay={null}'),
    'app.js',
  );
  const problems = overlayWiringProblems(sourceFile, 2);
  assert.equal(problems.filter((problem) => /does not render <AddScanToDressingRoomModal>/.test(problem)).length, 2);
});

test('NEGATIVE CONTROL: removing the single-instance gate is reported', () => {
  const sourceFile = parseSource(mutated(appSource(), FALLBACK_MOUNT, '{addScanToRoomModal}'), 'app.js');
  const problems = appSingleInstanceProblems(sourceFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /two instances/);
});

test('NEGATIVE CONTROL: never mounting the fallback sheet is reported', () => {
  const sourceFile = parseSource(mutated(appSource(), FALLBACK_MOUNT, ''), 'app.js');
  const problems = appSingleInstanceProblems(sourceFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never mounted/);
});

test('NEGATIVE CONTROL: a result surface that is not gated by resultSurfaceVisible is reported', () => {
  const sourceFile = parseSource(
    mutated(appSource(), /\{resultSurfaceVisible &&\s*\(/, '{true && ('),
    'app.js',
  );
  const problems = appSingleInstanceProblems(sourceFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not gated by resultSurfaceVisible/);
});

test('NEGATIVE CONTROL: not resetting the sheet flag is reported for both moments', () => {
  // Remove only the two resets in the status effect (the first two after prevStatus is
  // recorded); the close handler that also calls setScanRoomModalVisible(false) stays valid.
  const sourceFile = parseSource(
    mutated(
      appSource(),
      /(prevStatus\.current = status;[\s\S]*?)setScanRoomModalVisible\(false\);([\s\S]*?)setScanRoomModalVisible\(false\);/,
      '$1$2',
    ),
    'app.js',
  );
  const problems = appFlagResetProblems(sourceFile);
  assert.equal(problems.filter((problem) => /latch/.test(problem)).length, 2);
});

test('NEGATIVE CONTROL: a reset parked below the return of its branch (dead code) is reported', () => {
  const sourceFile = parseSource(
    mutated(
      appSource(),
      /setScanRoomModalVisible\(false\);(\s*)return;/,
      'return;$1setScanRoomModalVisible(false);',
    ),
    'app.js',
  );
  const problems = appFlagResetProblems(sourceFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a new analysis starts/);
});

test('NEGATIVE CONTROL: resetting the flag for only one of the two moments is reported', () => {
  const sourceFile = parseSource(
    mutated(
      appSource(),
      /(prevStatus\.current = status;[\s\S]*?)setScanRoomModalVisible\(false\);/,
      '$1',
    ),
    'app.js',
  );
  const problems = appFlagResetProblems(sourceFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a new analysis starts/);
});

test('NEGATIVE CONTROL: re-introducing the sibling in the Library is reported, exactly once', () => {
  const sourceFile = parseSource(
    mutated(
      librarySource(),
      '</LuxuryScreen>',
      '<AddScanToDressingRoomModal visible={false} onClose={() => {}} />\n    </LuxuryScreen>',
    ),
    'library.tsx',
  );
  const problems = siblingProblems(sourceFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /JSX sibling of <AnalysisCard>/);
});

test('NEGATIVE CONTROL: dropping overlay from the Library AnalysisCard is reported', () => {
  const text = librarySource();
  const [element] = jsxElementsNamed(parseSource(text, 'library.tsx'), 'AnalysisCard');
  const attribute = element && jsxAttribute(element, 'overlay');
  assert.ok(attribute, 'the Library AnalysisCard has no overlay attribute to remove: the negative control is vacuous');
  // Cut the attribute out by position, so this holds however the props are laid out.
  const withoutOverlay = text.slice(0, attribute.getStart()) + text.slice(attribute.getEnd());
  const problems = overlayWiringProblems(parseSource(withoutOverlay, 'library.tsx'), 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /<AnalysisCard> receives no overlay/);
});
