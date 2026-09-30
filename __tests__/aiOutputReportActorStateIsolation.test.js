'use strict';

/**
 * SHARED_REPORT_ACTOR_STATE_001 — an AI-output report SUBMISSION must not survive
 * an account switch, in either direction.
 *
 * AiOutputReportProvider is mounted above the navigator, so it outlives a sign-out /
 * account switch. ELISE-001 already binds the REQUEST to an actor generation, refuses a
 * stale binding before the network, re-checks the live session at insert time, and
 * clears the open sheet when the generation changes. What still crossed the boundary
 * was the in-flight submission itself:
 *
 *   A. the submission gate lived as long as the provider, so a request still in flight
 *      for the departed actor kept it locked, the arriving actor's Submit was refused
 *      (`started: false`) and their sheet sat on the spinner;
 *   B. the departed actor's completion ran setState(...) after its await, so its
 *      success, failure, local-only result or exception painted REPORT SENT / REPORT
 *      NOT SENT onto the arriving actor's sheet, and VoiceOver announced it.
 *
 * The real provider, the real reporting service, the real contentReports module and the
 * real actor authority (services/actorContext.js + services/actorScope.ts) run here. The
 * stub Supabase client can HOLD a submission at its session lookup or at its insert, so
 * an account switch can land inside the await. The old request is never cancelled: it
 * finishes on its own, and only its authority over the UI is revoked.
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

const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '22222222-2222-4222-8222-222222222222';
const RECEIVED = 'Report sent. Your report has been received for review.';
const NOT_SENT = "Report not sent. We couldn't send your report.";
const REASON = 'ai-output-report-reason-incorrect_or_misleading';
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy' };
const PLATFORMS = ['ios', 'android'];

function mutated(source, from, to) {
  const next = source.replace(from, to);
  assert.notEqual(next, source, `mutation ${String(from)} matched nothing: the negative control is vacuous`);
  return next;
}

/**
 * The real module stack against a stub Supabase whose live session follows the actor.
 * `holdInsert()` / `holdSession()` script the NEXT submission to reach that point and
 * wait there until the test answers it; unscripted submissions are answered at once.
 */
