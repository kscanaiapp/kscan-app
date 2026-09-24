'use strict';

/**
 * WP-SCAN-04-IOS, part two: the Scan Results "Report Response" control must be
 * REACHABLE on the surface production actually renders, and must file a report the
 * server can resolve.
 *
 * WHAT WAS WRONG. eas.json sets EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true in every
 * governed profile, so app.js renders ScanResultV2 for a live scan and AnalysisCard
 * is only reached from a reopened Recent Scan. The report control lived on
 * AnalysisCard alone, so the live result had NO way to report model-authored
 * prose, and aiOutputReportingReachability.test.js stayed green because it greps
 * AnalysisCard. On top of that app.js passed only `photo?.qaFixtureName ?? null`
 * as the scan identity, which is null for every real scan, and
 * submitAiOutputReport refuses a request with no target ("This AI response cannot
 * be reported yet"), so even a control would have ended in REPORT NOT SENT.
 *
 * WHAT THIS FILE BINDS, link by link, none of it by substring where a question is
 * structural:
 *
 *   production eas.json flag  -> the real featureFlags resolver
 *     -> the branch app.js renders (AST)
 *       -> the identity that branch passes (AST): the persisted Recent Scan id
 *         -> ScanResultV2 forwarding it to the analysis section (AST)
 *           -> the control, EXECUTED, present only with an id and analysis prose
 *             -> the real AiOutputReportProvider sheet, EXECUTED
 *               -> the real reporting service, EXECUTED against a stub client
 *                 -> a content_reports row keyed by that id
 *
 * The persisted id is app.js `savedScanId` (services/library.js saveScan: a
 * `scan_<time>_<random>` id written to the Recent Scans manifest, reused by the
 * Library reopen as `selectedScan.id`). On the multi-item confirmation step the
 * single-item save is skipped and the persisted id is `savedMultiItemScanId`, so
 * that step's prose is reportable too.
 *
 * It also pins the sheet polish that belongs to this defect: a width cap so the
 * sheet does not span an iPad, and an explicit VoiceOver announcement, because
 * accessibilityLiveRegion is Android-only in React Native.
 *
 * Executed with __tests__/helpers/componentRenderer.js. Every negative control
 * mutates the real source and must be reported; the loader refuses a mutation
 * that changes nothing.
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
  findAll,
  jsxAttribute,
  jsxElementsNamed,
  jsxTagNameOf,
  parseSource,
  readSource,
  runModule,
  settle,
  walkAst,
} = require('./helpers/componentRenderer');
const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles');
const responsiveLayout = require('../services/responsiveLayout');

const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 };
const REPORT_CONTROL = 'scan-result-v2-report-ai';

function theme() {
  return {
    COLORS: deepStub(),
    LUXURY: deepStub(),
    RADIUS: deepStub(),
    SHADOWS: deepStub(),
    SPACING,
  };
}

function mutated(source, from, to) {
  const next = source.replace(from, to);
  assert.notEqual(next, source, `mutation ${String(from)} matched nothing: the negative control is vacuous`);
  return next;
}

// ── Links 1-4: the flag, the branch, the identity, the forwarding ───────────

test('link 1: every governed EAS profile enables Scan Results V2, and the real flag module resolves it on', () => {
  const profiles = Object.entries(resolveEasBuildProfiles(JSON.parse(readSource('eas.json'))));
  assert.ok(profiles.length > 0, 'eas.json must define build profiles');
  for (const [name, profile] of profiles) {
    assert.equal(
      profile.env?.EXPO_PUBLIC_SCAN_RESULTS_V2_UI,
      'true',
      `${name} must ship the V2 result surface, or this file is validating the wrong component`,
    );
  }

  // Through the real module with the real production value, not a restated comparison.
  const previous = process.env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI;
  process.env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI = profiles[0][1].env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI;
  try {
    const flags = runModule('constants/featureFlags.ts', {}, { jsx: false });
    assert.equal(flags.SCAN_RESULTS_V2_UI_ENABLED, true);
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI;
    else process.env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI = previous;
  }
});

function firstJsxTag(node) {
  for (const inner of walkAst(node)) {
    const tag = jsxTagNameOf(inner);
    if (tag) return tag;
  }
  return null;
}

test('link 2: app.js renders ScanResultV2 when the flag is on and AnalysisCard only when it is off', () => {
  const sourceFile = parseSource(readSource('app.js'), 'app.js');
  const choice = [...walkAst(sourceFile)].find(
    (node) => ts.isConditionalExpression(node) && node.condition.getText() === 'SCAN_RESULTS_V2_UI_ENABLED',
  );
  assert.ok(choice, 'app.js must branch the result surface on SCAN_RESULTS_V2_UI_ENABLED');
  assert.equal(firstJsxTag(choice.whenTrue), 'ScanResultV2');
  assert.equal(firstJsxTag(choice.whenFalse), 'AnalysisCard');
});

/** The `??` chain as its operand texts, in order. */
function coalesceOperands(expression) {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [...coalesceOperands(expression.left), ...coalesceOperands(expression.right)];
  }
  return [expression.getText()];
}

