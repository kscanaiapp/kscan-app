// Build 5 Phase 2 — deterministic Today orchestration.
//
// The orchestrator's core is pure: reads in, snapshot out, engine verdict out.
// Everything below drives that core directly with fabricated source reads, so
// priority, ownership, staleness and the commit gate are proved without a
// renderer, a filesystem or a device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

/**
 * Require a TypeScript module by transpiling it and its TS dependencies on the
 * fly. The orchestrator imports the Phase 1 engine and eligibility contract by
 * relative path, and those must be the REAL ones — stubbing them would prove
 * nothing about the wiring this suite exists to check.
 */
const originalCompile = Module._extensions['.js'];
if (!Module._extensions['.ts']) {
  Module._extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(out, filename);
  };
}
void originalCompile;

const orchestrator = require(path.join(ROOT, 'services/todayWithElise/orchestrator.ts'));
const presentation = require(path.join(ROOT, 'services/todayWithElise/presentation.ts'));
const reporting = require(path.join(ROOT, 'services/todayWithElise/reporting.ts'));
const actorInvalidation = require(path.join(ROOT, 'services/todayWithElise/actorInvalidation.ts'));

const NOW = Date.parse('2026-07-30T09:00:00Z');
const ACTOR = 'actor-a';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function closetItem(id, category, title) {
  return {
    id,
    title: title ?? id,
    category,
    clothingType: category,
    subtype: null,
    brand: null,
    primaryColor: 'Black',
    secondaryColors: [],
    material: [],
    size: null,
    notes: null,
    origin: null,
    imageUri: `file://${id}.jpg`,
    thumbnailUri: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    displaySummary: null,
    taxonomyUnknown: false,
  };
}

const FULL_CLOSET = [
  closetItem('item-top', 'Tops', 'Silk blouse'),
  closetItem('item-bottom', 'Bottoms', 'Wide-leg trousers'),
  closetItem('item-shoes', 'Shoes', 'Leather loafers'),
];

/** A composer stub returning exactly the ids it is told to. PURE. */
function composerReturning(items) {
  return () => ({ code: 'SUCCESS', looks: items.length ? [{ lookId: 'look-1', items }] : [] });
}

const COLLABORATORS = {
  project: (items) => items,
  classifySlot: (item) => {
    const map = { Tops: 'top', Bottoms: 'bottom', Shoes: 'footwear', Outerwear: 'outerwear' };
    return { primarySlot: map[item.category] ?? null };
  },
  compose: composerReturning([
    { slot: 'top', closetItemId: 'item-top' },
    { slot: 'bottom', closetItemId: 'item-bottom' },
    { slot: 'footwear', closetItemId: 'item-shoes' },
  ]),
};

const CAPABILITIES = {
  todayWithEliseActive: true,
  privateDressingRoomActive: true,
  weatherActive: false,
  generatedGreetingActive: false,
  closetReviewActive: true,
};

function handleFor(actorId = ACTOR, epoch = 1) {
  return { actorId, actorEpoch: epoch, generationToken: `today_${epoch}_1` };
}

function reads(overrides = {}) {
  return {
    closet: { ok: true, items: FULL_CLOSET },
    session: null,
    composition: null,
    savedLooks: { ok: true, looks: [] },
    candidates: { ok: true, candidates: [] },
    ...overrides,
  };
}

function evaluate(input = {}) {
  const built = orchestrator.buildTodaySnapshot({
    handle: input.handle ?? handleFor(),
    reads: input.reads ?? reads(),
    capabilities: { ...CAPABILITIES, ...(input.capabilities ?? {}) },
    collaborators: input.collaborators ?? COLLABORATORS,
    nowMs: input.nowMs ?? NOW,
  });
  return orchestrator.evaluateTodaySnapshot(built);
}

function activeSession(overrides = {}) {
  return {
    ok: true,
    session: {
      sessionId: 'session-1',
      actorId: ACTOR,
      status: 'active',
      anchorClosetItemId: null,
      occasion: null,
      createdAt: new Date(NOW - 60_000).toISOString(),
      updatedAt: new Date(NOW - 60_000).toISOString(),
      ...overrides,
    },
  };
}