function loadStack({ platformOS = 'ios', mutateContext, mutateService } = {}) {
  const renderer = createRenderer();
  const announcements = [];
  const actorContext = runModule('services/actorContext.js', {}, { jsx: false });
  const actorScope = runModule('services/actorScope.ts', { './actorContext': actorContext }, { jsx: false });

  let liveUserId = null;
  const sessionScripts = [];
  const insertScripts = [];
  const inserts = [];
  const supabase = {
    auth: {
      getSession: async () => {
        const script = sessionScripts.shift();
        if (script) {
          await script.gate;
          if (script.outcome === 'throw') throw new Error('session storage unavailable');
          if (script.outcome === 'none') return { data: { session: null }, error: new Error('No session') };
        }
        // 'live' (and unscripted): whoever holds the session NOW.
        return {
          data: { session: liveUserId ? { user: { id: liveUserId } } : null },
          error: liveUserId ? null : new Error('No session'),
        };
      },
    },
    from: (table) => ({
      insert: async (row) => {
        inserts.push({ table, row });
        const script = insertScripts.shift();
        if (script) {
          await script.gate;
          return { error: script.error };
        }
        return { error: null };
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
    { jsx: false, mutate: mutateService },
  );
  const context = runModule(
    'contexts/AiOutputReportingContext.tsx',
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub({ platformOS, announcements }),
      '../services/reportAiOutput': reportAiOutput,
      '../services/contentReports': contentReports,
      '../services/actorScope': actorScope,
      './AuthSessionContext': { useAuthSession: () => ({}) },
      '../constants/theme': theme(),
      '../services/responsiveLayout': responsiveLayout,
    },
    { mutate: mutateContext },
  );

  const stack = {
    renderer,
    context,
    inserts,
    announcements,
    /**
     * An auth transition exactly as AuthSessionContext performs it: the actor epoch
     * advances FIRST (resetActorScopedRuntimeState), then the session changes. The
     * provider has not re-rendered yet; `ui.rerender()` is that render.
     */
    authTransition(userId) {
      actorContext.advanceActorEpoch(userId);
      liveUserId = userId;
    },
    /** Signed out of Supabase while the actor authority is unchanged (the local-only path). */
    dropSupabaseSession() {
      liveUserId = null;
    },
    holdInsert() {
      const gate = deferred();
      const script = { gate: gate.promise, error: null };
      insertScripts.push(script);
      return {
        answer(error = null) {
          script.error = error;
          gate.resolve();
        },
      };
    },
    holdSession() {
      const gate = deferred();
      const script = { gate: gate.promise, outcome: 'live' };
      sessionScripts.push(script);
      return {
        answer(outcome) {
          script.outcome = outcome;
          gate.resolve();
        },
      };
    },
  };
  stack.authTransition(ACTOR_A);
  return stack;
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
  const has = (testID) => byTestId(tree, testID).length > 0;
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
    open(itemId = 'scan_1') {
      api.openAiOutputReport({ feature: 'Scan Results', itemId });
      tree = renderer.render(root);
    },
    press(testID) {
      const [node] = byTestId(tree, testID);
      assert.ok(node, `no ${testID} in the tree`);
      node.props.onPress();
      tree = renderer.render(root);
    },
    has,
    sheetVisible: () => byType(tree, 'Modal')[0].props.visible,
    /** What the sheet shows: 'success' | 'error' | 'submitting' | 'form'. */
    outcome() {
      if (has('ai-output-report-success')) return 'success';
      if (has('ai-output-report-error')) return 'error';
      const [submitButton] = byTestId(tree, 'ai-output-report-submit');
      assert.ok(submitButton, 'the sheet renders one of its three panels');
      return submitButton.props.accessibilityState.busy ? 'submitting' : 'form';
    },
    submitDisabled: () => byTestId(tree, 'ai-output-report-submit')[0].props.disabled,
  };
  return ui;
}

/** Open the sheet, choose a reason and press Submit (the promise it starts may be held). */
async function startReport(ui, itemId) {
  ui.open(itemId);
  ui.press(REASON);
  ui.press('ai-output-report-submit');
  await ui.settled();
}

/** The auth transition, then the provider render that observes it. */
function switchActor(stack, ui, userId) {
  stack.authTransition(userId);
  ui.rerender();
}

// ── T1 / T2: the same actor still gets its own outcome after a real await ──────

for (const platformOS of PLATFORMS) {
  test(`[${platformOS}] T1 same actor: a held submission the server accepts shows REPORT SENT`, async () => {
    const stack = loadStack({ platformOS });
    const ui = mount(stack);
    const insert = stack.holdInsert();
    await startReport(ui);
    assert.equal(ui.outcome(), 'submitting', 'nothing is claimed while the insert is in flight');

    ui.rerender(); // an unrelated render is not an actor boundary
    insert.answer(null);
    await ui.settled();

    assert.equal(ui.outcome(), 'success');
    assert.equal(stack.inserts.length, 1);
    assert.deepEqual(stack.announcements, platformOS === 'ios' ? [RECEIVED] : []);
  });

  test(`[${platformOS}] T2 same actor: a held submission the server rejects shows REPORT NOT SENT, retryable`, async () => {
    const stack = loadStack({ platformOS });
    const ui = mount(stack);
    const insert = stack.holdInsert();
    await startReport(ui);

    insert.answer(RLS_DENIED);
    await ui.settled();

    assert.equal(ui.outcome(), 'error');
    assert.deepEqual(stack.announcements, platformOS === 'ios' ? [NOT_SENT] : []);
    ui.press('ai-output-report-retry');
    assert.equal(ui.outcome(), 'form');
    assert.equal(ui.submitDisabled(), false, 'the reason survived for the retry');
  });
}

test('T2 same actor: an exception thrown after a held session lookup shows REPORT NOT SENT', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  const lookup = stack.holdSession();
  await startReport(ui);

  lookup.answer('throw');
  await ui.settled();

  assert.equal(stack.inserts.length, 0);
  assert.equal(ui.outcome(), 'error');
  assert.deepEqual(stack.announcements, [NOT_SENT]);
});

// ── T3 / T4 / T9: a departed actor's completion paints nothing ─────────────────

for (const platformOS of PLATFORMS) {
  test(`[${platformOS}] T3 A -> B: A's late server acceptance paints no REPORT SENT onto B's sheet`, async () => {
    const stack = loadStack({ platformOS });
    const ui = mount(stack);
    const insertA = stack.holdInsert();
    await startReport(ui, 'scan_a');
    assert.equal(stack.inserts.length, 1, "A's row is on its way to the server");

    switchActor(stack, ui, ACTOR_B);
    assert.equal(ui.sheetVisible(), false, "A's sheet is discarded at the boundary (ELISE-001)");

    ui.open('scan_b');
    ui.press(REASON);
    insertA.answer(null); // { ok: true, serverAccepted: true } for A
    await ui.settled();

    assert.equal(ui.sheetVisible(), true, "B's own sheet is still open");
    assert.equal(ui.outcome(), 'form', "B has submitted nothing, so B is shown no outcome");
    assert.equal(ui.submitDisabled(), false, "B's selection is intact");
    assert.deepEqual(stack.announcements, [], 'no receipt is announced to B');
  });
}

