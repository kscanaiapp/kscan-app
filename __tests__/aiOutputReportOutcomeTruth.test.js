'use strict';

/**
 * The AI-output report sheet may say "REPORT SENT ... received for review" only when
 * the server accepted the report.
 *
 * WHAT WAS WRONG. contexts/AiOutputReportingContext.tsx decided the outcome with
 * `attempt.value.ok`. submitContentReport deliberately returns THREE shapes:
 *
 *     { ok: true,  serverAccepted: true,  duplicate }   the row is on file
 *     { ok: true,  serverAccepted: false, localOnly }   no authenticated session:
 *                                                        NOTHING reached the server
 *     { ok: false, serverAccepted: false, error }       it failed
 *
 * `ok` is true for the second one too, so a customer with no session was told their
 * report had been received for review when nothing was submitted. The single decision
 * point for that question is isReportServerAccepted (services/contentReports.ts), which
 * Dressing Room "Report user" already uses (dressingRoomReportUserFeedback.test.js).
 *
 * The real provider, the real reporting service and the real contentReports module run
 * here against a stub Supabase client whose session and insert result are the variables.
 * The actor authority (services/actorContext.js, services/actorScope.ts) is real too, so
 * an account switch is a genuine epoch change.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  byTestId,
  byType,
  createReactNativeStub,
  createRenderer,
  deepStub,
  deferred,
  runModule,
  settle,
} = require('./helpers/componentRenderer');
const responsiveLayout = require('../services/responsiveLayout');

const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 };

const theme = () => ({
  COLORS: deepStub(),
  LUXURY: deepStub(),
  RADIUS: deepStub(),
  SHADOWS: deepStub(),
  SPACING,
});

function mutated(source, from, to) {
  const next = source.replace(from, to);
  assert.notEqual(next, source, `mutation ${String(from)} matched nothing: the negative control is vacuous`);
  return next;
}

/**
 * `session`: the Supabase session the client reports (null = signed out, the local-only path).
 * `insertError`: what the content_reports insert answers (null = accepted).
 */