function composition(overrides = {}) {
  return {
    ok: true,
    stale: false,
    composition: {
      compositionId: 'composition-1',
      activeLookId: 'look-1',
      inputFingerprint: 'fp-1',
      looks: [
        {
          lookId: 'look-1',
          items: [
            { slot: 'top', closetItemId: 'item-top' },
            { slot: 'bottom', closetItemId: 'item-bottom' },
          ],
        },
      ],
      ...overrides,
    },
  };
}

// ── Priority ─────────────────────────────────────────────────────────────────

test('unfinished Look wins over every other priority', () => {
  const result = evaluate({
    reads: reads({ session: activeSession(), composition: composition() }),
  });
  assert.equal(result.card.stateId, 'unfinished_look');
  assert.equal(result.card.priority, 'unfinished_look');
});

test("today's owned Look wins over recent styling", () => {
  // A session exists but has produced no composition, so there is nothing
  // unfinished — the owned-item Look outranks merely resuming the session.
  const result = evaluate({ reads: reads({ session: activeSession() }) });
  assert.equal(result.card.stateId, 'today_owned_look');
  assert.equal(result.card.priority, 'today_owned_look');
});

test('recent styling wins over a Closet action', () => {
  // No eligible owned Look (nothing composes), but the session is recent.
  const result = evaluate({
    reads: reads({ session: activeSession(), candidates: { ok: true, candidates: [] } }),
    collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
  });
  assert.equal(result.card.stateId, 'recent_styling');
  assert.equal(result.card.priority, 'recent_styling');
});

test('a Closet action wins over onboarding', () => {
  const result = evaluate({
    reads: reads({
      candidates: { ok: true, candidates: [{ status: 'ready_for_review' }] },
    }),
    collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
  });
  assert.equal(result.card.stateId, 'closet_action');
  assert.equal(result.card.source, 'closet_review_queue');
});

test('onboarding appears only for a genuinely empty Closet', () => {
  const result = evaluate({
    reads: reads({ closet: { ok: true, items: [] } }),
    collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
  });
  assert.equal(result.card.stateId, 'onboarding');
  assert.equal(result.card.priority, 'onboarding');
});

test('a non-empty Closet with no usable Look asks for Closet items, not onboarding', () => {
  const result = evaluate({
    reads: reads(),
    collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
  });
  assert.equal(result.card.stateId, 'closet_action');
  assert.equal(result.card.primaryAction.target, 'closet_intake');
});

test('reordered equivalent inputs produce the same card', () => {
  const a = evaluate({ reads: reads({ closet: { ok: true, items: FULL_CLOSET } }) });
  const reordered = [FULL_CLOSET[2], FULL_CLOSET[0], FULL_CLOSET[1]];
  const b = evaluate({
    reads: reads({ closet: { ok: true, items: reordered } }),
    collaborators: {
      ...COLLABORATORS,
      // Same composer verdict; only the Closet array order changed.
      compose: COLLABORATORS.compose,
    },
  });
  assert.equal(a.card.stateId, b.card.stateId);
  assert.deepEqual(
    a.card.itemRefs.map((r) => r.closetItemId).sort(),
    b.card.itemRefs.map((r) => r.closetItemId).sort(),
  );
});

test('repeated evaluation of identical inputs is byte-identical', () => {
  const a = evaluate();
  const b = evaluate();
  assert.deepEqual(a.card, b.card);
});

test('malformed and duplicate session timestamps stay deterministic', () => {
  const malformed = evaluate({
    reads: reads({
      session: activeSession({ createdAt: 'not-a-date', updatedAt: 'also-not-a-date' }),
      composition: composition(),
    }),
  });
  // Unreadable activity is unknown, never "just now", so the session cannot
  // claim the highest priority on a corrupt stamp.
  assert.notEqual(malformed.card.stateId, 'unfinished_look');
  assert.deepEqual(malformed.card, evaluate({
    reads: reads({
      session: activeSession({ createdAt: 'not-a-date', updatedAt: 'also-not-a-date' }),
      composition: composition(),
    }),
  }).card);
});

test('a future session timestamp is not treated as recent', () => {
  const result = evaluate({
    reads: reads({
      session: activeSession({ updatedAt: new Date(NOW + 60_000).toISOString() }),
      composition: composition(),
    }),
    collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
  });
  assert.notEqual(result.card.stateId, 'unfinished_look');
  assert.notEqual(result.card.stateId, 'recent_styling');
});