test('T3 A -> B: A resolving after the auth transition but BEFORE the provider re-renders still paints nothing', async () => {
  // The render/effect window: the epoch has advanced (the authority), but React has not
  // yet rendered the provider, so the actor-change effect has not cleared anything.
  const stack = loadStack();
  const ui = mount(stack);
  const insertA = stack.holdInsert();
  await startReport(ui);

  stack.authTransition(ACTOR_B);
  insertA.answer(null);
  await settle(); // A's continuation runs here, before the provider observes B
  ui.rerender();

  assert.deepEqual(stack.announcements, [], 'B must not hear "Report sent" for A\'s report');
  assert.equal(ui.sheetVisible(), false);
  assert.equal(ui.has('ai-output-report-success'), false);
});

test('T3 A -> B: A resolving while B has no sheet open leaves nothing waiting for B', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  const insertA = stack.holdInsert();
  await startReport(ui);

  switchActor(stack, ui, ACTOR_B);
  insertA.answer(null);
  await ui.settled();

  assert.equal(ui.has('ai-output-report-success'), false, 'no outcome is parked in the hidden sheet either');
  assert.equal(ui.has('ai-output-report-error'), false);
  ui.open('scan_b');
  assert.equal(ui.outcome(), 'form');
  assert.deepEqual(stack.announcements, []);
});

const STALE_FAILURES = [
  { label: 'insert rejected by RLS', hold: 'insert', answer: RLS_DENIED },
  { label: 'insert network failure', hold: 'insert', answer: { message: 'Network request failed' } },
  { label: 'session lookup throws (the provider catch branch)', hold: 'session', answer: 'throw' },
  { label: 'insert-time actor re-check refuses A (B holds the session)', hold: 'session', answer: 'live' },
];

for (const platformOS of PLATFORMS) {
  for (const failure of STALE_FAILURES) {
    test(`[${platformOS}] T4 A -> B: A's late failure (${failure.label}) paints no REPORT NOT SENT onto B`, async () => {
      const stack = loadStack({ platformOS });
      const ui = mount(stack);
      const heldA = failure.hold === 'insert' ? stack.holdInsert() : stack.holdSession();
      await startReport(ui, 'scan_a');

      switchActor(stack, ui, ACTOR_B);
      ui.open('scan_b');
      ui.press(REASON);
      heldA.answer(failure.answer);
      await ui.settled();

      assert.equal(ui.outcome(), 'form', "B's sheet shows B's untouched form, not A's failure");
      assert.equal(ui.has('ai-output-report-retry'), false);
      assert.deepEqual(stack.announcements, []);
      assert.equal(stack.inserts.length, failure.hold === 'insert' ? 1 : 0, 'nothing was filed on B\'s behalf');
    });
  }

  test(`[${platformOS}] T9 A -> B: A's late local-only result paints no outcome at all onto B`, async () => {
    const stack = loadStack({ platformOS });
    const ui = mount(stack);
    const lookupA = stack.holdSession();
    await startReport(ui, 'scan_a');

    switchActor(stack, ui, ACTOR_B);
    ui.open('scan_b');
    ui.press(REASON);
    lookupA.answer('none'); // { ok: true, serverAccepted: false, localOnly: true } for A
    await ui.settled();

    assert.equal(stack.inserts.length, 0);
    assert.equal(ui.outcome(), 'form');
    assert.deepEqual(stack.announcements, []);
  });
}

// ── T5: the arriving actor inherits no submission lock ─────────────────────────

for (const platformOS of PLATFORMS) {
  test(`[${platformOS}] T5 A -> B: B submits immediately while A's request is still in flight`, async () => {
    const stack = loadStack({ platformOS });
    const ui = mount(stack);
    const insertA = stack.holdInsert();
    await startReport(ui, 'scan_a');

    switchActor(stack, ui, ACTOR_B);
    await startReport(ui, 'scan_b');

    assert.equal(stack.inserts.length, 2, "B's submission started without waiting for A's");
    assert.deepEqual(
      stack.inserts.map(({ row }) => row.target_id),
      ['scan_a', 'scan_b'],
    );
    assert.equal(ui.outcome(), 'success', "B's own acceptance is B's to see");

    insertA.answer(null); // A's request finishes normally in the background
    await ui.settled();
    assert.equal(ui.outcome(), 'success', 'still B\'s own outcome');
    assert.deepEqual(stack.announcements, platformOS === 'ios' ? [RECEIVED] : [], 'exactly one receipt: B\'s');
  });
}