function identityOperands(sourceFile, tagName) {
  const [element] = jsxElementsNamed(sourceFile, tagName);
  const attribute = element && jsxAttribute(element, 'scanSourceId');
  const expression = attribute?.initializer && ts.isJsxExpression(attribute.initializer)
    ? attribute.initializer.expression
    : null;
  return expression ? coalesceOperands(expression) : null;
}

/** What a scan's report target may be: its persisted id first, the QA fixture name last, null when neither exists. */
function identityProblems(sourceFile) {
  const problems = [];
  for (const tag of ['ScanResultV2', 'AnalysisCard']) {
    const operands = identityOperands(sourceFile, tag);
    if (!operands) {
      problems.push(`<${tag}> receives no scanSourceId`);
      continue;
    }
    const persisted = operands.indexOf('savedScanId');
    const fixture = operands.indexOf('photo?.qaFixtureName');
    if (persisted !== 0) problems.push(`<${tag}> scanSourceId does not lead with the persisted scan id (savedScanId): ${operands.join(' ?? ')}`);
    if (fixture === -1 || (persisted !== -1 && fixture < persisted)) {
      problems.push(`<${tag}> scanSourceId does not keep the QA fixture name as the last resort: ${operands.join(' ?? ')}`);
    }
    if (operands.at(-1) !== 'null') {
      problems.push(`<${tag}> scanSourceId does not end in null, so an unsaved scan could carry a made-up target`);
    }
  }
  return problems;
}

test('link 3: both surfaces get the persisted scan id as their report identity, not just the QA fixture name', () => {
  assert.deepEqual(identityProblems(parseSource(readSource('app.js'), 'app.js')), []);
});

test('link 3b: the multi-item confirmation step has a persisted identity too', () => {
  // The single-item save is skipped there (app.js), the persisted id is savedMultiItemScanId,
  // and that step renders model prose, so it must not be left with no report target.
  const sourceFile = parseSource(readSource('app.js'), 'app.js');
  for (const tag of ['ScanResultV2', 'AnalysisCard']) {
    assert.ok(
      identityOperands(sourceFile, tag)?.includes('savedMultiItemScanId'),
      `<${tag}> scanSourceId must include savedMultiItemScanId`,
    );
  }
});

function forwardingProblems(sourceFile) {
  const [section] = jsxElementsNamed(sourceFile, 'StyleAnalysisSection');
  if (!section) return ['ScanResultV2 does not render StyleAnalysisSection'];
  const attribute = jsxAttribute(section, 'scanSourceId');
  if (!attribute) return ['ScanResultV2 does not forward scanSourceId to StyleAnalysisSection'];
  const expression = attribute.initializer?.expression?.getText() ?? '';
  return /\bscanSourceId\b/.test(expression)
    ? []
    : [`ScanResultV2 forwards "${expression}" instead of its scanSourceId prop`];
}

test('link 4: ScanResultV2 forwards its scan identity to the analysis section that carries the control', () => {
  assert.deepEqual(
    forwardingProblems(parseSource(readSource('components/scan-results/ScanResultV2.tsx'), 'ScanResultV2.tsx')),
    [],
  );
});

// ── Links 5-6: the control, the real sheet and the real service, executed ───