test('a session older than the recency bound is not resurfaced', () => {
  const old = NOW - orchestrator.TODAY_RECENT_SESSION_MAX_AGE_MS - 1000;
  const result = evaluate({
    reads: reads({
      session: activeSession({ updatedAt: new Date(old).toISOString(), createdAt: new Date(old).toISOString() }),
      composition: composition(),
    }),
    collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
  });
  assert.notEqual(result.card.stateId, 'unfinished_look');
  assert.notEqual(result.card.stateId, 'recent_styling');
});

// ── Ownership and eligibility ────────────────────────────────────────────────

test('an owned complete Look is accepted', () => {
  const result = evaluate();
  assert.equal(result.card.stateId, 'today_owned_look');
  assert.equal(result.card.completeness, 'complete');
  assert.deepEqual(
    result.card.itemRefs.map((ref) => ref.closetItemId),
    ['item-top', 'item-bottom', 'item-shoes'],
  );
});

test('an item the actor-scoped Closet cannot resolve is refused, not assumed owned', () => {
  const result = evaluate({
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([
        { slot: 'top', closetItemId: 'item-top' },
        { slot: 'bottom', closetItemId: 'item-bottom' },
        // Not present in this actor's Closet read.
        { slot: 'footwear', closetItemId: 'item-from-another-actor' },
      ]),
    },
  });
  assert.equal(result.card.stateId, 'partial_look');
  assert.equal(result.card.completeness, 'partial');
  assert.ok(
    !result.card.itemRefs.some((ref) => ref.closetItemId === 'item-from-another-actor'),
    'an unresolvable item must never appear in the Look',
  );
});

test('a complete Look is never fabricated from partial data', () => {
  const result = evaluate({
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([
        { slot: 'top', closetItemId: 'item-top' },
        { slot: 'bottom', closetItemId: 'item-bottom' },
      ]),
    },
  });
  assert.equal(result.card.stateId, 'partial_look');
  assert.equal(result.card.completeness, 'partial');
  assert.deepEqual(presentation.missingSlotsFor(result.ownedLook.outcome), ['footwear']);
});

test('no retailer or commerce item is ever inserted into a missing slot', () => {
  const result = evaluate({
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([{ slot: 'top', closetItemId: 'item-top' }]),
    },
  });
  for (const ref of result.card.itemRefs) {
    assert.ok(
      FULL_CLOSET.some((item) => item.id === ref.closetItemId),
      `${ref.closetItemId} is not an owned Closet item`,
    );
  }
});

test('a deleted reference does not silently downgrade to unknown ownership', () => {
  const built = orchestrator.previewTodayOwnedLook({
    actorId: ACTOR,
    closet: { ok: true, items: FULL_CLOSET },
    projections: FULL_CLOSET,
    context: { anchorClosetItemId: 'item-top', occasion: null },
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([{ slot: 'top', closetItemId: 'gone' }]),
    },
    nowMs: NOW,
  });
  assert.equal(built, null, 'a Look of only unresolvable items is ineligible');
});

// ── Dependency gating ────────────────────────────────────────────────────────

test('with the Dressing Room unavailable, no Dressing Room state is selected', () => {
  const result = evaluate({
    capabilities: { privateDressingRoomActive: false },
    reads: reads({ session: activeSession(), composition: composition() }),
  });
  assert.ok(!['unfinished_look', 'today_owned_look', 'recent_styling', 'partial_look'].includes(result.card.stateId));
  assert.equal(result.card.dressingRoomDependent, false);
});

test('with the Today flag off the card is suppressed, not silently rendered', () => {
  const result = evaluate({ capabilities: { todayWithEliseActive: false } });
  assert.equal(result.card.stateId, 'unavailable');
  assert.equal(result.card.analyticsClass, 'suppressed');
});

// ── Failure handling ─────────────────────────────────────────────────────────

test('a failed Closet read is not an empty Closet', () => {
  const result = evaluate({ reads: reads({ closet: { ok: false, items: [] } }) });
  assert.notEqual(result.card.stateId, 'onboarding');
  assert.equal(result.card.stateId, 'incompatible');
  assert.equal(result.card.primaryAction.action, 'none');
});

test('a missing actor fails closed to unauthorized', () => {
  const result = evaluate({ handle: handleFor(null, 1) });
  assert.equal(result.card.stateId, 'unauthorized');
  assert.equal(result.card.primaryAction.action, 'none');
  assert.equal(result.card.secondaryAction, null);
});