test('T5 A -> B: A\'s late completion lands while B\'s own submission is in flight and B keeps waiting for B\'s answer', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  const insertA = stack.holdInsert();
  await startReport(ui, 'scan_a');

  switchActor(stack, ui, ACTOR_B);
  const insertB = stack.holdInsert();
  await startReport(ui, 'scan_b');
  assert.equal(ui.outcome(), 'submitting');

  insertA.answer(null);
  await ui.settled();
  assert.equal(ui.outcome(), 'submitting', "A's acceptance is not B's");

  insertB.answer(RLS_DENIED);
  await ui.settled();
  assert.equal(ui.outcome(), 'error', "B's own failure is B's to see");
  assert.deepEqual(stack.announcements, [NOT_SENT]);
});

// ── T6: A -> B -> A is a new generation, not a revival ─────────────────────────

for (const platformOS of PLATFORMS) {
  test(`[${platformOS}] T6 A1 -> B -> A2: A1's late completion does not mutate A2's sheet`, async () => {
    const stack = loadStack({ platformOS });
    const ui = mount(stack);
    const insertA1 = stack.holdInsert();
    await startReport(ui, 'scan_a1');

    switchActor(stack, ui, ACTOR_B);
    switchActor(stack, ui, ACTOR_A); // same actor id, new generation

    const insertA2 = stack.holdInsert();
    await startReport(ui, 'scan_a2');
    assert.equal(stack.inserts.length, 2, 'A2 was not locked out by A1 either');
    assert.equal(ui.outcome(), 'submitting');

    insertA1.answer(RLS_DENIED);
    await ui.settled();
    assert.equal(ui.outcome(), 'submitting', "A1's failure is not A2's, although the actor id matches");

    insertA2.answer(null);
    await ui.settled();
    assert.equal(ui.outcome(), 'success');
    assert.deepEqual(stack.announcements, platformOS === 'ios' ? [RECEIVED] : []);
  });
}

test('T6 A1 -> B -> A2: A1\'s late acceptance paints no REPORT SENT onto A2\'s unsubmitted form', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  const insertA1 = stack.holdInsert();
  await startReport(ui, 'scan_a1');

  switchActor(stack, ui, ACTOR_B);
  switchActor(stack, ui, ACTOR_A);
  ui.open('scan_a2');
  ui.press(REASON);

  insertA1.answer(null);
  await ui.settled();
  assert.equal(ui.outcome(), 'form');
  assert.deepEqual(stack.announcements, []);
});

// ── T7: rapid-submit protection inside ONE generation is unchanged ─────────────

test('T7 same actor: two Submit taps during one generation start one submission', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  const insert = stack.holdInsert();
  ui.open();
  ui.press(REASON);
  const [submitButton] = byTestId(ui.tree, 'ai-output-report-submit');
  submitButton.props.onPress(); // two taps before React applies the disabled state
  submitButton.props.onPress();
  await ui.settled();
  assert.equal(stack.inserts.length, 1, 'one report, however many taps');

  insert.answer(null);
  await ui.settled();
  assert.equal(ui.outcome(), 'success');
  assert.equal(stack.inserts.length, 1);
});

test('T7 after an actor boundary: the arriving actor\'s fresh gate still refuses a double tap', async () => {
  const stack = loadStack();
  const ui = mount(stack);
  const insertA = stack.holdInsert();
  await startReport(ui, 'scan_a');

  switchActor(stack, ui, ACTOR_B);
  const insertB = stack.holdInsert();
  ui.open('scan_b');
  ui.press(REASON);
  const [submitButton] = byTestId(ui.tree, 'ai-output-report-submit');
  submitButton.props.onPress();
  submitButton.props.onPress();
  await ui.settled();
  assert.equal(stack.inserts.length, 2, "A's one row and B's one row: B's second tap started nothing");

  insertB.answer(null);
  insertA.answer(null);
  await ui.settled();
  assert.equal(ui.outcome(), 'success');
  assert.equal(stack.inserts.length, 2);
});

// ── T8: the local-only truth for the CURRENT actor is unchanged ────────────────