function loadReportStack({ platformOS = 'ios', mutateContext, insertError = null } = {}) {
  const renderer = createRenderer();
  const announcements = [];
  const actorContext = runModule('services/actorContext.js', {}, { jsx: false });
  const actorScope = runModule('services/actorScope.ts', { './actorContext': actorContext }, { jsx: false });
  actorContext.advanceActorEpoch('actor-a');

  const inserts = [];
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'actor-a' } } }, error: null }) },
    from: (table) => ({
      insert: async (row) => {
        inserts.push({ table, row });
        return { error: insertError };
      },
    }),
  };
  const reportReasons = runModule('constants/reportReasons.ts', {}, { jsx: false });
  const ugcSafetyStore = runModule(
    'services/ugcSafetyStore.ts',
    { '@react-native-async-storage/async-storage': { __esModule: true, default: {} }, './actorScope': actorScope },
    { jsx: false },
  );
  const contentReports = runModule(
    'services/contentReports.ts',
    {
      './supabaseClient': { __esModule: true, supabase },
      '../constants/reportReasons': reportReasons,
      './ugcSafetyStore': ugcSafetyStore,
    },
    { jsx: false },
  );
  const reportAiOutput = runModule(
    'services/reportAiOutput.ts',
    { './contentReports': contentReports, './actorScope': actorScope },
    { jsx: false },
  );
  const context = runModule(
    'contexts/AiOutputReportingContext.tsx',
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub({ platformOS, announcements }),
      '../services/reportAiOutput': reportAiOutput,
      '../services/actorScope': actorScope,
      './AuthSessionContext': { useAuthSession: () => ({}) },
      '../constants/theme': theme(),
      '../services/responsiveLayout': responsiveLayout,
    },
    { mutate: mutateContext },
  );
  return { renderer, context, inserts, announcements, reportAiOutput, contentReports };
}

/** The real analysis section under the real provider, as ScanResultV2 mounts it. */
function mountSection(stack, props = {}, { mutateSection } = {}) {
  const { renderer, context } = stack;
  const { StyleAnalysisSection } = runModule(
    'components/scan-results/StyleAnalysisSection.tsx',
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub(),
      '../../constants/theme': theme(),
      '../../contexts/AiOutputReportingContext': context,
    },
    { mutate: mutateSection },
  );
  const root = renderer.jsx(context.AiOutputReportProvider, {
    children: renderer.jsx(StyleAnalysisSection, {
      analysisText: 'A camel wool coat with a relaxed shoulder.',
      scanSourceId: 'scan_1',
      ...props,
    }),
  });
  let tree = renderer.render(root);
  return {
    get tree() {
      return tree;
    },
    rerender() {
      tree = renderer.render(root);
    },
    async settled() {
      await settle();
      tree = renderer.render(root);
    },
    control: () => byTestId(tree, REPORT_CONTROL)[0],
    press(testID) {
      const [node] = byTestId(tree, testID);
      assert.ok(node, `no ${testID} in the tree`);
      node.props.onPress();
      tree = renderer.render(root);
    },
    sheetModal: () => byType(tree, 'Modal')[0],
  };
}

/**
 * The real provider with nothing but a probe under it, for the sheet's own
 * behaviour (width cap, announcements): those must not depend on the control.
 */
function mountProvider(stack) {
  const { renderer, context } = stack;
  let api;
  function Probe() {
    api = context.useAiOutputReporting();
    return null;
  }
  const root = renderer.jsx(context.AiOutputReportProvider, { children: renderer.jsx(Probe, {}) });
  let tree = renderer.render(root);
  return {
    get tree() {
      return tree;
    },
    rerender() {
      tree = renderer.render(root);
    },
    async settled() {
      await settle();
      tree = renderer.render(root);
    },
    open() {
      api.openAiOutputReport({ feature: 'Scan Results', itemId: 'scan_1' });
      tree = renderer.render(root);
    },
    press(testID) {
      const [node] = byTestId(tree, testID);
      assert.ok(node, `no ${testID} in the tree`);
      node.props.onPress();
      tree = renderer.render(root);
    },
    sheetModal: () => byType(tree, 'Modal')[0],
  };
}

async function fileReport(ui, { reason = 'incorrect_or_misleading', notes = 'the sleeve is wrong' } = {}) {
  if (ui.open) ui.open();
  else ui.press(REPORT_CONTROL);
  ui.press(`ai-output-report-reason-${reason}`);
  if (notes) {
    byTestId(ui.tree, 'ai-output-report-notes')[0].props.onChangeText(notes);
    ui.rerender();
  }
  ui.press('ai-output-report-submit');
  await ui.settled();
}

test('link 5: the Report control is reachable on the V2 analysis section and hidden when there is nothing to report', () => {
  const stack = loadReportStack();
  const control = mountSection(stack).control();
  assert.ok(control, 'a persisted scan with analysis prose must expose the control');
  assert.equal(control.props.accessibilityRole, 'button');
  assert.equal(control.props.accessibilityLabel, 'Report this style analysis as offensive or unsafe');
  assert.ok(control.props.style.minHeight >= 44, 'the control keeps a 44pt-plus touch target');

  assert.equal(
    mountSection(loadReportStack(), { scanSourceId: null }).control(),
    undefined,
    'no persisted id: a report the server cannot resolve is worse than no control',
  );
  assert.equal(mountSection(loadReportStack(), { scanSourceId: undefined }).control(), undefined);
  assert.equal(
    mountSection(loadReportStack(), { analysisText: '   ' }).control(),
    undefined,
    'no analysis prose: nothing to report',
  );
});