test('a Saved Look for the composition means it is finished, not unfinished', () => {
  const result = evaluate({
    reads: reads({
      session: activeSession(),
      composition: composition(),
      savedLooks: { ok: true, looks: [{ id: 'saved-1', sourceCompositionId: 'composition-1' }] },
    }),
  });
  assert.notEqual(result.card.stateId, 'unfinished_look');
});

test('a stale composition is not offered as an unfinished Look', () => {
  const result = evaluate({
    reads: reads({
      session: activeSession(),
      composition: { ok: true, stale: true, composition: null },
    }),
  });
  assert.notEqual(result.card.stateId, 'unfinished_look');
});

test('an unfinished Look whose garments all left the Closet is refused', () => {
  const result = evaluate({
    reads: reads({
      session: activeSession(),
      composition: composition({
        looks: [{ lookId: 'look-1', items: [{ slot: 'top', closetItemId: 'gone' }] }],
      }),
    }),
  });
  assert.notEqual(result.card.stateId, 'unfinished_look');
});

// ── Commit gate ──────────────────────────────────────────────────────────────

test('a result commits when the live actor still matches', () => {
  const handle = handleFor();
  const result = evaluate({ handle });
  const committed = orchestrator.commitTodayCardResult({
    handle,
    liveActorId: ACTOR,
    liveActorEpoch: 1,
    actorRequestCurrent: true,
    currentGenerationToken: handle.generationToken,
    result,
  });
  assert.ok(committed);
});

test('an actor switch after evaluation refuses the commit', () => {
  const handle = handleFor();
  const result = evaluate({ handle });
  assert.equal(
    orchestrator.commitTodayCardResult({
      handle,
      liveActorId: 'actor-b',
      liveActorEpoch: 2,
      actorRequestCurrent: false,
      currentGenerationToken: handle.generationToken,
      result,
    }),
    null,
  );
});

test('a sign-out / sign-back-in cycle refuses the commit on epoch alone', () => {
  const handle = handleFor(ACTOR, 1);
  const result = evaluate({ handle });
  assert.equal(
    orchestrator.commitTodayCardResult({
      handle,
      liveActorId: ACTOR,
      liveActorEpoch: 3,
      actorRequestCurrent: false,
      currentGenerationToken: handle.generationToken,
      result,
    }),
    null,
  );
});

test('logout during orchestration refuses the commit', () => {
  const handle = handleFor();
  const result = evaluate({ handle });
  assert.equal(
    orchestrator.commitTodayCardResult({
      handle,
      liveActorId: null,
      liveActorEpoch: 2,
      actorRequestCurrent: false,
      currentGenerationToken: handle.generationToken,
      result,
    }),
    null,
  );
});

test('a stale generation cannot overwrite a newer one', () => {
  const handle = handleFor();
  const result = evaluate({ handle });
  assert.equal(
    orchestrator.commitTodayCardResult({
      handle,
      liveActorId: ACTOR,
      liveActorEpoch: 1,
      actorRequestCurrent: true,
      currentGenerationToken: 'today_1_2',
      result,
    }),
    null,
  );
});

test('generation tokens are unique per evaluation', () => {
  actorInvalidation.__resetTodayCardGenerationCounter();
  const first = actorInvalidation.beginTodayCardEvaluation({ actorId: ACTOR, actorEpoch: 1 });
  const second = actorInvalidation.beginTodayCardEvaluation({ actorId: ACTOR, actorEpoch: 1 });
  assert.notEqual(first.generationToken, second.generationToken);
});

// ── Analytics ────────────────────────────────────────────────────────────────

function recordingSink() {
  const events = [];
  return {
    events,
    emit: (event, payload) => events.push({ event, payload }),
  };
}

test('one committed card reports exactly one impression', () => {
  const sink = recordingSink();
  const seen = new Set();
  const emitImpression = ({ generationToken, payload }) => {
    if (seen.has(generationToken)) return false;
    seen.add(generationToken);
    sink.emit('today_with_elise_impression', payload);
    return true;
  };
  const card = evaluate().card;
  reporting.reportTodayCardCommitted({ card, platform: 'ios', emit: sink.emit, emitImpression });
  reporting.reportTodayCardCommitted({ card, platform: 'ios', emit: sink.emit, emitImpression });
  const impressions = sink.events.filter((e) => e.event === 'today_with_elise_impression');
  assert.equal(impressions.length, 1);
});