for (const platformOS of PLATFORMS) {
  test(`[${platformOS}] T8 same actor: a local-only result still says REPORT NOT SENT`, async () => {
    const stack = loadStack({ platformOS });
    const ui = mount(stack);
    const lookup = stack.holdSession();
    await startReport(ui);

    lookup.answer('none');
    await ui.settled();

    assert.equal(stack.inserts.length, 0);
    assert.equal(ui.outcome(), 'error', 'nothing reached the server, so it is not a receipt');
    assert.deepEqual(stack.announcements, platformOS === 'ios' ? [NOT_SENT] : []);
  });
}

test('T8 same actor: an unheld local-only result (no Supabase session) says REPORT NOT SENT', async () => {
  const stack = loadStack();
  stack.dropSupabaseSession();
  const ui = mount(stack);
  await startReport(ui);
  assert.equal(stack.inserts.length, 0);
  assert.equal(ui.outcome(), 'error');
  assert.deepEqual(stack.announcements, [NOT_SENT]);
});

// ── Negative controls ──────────────────────────────────────────────────────────

const WITHOUT_POST_AWAIT_OWNERSHIP = (source) =>
  mutated(source, /[ \t]*if \(!isBoundAiOutputReportCurrent\(request\)\) return;\n/g, '');

const WITHOUT_GATE_RESET = (source) =>
  mutated(source, /[ \t]*submissionGateRef\.current = createAiOutputReportSubmissionGate\(\);\n/, '');

test('NEGATIVE CONTROL: without the post-await ownership check, A\'s late acceptance paints REPORT SENT onto B', async () => {
  const stack = loadStack({ mutateContext: WITHOUT_POST_AWAIT_OWNERSHIP });
  const ui = mount(stack);
  const insertA = stack.holdInsert();
  await startReport(ui, 'scan_a');

  switchActor(stack, ui, ACTOR_B);
  ui.open('scan_b');
  ui.press(REASON);
  insertA.answer(null);
  await ui.settled();

  assert.equal(ui.outcome(), 'success', 'the regression being guarded against (Failure B)');
  assert.deepEqual(stack.announcements, [RECEIVED]);
});

test('NEGATIVE CONTROL: without the post-await ownership check, A\'s thrown submission paints REPORT NOT SENT onto B', async () => {
  const stack = loadStack({ mutateContext: WITHOUT_POST_AWAIT_OWNERSHIP });
  const ui = mount(stack);
  const lookupA = stack.holdSession();
  await startReport(ui, 'scan_a');

  switchActor(stack, ui, ACTOR_B);
  ui.open('scan_b');
  ui.press(REASON);
  lookupA.answer('throw');
  await ui.settled();

  assert.equal(ui.outcome(), 'error', 'the catch branch needs the same ownership check');
});

test('NEGATIVE CONTROL: without the gate reset, B\'s Submit is refused while A\'s request holds the lock', async () => {
  const stack = loadStack({ mutateContext: WITHOUT_GATE_RESET });
  const ui = mount(stack);
  const insertA = stack.holdInsert();
  await startReport(ui, 'scan_a');

  switchActor(stack, ui, ACTOR_B);
  await startReport(ui, 'scan_b');

  assert.equal(stack.inserts.length, 1, 'the regression being guarded against (Failure A): B never reached the server');
  assert.equal(ui.outcome(), 'submitting', 'and B is left on the spinner');
  insertA.answer(null);
  await ui.settled();
  assert.equal(ui.outcome(), 'submitting', 'A\'s completion is (correctly) not B\'s, so nothing ever releases B');
});

test('NEGATIVE CONTROL: ownership by actor id alone lets A1\'s late failure reach A2', async () => {
  const stack = loadStack({
    mutateService: (source) =>
      mutated(
        source,
        /return Boolean\(bound\) && isActorScopeCurrent\(bound!\.actorScope\);/,
        'return Boolean(bound) && bound!.actorId === currentActorId();',
      ),
  });
  const ui = mount(stack);
  const insertA1 = stack.holdInsert();
  await startReport(ui, 'scan_a1');

  switchActor(stack, ui, ACTOR_B);
  switchActor(stack, ui, ACTOR_A);
  const insertA2 = stack.holdInsert();
  await startReport(ui, 'scan_a2');

  insertA1.answer(RLS_DENIED);
  await ui.settled();
  assert.equal(ui.outcome(), 'error', 'the A -> B -> A regression: a matching id revives generation 1');
  insertA2.answer(null);
  await settle();
});