test('link 5b: pressing the control opens the report sheet for exactly that scan', () => {
  const ui = mountSection(loadReportStack());
  assert.equal(ui.sheetModal().props.visible, false, 'the sheet is closed until asked');
  ui.press(REPORT_CONTROL);
  assert.equal(ui.sheetModal().props.visible, true);
  assert.equal(byTestId(ui.tree, 'ai-output-report-submit')[0].props.disabled, true, 'a reason is required first');
});

test('link 6: the real sheet and service file a content_reports row keyed by the scan id', async () => {
  const stack = loadReportStack();
  const ui = mountSection(stack);
  await fileReport(ui);

  assert.equal(byTestId(ui.tree, 'ai-output-report-success').length, 1, 'REPORT SENT');
  assert.equal(stack.inserts.length, 1);
  assert.deepEqual(stack.inserts[0], {
    table: 'content_reports',
    row: {
      target_type: 'ai_output',
      target_id: 'scan_1',
      reason_category: 'other',
      notes: 'the sleeve is wrong',
      ai_output_context: {
        feature: 'Scan Results',
        reason_detail: 'incorrect_or_misleading',
        item_id: 'scan_1',
      },
    },
  });
  assert.ok(!('reporter_user_id' in stack.inserts[0].row), 'the reporter is bound by auth.uid(), never sent');
});

test('link 6b: the sheet can be closed and opened again for another report', async () => {
  const ui = mountSection(loadReportStack());
  await fileReport(ui);
  ui.press('ai-output-report-done');
  assert.equal(ui.sheetModal().props.visible, false);

  ui.press(REPORT_CONTROL);
  assert.equal(ui.sheetModal().props.visible, true);
  assert.equal(byTestId(ui.tree, 'ai-output-report-success').length, 0, 'a fresh form, not the last outcome');
  assert.equal(byTestId(ui.tree, 'ai-output-report-submit')[0].props.disabled, true, 'no reason carried over');
});

test('link 6c: a failed submit says so and keeps the reason and note for a retry', async () => {
  const stack = loadReportStack({ insertError: { code: '42501' } });
  const ui = mountSection(stack);
  await fileReport(ui);

  assert.equal(byTestId(ui.tree, 'ai-output-report-error').length, 1, 'REPORT NOT SENT');
  assert.equal(byTestId(ui.tree, 'ai-output-report-success').length, 0);
  ui.press('ai-output-report-retry');
  assert.equal(byTestId(ui.tree, 'ai-output-report-notes')[0].props.value, 'the sleeve is wrong');
  assert.equal(byTestId(ui.tree, 'ai-output-report-submit')[0].props.disabled, false, 'the reason is still selected');
});

test('link 6d: an unsaved scan has no target, and the service refuses it rather than filing a blank report', async () => {
  // This is why the control needs the persisted id: the identity app.js used to pass
  // (the QA fixture name) is null for every real scan.
  const stack = loadReportStack();
  const result = await stack.reportAiOutput.submitAiOutputReport({
    request: { feature: 'Scan Results', itemId: null },
    reasonId: 'other',
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /cannot be reported yet/);
  assert.equal(stack.inserts.length, 0);
});

// ── Negative controls for the chain ─────────────────────────────────────────

test('NEGATIVE CONTROL: the pre-repair identity (QA fixture name only) is reported for both surfaces', () => {
  const sourceFile = parseSource(
    mutated(readSource('app.js'), /savedScanId \?\? savedMultiItemScanId \?\? photo\?\.qaFixtureName \?\? null/g, 'photo?.qaFixtureName ?? null'),
    'app.js',
  );
  const problems = identityProblems(sourceFile);
  assert.equal(problems.filter((problem) => /does not lead with the persisted scan id/.test(problem)).length, 2);
});

test('NEGATIVE CONTROL: an identity that can fall through to something other than null is reported', () => {
  const sourceFile = parseSource(
    mutated(readSource('app.js'), /photo\?\.qaFixtureName \?\? null\}/g, "photo?.qaFixtureName ?? 'unknown'}"),
    'app.js',
  );
  assert.equal(identityProblems(sourceFile).filter((problem) => /does not end in null/.test(problem)).length, 2);
});

test('NEGATIVE CONTROL: dropping the multi-item identity is reported', () => {
  const sourceFile = parseSource(
    mutated(readSource('app.js'), /savedScanId \?\? savedMultiItemScanId \?\?/g, 'savedScanId ??'),
    'app.js',
  );
  for (const tag of ['ScanResultV2', 'AnalysisCard']) {
    assert.equal(identityOperands(sourceFile, tag).includes('savedMultiItemScanId'), false);
  }
  assert.deepEqual(identityProblems(sourceFile), [], 'the persisted-id rule alone is still satisfied: link 3b is the guard');
});