test('a fallback card reports fallback_rendered and not eligible', () => {
  const sink = recordingSink();
  const card = evaluate({
    capabilities: { privateDressingRoomActive: false },
    reads: reads({ closet: { ok: true, items: [] }, candidates: { ok: true, candidates: [] } }),
    collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
  }).card;
  // An empty Closet is onboarding, so force the true fallback: no priority at all.
  const fallbackCard = { ...card, stateId: 'fallback', analyticsClass: 'fallback', priority: null };
  reporting.reportTodayCardCommitted({
    card: fallbackCard,
    platform: 'ios',
    emit: sink.emit,
    emitImpression: () => true,
  });
  const names = sink.events.map((e) => e.event);
  assert.ok(names.includes('today_with_elise_fallback_rendered'));
  assert.ok(!names.includes('today_with_elise_eligible'));
});

test('a partial Look reports partial_look_shown', () => {
  const sink = recordingSink();
  const card = evaluate({
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([
        { slot: 'top', closetItemId: 'item-top' },
        { slot: 'bottom', closetItemId: 'item-bottom' },
      ]),
    },
  }).card;
  reporting.reportTodayCardCommitted({
    card,
    platform: 'ios',
    emit: sink.emit,
    emitImpression: () => true,
  });
  const names = sink.events.map((e) => e.event);
  assert.ok(names.includes('today_with_elise_partial_look_shown'));
});

test('a suppressed or refusal card reports no eligibility', () => {
  for (const stateId of ['unauthorized', 'unavailable', 'incompatible', 'stale']) {
    const sink = recordingSink();
    reporting.reportTodayCardCommitted({
      card: { ...evaluate().card, stateId, analyticsClass: 'unavailable' },
      platform: 'ios',
      emit: sink.emit,
      emitImpression: () => true,
    });
    const names = sink.events.map((e) => e.event);
    assert.ok(!names.includes('today_with_elise_eligible'), `${stateId} must not report eligible`);
  }
});

test('no prohibited field can reach an event payload', () => {
  const payload = reporting.todayEventPayload(evaluate().card, 'ios', NOW);
  const serialized = JSON.stringify(payload);
  for (const forbidden of [ACTOR, 'item-top', 'file://', 'session-1', 'composition-1', 'Silk blouse']) {
    assert.ok(!serialized.includes(forbidden), `payload leaked ${forbidden}`);
  }
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['analyticsClass', 'completeness', 'daypart', 'platform', 'priority', 'source', 'stateId', 'weatherUsed'],
  );
});

// ── Presentation ─────────────────────────────────────────────────────────────

test('a partial Look offers a Closet action and never a Dressing Room action', () => {
  const raw = evaluate({
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([
        { slot: 'top', closetItemId: 'item-top' },
        { slot: 'bottom', closetItemId: 'item-bottom' },
      ]),
    },
  }).card;
  assert.equal(raw.stateId, 'partial_look');
  const projected = presentation.projectPartialLookActions(raw);
  assert.equal(projected.primaryAction.target, 'closet_intake');
  assert.equal(projected.secondaryAction, null);
  assert.equal(projected.dressingRoomDependent, false);
  assert.notEqual(projected.primaryAction.action, 'tap_to_get_ready');
});

test('the partial projection changes actions only, never the winning state', () => {
  const raw = evaluate({
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([{ slot: 'top', closetItemId: 'item-top' }]),
    },
  }).card;
  const projected = presentation.projectPartialLookActions(raw);
  assert.equal(projected.stateId, raw.stateId);
  assert.equal(projected.priority, raw.priority);
  assert.equal(projected.completeness, raw.completeness);
  assert.deepEqual(projected.itemRefs, raw.itemRefs);
});

test('the projection leaves every non-partial state untouched', () => {
  const complete = evaluate().card;
  assert.equal(presentation.projectPartialLookActions(complete), complete);
});