function loadStack({
  session = { user: { id: 'actor-a' } },
  insertError = null,
  sessionLookupThrows = false,
  insertGate = null,
  mutateContext,
} = {}) {
  const renderer = createRenderer();
  const announcements = [];
  const actorContext = runModule('services/actorContext.js', {}, { jsx: false });
  const actorScope = runModule('services/actorScope.ts', { './actorContext': actorContext }, { jsx: false });
  actorContext.advanceActorEpoch('actor-a');

  const inserts = [];
  const supabase = {
    auth: {
      getSession: async () => {
        if (sessionLookupThrows) throw new Error('session storage unavailable');
        return { data: { session }, error: session ? null : new Error('No session') };
      },
    },
    from: (table) => ({
      insert: async (row) => {
        inserts.push({ table, row });
        if (insertGate) await insertGate; // holds the insert in flight
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
      'react-native': createReactNativeStub({ platformOS: 'ios', announcements }),
      '../services/reportAiOutput': reportAiOutput,
      '../services/contentReports': contentReports,
      '../services/actorScope': actorScope,
      './AuthSessionContext': { useAuthSession: () => ({}) },
      '../constants/theme': theme(),
      '../services/responsiveLayout': responsiveLayout,
    },
    { mutate: mutateContext },
  );
  return { renderer, context, inserts, announcements, actorContext };
}

/** The real provider with a probe under it; the sheet is driven through its own controls. */
function mount(stack) {
  const { renderer, context } = stack;
  let api;
  function Probe() {
    api = context.useAiOutputReporting();
    return null;
  }
  const root = renderer.jsx(context.AiOutputReportProvider, { children: renderer.jsx(Probe, {}) });
  let tree = renderer.render(root);
  const ui = {
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
    has: (testID) => byTestId(tree, testID).length > 0,
    sheetVisible: () => byType(tree, 'Modal')[0].props.visible,
  };
  return ui;
}

/** Open the sheet, choose a reason and press Submit. */
async function fileReport(ui) {
  ui.open();
  ui.press('ai-output-report-reason-incorrect_or_misleading');
  ui.press('ai-output-report-submit');
  await ui.settled();
}

const RECEIVED = 'Report sent. Your report has been received for review.';

// ── The truth table ─────────────────────────────────────────────────────────

test('server accepted -> REPORT SENT, and exactly one row was filed', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  await fileReport(ui);

  assert.equal(ui.has('ai-output-report-success'), true);
  assert.equal(ui.has('ai-output-report-error'), false);
  assert.equal(stack.inserts.length, 1);
  assert.equal(stack.inserts[0].table, 'content_reports');
  assert.deepEqual(stack.announcements, [RECEIVED]);
});

test('duplicate accepted report (unique violation) -> REPORT SENT: the original is on file', async () => {
  const stack = loadStack({ insertError: { code: '23505', message: 'duplicate key value' } });
  const ui = mount(stack);
  await fileReport(ui);

  assert.equal(stack.inserts.length, 1, 'the insert was attempted and the server answered duplicate');
  assert.equal(ui.has('ai-output-report-success'), true);
  assert.equal(ui.has('ai-output-report-error'), false);
});

test('local-only result (no session, nothing reached the server) -> NOT a receipt', async () => {
  const stack = loadStack({ session: null });
  const ui = mount(stack);
  await fileReport(ui);

  assert.equal(stack.inserts.length, 0, 'nothing was submitted, which is exactly why it must not say so');
  assert.equal(ui.has('ai-output-report-success'), false, 'REPORT SENT / "received for review" must not render');
  assert.equal(ui.has('ai-output-report-error'), true, 'the sheet says the report was NOT sent');
  assert.ok(!stack.announcements.includes(RECEIVED), 'VoiceOver must not announce a receipt either');
  assert.deepEqual(stack.announcements, ["Report not sent. We couldn't send your report."]);
});

test('failed submission (RLS or network error) -> REPORT NOT SENT, with the reason kept for a retry', async () => {
  for (const insertError of [
    { code: '42501', message: 'new row violates row-level security policy' },
    { code: 'PGRST301', message: 'JWT expired' },
    { message: 'Network request failed' },
  ]) {
    const stack = loadStack({ insertError });
    const ui = mount(stack);
    await fileReport(ui);

    assert.equal(ui.has('ai-output-report-success'), false, JSON.stringify(insertError));
    assert.equal(ui.has('ai-output-report-error'), true, JSON.stringify(insertError));

    ui.press('ai-output-report-retry');
    assert.equal(ui.has('ai-output-report-submit'), true, 'back on the form');
    assert.equal(byTestId(ui.tree, 'ai-output-report-submit')[0].props.disabled, false, 'the reason is still selected');
  }
});

test('an account switch between opening and submitting files nothing and never claims receipt', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  ui.open();
  ui.press('ai-output-report-reason-incorrect_or_misleading');

  stack.actorContext.advanceActorEpoch('actor-b');
  ui.press('ai-output-report-submit');
  await ui.settled();

  assert.equal(stack.inserts.length, 0, 'the departed actor\'s report must not be filed by the arriving one');
  assert.equal(ui.has('ai-output-report-success'), false);
  assert.equal(ui.sheetVisible(), false, 'the stale sheet is dismissed (existing actor-boundary behaviour)');
});

test('an exception while submitting (the session lookup rejects) -> REPORT NOT SENT', async () => {
  const stack = loadStack({ sessionLookupThrows: true });
  const ui = mount(stack);
  await fileReport(ui);

  assert.equal(stack.inserts.length, 0);
  assert.equal(ui.has('ai-output-report-success'), false);
  assert.equal(ui.has('ai-output-report-error'), true);
  assert.deepEqual(stack.announcements, ["Report not sent. We couldn't send your report."]);
});