test('NEGATIVE CONTROL: a ScanResultV2 that stops forwarding the identity is reported', () => {
  const text = readSource('components/scan-results/ScanResultV2.tsx');
  const sourceFile = parseSource(mutated(text, /\s*scanSourceId=\{scanSourceId \?\? null\}/, ''), 'ScanResultV2.tsx');
  assert.deepEqual(forwardingProblems(sourceFile), ['ScanResultV2 does not forward scanSourceId to StyleAnalysisSection']);
});

test('NEGATIVE CONTROL: an analysis section without the control leaves the live result unreportable', () => {
  const ui = mountSection(loadReportStack(), {}, {
    mutateSection: (source) => source.replace(`testID="${REPORT_CONTROL}"`, 'testID="not-the-report-control"'),
  });
  assert.equal(ui.control(), undefined);
});

// ── Sheet polish: iPad width and the iOS announcement ───────────────────────

/** What the sheet's own style says about its width. */
function sheetStyle(ui) {
  return byTestId(ui.tree, 'ai-output-report-sheet')[0].props.style;
}

test('polish: the report sheet is capped at the shared modal width and centred, so it does not span an iPad', () => {
  const style = sheetStyle(mountProvider(loadReportStack()));
  assert.equal(style.maxWidth, responsiveLayout.MODAL_MAX_WIDTH);
  assert.equal(style.alignSelf, 'center');
  assert.equal(style.width, '100%', 'phones keep the full padded width');
});

test('NEGATIVE CONTROL: a sheet without the width cap is reported', () => {
  const style = sheetStyle(
    mountProvider(
      loadReportStack({ mutateContext: (source) => source.replace(/\n\s*maxWidth: MODAL_MAX_WIDTH,/, '') }),
    ),
  );
  assert.equal(style.maxWidth, undefined, 'the cap is gone, and the assertion above would fail');
  assert.notEqual(style.maxWidth, responsiveLayout.MODAL_MAX_WIDTH);
});

test('polish: on iOS the outcome of a report is announced to VoiceOver', async () => {
  // accessibilityLiveRegion is Android-only (react-native ViewAccessibility.js) and iOS has
  // no native handler, so without an explicit announcement VoiceOver says nothing when the
  // focused Submit button is replaced by the outcome.
  const sent = loadReportStack({ platformOS: 'ios' });
  await fileReport(mountProvider(sent));
  assert.equal(sent.announcements.length, 1);
  assert.match(sent.announcements[0], /^Report sent\b/);

  const failed = loadReportStack({ platformOS: 'ios', insertError: { code: '42501' } });
  await fileReport(mountProvider(failed));
  assert.equal(failed.announcements.length, 1);
  assert.match(failed.announcements[0], /^Report not sent\b/);
});

test('polish: opening the sheet and choosing a reason announces nothing', () => {
  const stack = loadReportStack({ platformOS: 'ios' });
  const ui = mountProvider(stack);
  ui.open();
  ui.press('ai-output-report-reason-other');
  assert.deepEqual(stack.announcements, []);
});

test('polish: Android relies on its live regions and gets no second announcement', async () => {
  const stack = loadReportStack({ platformOS: 'android' });
  const ui = mountProvider(stack);
  await fileReport(ui);
  assert.equal(byTestId(ui.tree, 'ai-output-report-success').length, 1, 'the report itself still succeeds');
  assert.deepEqual(stack.announcements, []);
});

test('NEGATIVE CONTROL: a sheet that does not announce on iOS is reported', async () => {
  const stack = loadReportStack({
    platformOS: 'ios',
    mutateContext: (source) =>
      source.replace(/AccessibilityInfo\.announceForAccessibility\(/g, '((message) => message)('),
  });
  const ui = mountProvider(stack);
  await fileReport(ui);
  assert.equal(byTestId(ui.tree, 'ai-output-report-success').length, 1, 'the report itself still succeeds');
  assert.deepEqual(stack.announcements, [], 'and the assertion in the iOS test above would fail');
});

test('NEGATIVE CONTROL: an announcement that is not limited to iOS is reported on Android', async () => {
  const stack = loadReportStack({
    platformOS: 'android',
    mutateContext: (source) => source.replace("Platform.OS !== 'ios' || ", ''),
  });
  await fileReport(mountProvider(stack));
  assert.equal(stack.announcements.length, 1, 'Android would announce twice: once by the live region, once explicitly');
});