test('a partial Look states what is missing', () => {
  const result = evaluate({
    collaborators: {
      ...COLLABORATORS,
      compose: composerReturning([
        { slot: 'top', closetItemId: 'item-top' },
        { slot: 'bottom', closetItemId: 'item-bottom' },
      ]),
    },
  });
  const view = presentation.projectTodayCard({
    card: presentation.projectPartialLookActions(result.card),
    projections: FULL_CLOSET,
    missingSlots: presentation.missingSlotsFor(result.ownedLook.outcome),
    nowMs: NOW,
  });
  assert.deepEqual(view.missingSlotLabels, ['Shoes']);
  assert.match(view.explanation, /Add shoes to complete this Look\./);
  assert.equal(view.primaryLabel, 'Add More Items');
  assert.equal(view.secondaryLabel, null);
});

test('the fallback card offers nothing to tap and exposes no error text', () => {
  const card = { ...evaluate().card, stateId: 'fallback', priority: null };
  const view = presentation.projectTodayCard({
    card: {
      ...card,
      primaryAction: { action: 'none', labelKey: 'action.none', target: 'none', runnable: false },
      secondaryAction: null,
      itemRefs: [],
    },
    projections: FULL_CLOSET,
    missingSlots: [],
    nowMs: NOW,
  });
  assert.equal(view.actionless, true);
  assert.equal(view.primaryLabel, null);
  assert.equal(view.secondaryLabel, null);
  assert.doesNotMatch(view.explanation, /error|failed|undefined|null/i);
});

test('onboarding says "first" and a Closet top-up does not', () => {
  const onboarding = presentation.projectTodayCard({
    card: evaluate({
      reads: reads({ closet: { ok: true, items: [] } }),
      collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
    }).card,
    projections: [],
    missingSlots: [],
    nowMs: NOW,
  });
  assert.equal(onboarding.primaryLabel, 'Add Your First Item');

  const topUp = presentation.projectTodayCard({
    card: evaluate({
      reads: reads(),
      collaborators: { ...COLLABORATORS, compose: composerReturning([]) },
    }).card,
    projections: FULL_CLOSET,
    missingSlots: [],
    nowMs: NOW,
  });
  assert.equal(topUp.primaryLabel, 'Add More Items');
});

test('no raw id, path or private state reaches the rendered strings', () => {
  const result = evaluate();
  const view = presentation.projectTodayCard({
    card: result.card,
    projections: FULL_CLOSET,
    missingSlots: [],
    nowMs: NOW,
  });
  const rendered = `${view.headline} ${view.explanation} ${view.accessibilityLabel}`;
  for (const forbidden of ['item-top', 'file://', ACTOR, 'session-1', 'composition-1']) {
    assert.ok(!rendered.includes(forbidden), `rendered copy leaked ${forbidden}`);
  }
});

test('routes resolve to existing destinations only', () => {
  assert.equal(
    presentation.resolveTodayRoute('private_dressing_room', { closetSeparationActive: true }),
    '/stylist/dressing-room',
  );
  assert.equal(
    presentation.resolveTodayRoute('elise_modification', { closetSeparationActive: true }),
    '/stylist/dressing-room',
  );
  assert.equal(
    presentation.resolveTodayRoute('closet_intake', { closetSeparationActive: true }),
    '/library?section=closet',
  );
  assert.equal(
    presentation.resolveTodayRoute('closet_intake', { closetSeparationActive: false }),
    '/library',
  );
  assert.equal(presentation.resolveTodayRoute('none', { closetSeparationActive: true }), null);
});

// ── Handoff context consistency ──────────────────────────────────────────────

test('the previewed context is the context that will be handed off', () => {
  const result = evaluate();
  assert.ok(result.ownedLook);
  // The anchor is the newest Closet item with a usable slot, deterministically.
  assert.equal(result.ownedLook.context.anchorClosetItemId, 'item-top');
  assert.equal(result.ownedLook.context.occasion, null);
});

test('an existing session anchor is preserved as the handoff context', () => {
  const result = evaluate({
    reads: reads({
      session: activeSession({ anchorClosetItemId: 'item-shoes', occasion: 'Work' }),
    }),
  });
  assert.equal(result.ownedLook.context.anchorClosetItemId, 'item-shoes');
  assert.equal(result.ownedLook.context.occasion, 'Work');
});

test('a session anchor the Closet no longer resolves is replaced, not trusted', () => {
  const result = evaluate({
    reads: reads({ session: activeSession({ anchorClosetItemId: 'deleted-item' }) }),
  });
  assert.equal(result.ownedLook.context.anchorClosetItemId, 'item-top');
});