test('a second Submit while the first is in flight files nothing more and claims nothing until the server answers', async () => {
  const gate = deferred();
  const stack = loadStack({ insertGate: gate.promise });
  const ui = mount(stack);
  ui.open();
  ui.press('ai-output-report-reason-incorrect_or_misleading');
  ui.press('ai-output-report-submit');
  await settle();
  ui.rerender();

  ui.press('ai-output-report-submit'); // an impatient second tap
  await settle();
  ui.rerender();
  assert.equal(stack.inserts.length, 1, 'one report, however many taps');
  assert.equal(ui.has('ai-output-report-success'), false, 'nothing is claimed while the insert is in flight');
  assert.equal(ui.has('ai-output-report-error'), false);

  gate.resolve();
  await ui.settled();
  assert.equal(ui.has('ai-output-report-success'), true, 'the server answered: now, and only now, it is received');
  assert.equal(stack.inserts.length, 1);
});

// ── Negative controls ───────────────────────────────────────────────────────

test('NEGATIVE CONTROL: deciding the outcome from `ok` again turns a local-only result into REPORT SENT', async () => {
  const stack = loadStack({
    session: null,
    mutateContext: (source) =>
      mutated(source, /isReportServerAccepted\(attempt\.value\)/, 'attempt.value.ok'),
  });
  const ui = mount(stack);
  await fileReport(ui);

  assert.equal(stack.inserts.length, 0);
  assert.equal(
    ui.has('ai-output-report-success'),
    true,
    'the regression being guarded against: with `ok` alone the sheet claims a receipt for a report that was never sent',
  );
  assert.ok(stack.announcements.includes(RECEIVED));
});

test('NEGATIVE CONTROL: a catch block that reports success turns a thrown submission into REPORT SENT', async () => {
  const stack = loadStack({
    sessionLookupThrows: true,
    mutateContext: (source) => mutated(source, /\} catch \{\s*setState\('error'\);/, "} catch {\n      setState('success');"),
  });
  const ui = mount(stack);
  await fileReport(ui);
  assert.equal(ui.has('ai-output-report-success'), true, 'the regression being guarded against');
});

test('NEGATIVE CONTROL: claiming success when the submission gate refuses a second tap paints a receipt while nothing has been answered', async () => {
  const gate = deferred();
  const stack = loadStack({
    insertGate: gate.promise,
    mutateContext: (source) =>
      mutated(source, /if \(!attempt\.started\) return;/, "if (!attempt.started) { setState('success'); return; }"),
  });
  const ui = mount(stack);
  ui.open();
  ui.press('ai-output-report-reason-incorrect_or_misleading');
  ui.press('ai-output-report-submit');
  await settle();
  ui.rerender();
  ui.press('ai-output-report-submit');
  await settle();
  ui.rerender();
  assert.equal(ui.has('ai-output-report-success'), true, 'the regression being guarded against');
  gate.resolve();
  await settle();
});

test('NEGATIVE CONTROL: deciding from `ok` still passes the genuine cases, so only the local-only test can tell the difference', async () => {
  const stack = loadStack({
    mutateContext: (source) =>
      mutated(source, /isReportServerAccepted\(attempt\.value\)/, 'attempt.value.ok'),
  });
  const ui = mount(stack);
  await fileReport(ui);
  assert.equal(ui.has('ai-output-report-success'), true);
});

test('the sheet takes the decision from the shared helper, not from a restated rule', () => {
  const { readSource } = require('./helpers/componentRenderer');
  const source = readSource('contexts/AiOutputReportingContext.tsx');
  assert.match(source, /import \{ isReportServerAccepted \} from '\.\.\/services\/contentReports';/);
  assert.match(source, /setState\(isReportServerAccepted\(attempt\.value\) \? 'success' : 'error'\);/);
  assert.doesNotMatch(source, /attempt\.value\.ok\b/, 'no second copy of the acceptance rule');
});
