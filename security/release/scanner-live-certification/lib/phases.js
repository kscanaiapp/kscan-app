'use strict';

/**
 * Scenario flows. Every flow drives the REAL client (see kit.js) against the edge
 * it is given, then derives evidence from (a) what the server returned, as
 * recorded by liveEdge, and (b) what the client DISPLAYED / SAVED.
 *
 * Nothing here decides PASS or FAIL for the campaign; flows return facts and
 * integrity findings, and report.js / the certifier apply the predeclared
 * thresholds.
 */

const { performance } = require('node:perf_hooks');
const { COMMERCE_ONLY } = require('./budget');
const { createLiveEdge } = require('./liveEdge');
const kit = require('./kit');
const scoring = require('./scoring');
const { hashShort, sanitizeOffer, str } = require('./report');

const ACTOR_ID = { A: 'actor-a', B: 'actor-b' };
const SELECTED = 'selected_item';
const DETECTION = 'multi_item_detection';

const sleep = kit.sleep;

function imageById(ctx, id) {
  const image = ctx.corpus.images.find((entry) => entry.id === id);
  if (!image) throw new Error(`unknown corpus image ${id}`);
  return image;
}

const uriOf = (ctx, id) => `file:///fixtures/${imageById(ctx, id).file}`;
const assetOf = (ctx, id) => ({ uri: uriOf(ctx, id), assetId: `fx-${id}`, type: 'image' });
const idOfUri = (ctx, uri) => ctx.corpus.images.find((image) => `file:///fixtures/${image.file}` === uri)?.id ?? null;

function imageKeys(ctx) {
  const keys = {};
  for (const image of ctx.corpus.images) {
    const data = ctx.prepared.get(uriOf(ctx, image.id));
    if (data) keys[image.id] = hashShort(String(data).split(',')[1] ?? '');
  }
  return keys;
}

function newSession(ctx, { actor = 'A', hooks = {} } = {}) {
  const edge = createLiveEdge({
    baseUrl: ctx.baseUrl,
    publishableKey: ctx.publishableKey,
    getToken: async () => ctx.tokens[actor],
    actor,
    actorId: ACTOR_ID[actor],
    budget: ctx.budget,
    recorder: ctx.recorder,
    target: ctx.target,
    fetchImpl: ctx.fetchImpl,
    hooks,
    phaseRef: ctx.phaseRef,
  });
  const live = kit.mountLive({ edge, prepared: ctx.prepared, actorId: ACTOR_ID[actor] });
  return { edge, m: live.m, commerceClient: live.commerceClient, actor, actorId: ACTOR_ID[actor] };
}

const okEntries = (ctx, predicate, sinceSeq = 0) => ctx.recorder.entries
  .filter((e) => e.seq > sinceSeq && e.outcome === 'ok' && predicate(e));

const lastOf = (list) => (list.length ? list[list.length - 1] : null);

async function detect(ctx, s, ids) {
  const sinceSeq = ctx.recorder.entries.length;
  await s.m.selectPhotos(ids.map((id) => assetOf(ctx, id)));
  const t0 = performance.now();
  await s.m.analyze();
  const elapsedMs = Math.round(performance.now() - t0);
  const h = s.m.hook;
  const analysis = h.analysis ?? null;
  return {
    sinceSeq,
    elapsedMs,
    status: h.status,
    error: h.error ?? null,
    nonFashionMessage: h.nonFashionMessage ?? null,
    candidates: Array.isArray(analysis?.confirmationCandidates) ? analysis.confirmationCandidates : [],
    detectionNotice: analysis?.detectionNotice ?? null,
  };
}

/** Score one photo's detection from the recorded server answer. */
function detectionEvidence(ctx, id, sinceSeq) {
  const image = imageById(ctx, id);
  const key = ctx.imageKeys[id];
  const entry = lastOf(okEntries(ctx, (e) => e.requestMode === DETECTION && e.imageKey === key, sinceSeq));
  const detected = entry?.response?.detected ?? [];
  return {
    imageId: id,
    entrySeq: entry?.seq ?? null,
    latencyMs: entry?.latencyMs ?? null,
    responseStatus: entry?.response?.status ?? null,
    detected,
    detectionScore: scoring.scoreDetection(image, detected),
  };
}

/** The mapped analysis a user would see for one item. */
function displayedOf(analysis) {
  const meta = analysis?.metadata ?? {};
  return {
    title: str(analysis?.title, 120),
    result: str(analysis?.result, 200),
    category: str(meta.category, 40),
    itemType: str(meta.itemType, 60),
    color: str(meta.color, 40),
    material: str(meta.materialEstimate ?? meta.material, 60),
    pattern: str(meta.pattern, 40),
    brand: str(meta.brand, 60),
    brandConfidence: str(meta.brandConfidence, 20),
    confidenceScore: typeof meta.confidenceScore === 'number' ? meta.confidenceScore : null,
  };
}

function offersDisplayed(analysis) {
  const list = Array.isArray(analysis?.purchaseOptions) ? analysis.purchaseOptions : [];
  return list.slice(0, 10).map((o, i) => sanitizeOffer(o, i + 1)).filter(Boolean);
}

/**
 * Evidence for one identified garment. `bound` is the truth garment its detection
 * candidate was assigned to; unassigned candidates are scored against best fit.
 */
function itemEvidence(ctx, {
  imageId, itemId, serverCandidateId, detectedCandidate, boundGarment, analysis, commerceStatus,
  sinceSeq, commerceCandidateKey = undefined, legacyCommerceAfterSeq = null,
}) {
  const image = imageById(ctx, imageId);
  const key = ctx.imageKeys[imageId];
  const selectedList = okEntries(ctx, (e) => e.requestMode === SELECTED && e.imageKey === key && e.candidateKey === serverCandidateId, sinceSeq);
  const sel = lastOf(selectedList);
  const selAttempts = ctx.recorder.entries.filter((e) => e.seq > sinceSeq && e.requestMode === SELECTED && e.imageKey === key && e.candidateKey === serverCandidateId);
  let commerceList;
  if (commerceCandidateKey !== undefined) {
    commerceList = ctx.recorder.entries.filter((e) => e.seq > sinceSeq && e.kind === COMMERCE_ONLY && e.candidateKey === commerceCandidateKey);
  } else if (legacyCommerceAfterSeq !== null) {
    commerceList = ctx.recorder.entries.filter((e) => e.seq > legacyCommerceAfterSeq && e.kind === COMMERCE_ONLY);
  } else {
    commerceList = [];
  }
  const com = lastOf(commerceList.filter((e) => e.outcome === 'ok'));

  const displayed = displayedOf(analysis);
  const garment = boundGarment
    ?? image.expectedGarments.find((g) => scoring.hasAny(`${sel?.response?.identification?.item_type ?? ''} ${sel?.response?.identification?.subtype ?? ''}`, g.subtypeAny))
    ?? null;
  const idScore = garment
    ? scoring.scoreIdentification(image, garment, { identification: sel?.response?.identification, attributes: sel?.response?.attributes, displayed })
    : null;
  const drift = detectedCandidate
    ? scoring.candidateIdentityDrift(detectedCandidate, { identification: sel?.response?.identification, attributes: sel?.response?.attributes, displayed })
    : null;

  const offers = offersDisplayed(analysis);
  const serverOffers = com?.response?.offers ?? sel?.response?.offers ?? [];
  const orderPreserved = offers.length === 0
    || serverOffers.slice(0, offers.length).every((o, i) => o.title === offers[i]?.title);
  const precheck = garment ? offers.map((o) => scoring.offerPrecheck(garment, o)) : [];

  return {
    imageId,
    itemId,
    serverCandidateId,
    boundGarmentKey: garment?.key ?? null,
    detectedCandidate: detectedCandidate
      ? { label: detectedCandidate.label ?? null, category: detectedCandidate.category ?? null, subtype: detectedCandidate.subtype ?? null }
      : null,
    selected: sel
      ? {
        latencyMs: sel.latencyMs, httpStatus: sel.httpStatus, attempts: selAttempts.length,
        response: sel.response,
        sourceImageKeyMatches: sel.imageKey === key,
      }
      : { latencyMs: null, httpStatus: null, attempts: selAttempts.length, response: null, sourceImageKeyMatches: null },
    displayed,
    identificationScore: idScore,
    candidateIdentityDrift: drift,
    commerce: {
      uiStatus: commerceStatus ?? null,
      requests: commerceList.length,
      okRequests: commerceList.filter((e) => e.outcome === 'ok').length,
      attempts: commerceList.map((e) => ({
        outcome: e.outcome, httpStatus: e.httpStatus ?? null, latencyMs: e.latencyMs ?? null,
        errorType: e.response?.commerce?.errorType ?? null, offerCount: e.response?.offerCount ?? null,
        discoveryMs: e.response?.funnel?.discoveryMs ?? null,
      })),
      latencyMs: com?.latencyMs ?? null,
      httpStatus: com?.httpStatus ?? null,
      echoedCandidateId: com?.response?.candidateIdEcho ?? null,
      providers: com?.response?.commerce?.providersTried ?? null,
      provider: com?.response?.commerce?.provider ?? null,
      errorType: com?.response?.commerce?.errorType ?? null,
      funnel: com?.response?.funnel ?? null,
      serverOfferCount: com?.response?.offerCount ?? null,
    },
    offers,
    offerOrderPreserved: orderPreserved,
    offerPrecheck: precheck,
    offerQuality: {
      destinationsValid: offers.every((o) => scoring.destinationValid(o)),
      pricesSane: offers.every((o) => scoring.priceSane(o)),
      duplicateDestinations: offers.length - new Set(offers.map((o) => `${o.destination?.host}${o.destination?.path}`)).size,
    },
  };
}

const TERMINAL = new Set(['success', 'empty', 'error', 'idle']);

async function pumpCommerce({ screen, store, m, edge, expectIds, timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = screen.render();
    r.dispatchEffect();
    await m.idle(2);
    const flights = store.refs.batchCommerceFlightsRef.current.size;
    const terminal = expectIds.every((id) => TERMINAL.has(store.state.batchCommerceStatuses[id]));
    if (flights === 0 && terminal) return { settled: true, terminal: true };
    // After an account change the screen drops every late answer and leaves the
    // per-item status untouched; once every issued request has drained there is
    // nothing left to wait for.
    if (flights === 0 && edge && commerceCalls(edge) >= expectIds.length && expectIds.length > 0) {
      return { settled: true, terminal: false };
    }
    if (Date.now() > deadline) return { settled: false, terminal: false };
    await sleep(40);
  }
}

const commerceCalls = (edge) => edge.requests.filter((r) => r.kind === COMMERCE_ONLY
  && r.outcome !== 'injected_network_error' && r.outcome !== 'budget_refused').length;

/** Candidate id (server) for a client candidate, via the hook's own binding. */
function serverIdOf(candidate) {
  if (candidate.serverCandidateId) return candidate.serverCandidateId;
  const id = String(candidate.id);
  const at = id.indexOf(':');
  return at >= 0 ? id.slice(at + 1) : id;
}

function sourceImageIdOfCandidate(ctx, candidate, fallbackId = null) {
  return idOfUri(ctx, candidate.sourceImageUri)
    ?? (String(candidate.sourceImageId ?? '').startsWith('fx-') ? String(candidate.sourceImageId).slice(3) : null)
    ?? fallbackId;
}

/**
 * Batch flow: the real queue, selected-item commerce, Save All and reopen.
 * @param opts.holdCommerceMs  hold every MODE B response this long (save-before-offers / account change)
 * @param opts.holdFirstCommerceMs  hold only the first MODE B response (out-of-order delivery)
 * @param opts.failFirstSelectedFor  fixture id whose first selected-item request is failed at zero cost
 * @param opts.accountChangeAfterMs  advance the actor epoch this long after commerce starts
 * @param opts.leaveMidQueue  unmount as soon as the first selected-item request is in flight
 */
async function runBatch(ctx, opts, preset = null) {
  const {
    label, ids, actor = 'A', holdCommerceMs = 0, holdFirstCommerceMs = 0,
    failFirstSelectedFor = null, accountChangeAfterMs = null, leaveMidQueue = false,
    saveBeforeOffers = false, saveAll = true, retryFailed = false, retryCommerceOnError = true,
  } = opts;
  const t0 = performance.now();
  let firstCommerceHeld = false;
  let failedOnce = false;
  const arrival = [];
  const failKey = failFirstSelectedFor ? ctx.imageKeys[failFirstSelectedFor] : null;

  const hooks = {
    beforeSend: async (req) => {
      if (failKey && !failedOnce && req.requestMode === SELECTED && req.imageKey === failKey) {
        failedOnce = true;
        return { fail: true };
      }
      return null;
    },
    afterReceive: async (req) => {
      if (req.kind !== COMMERCE_ONLY) return;
      arrival.push({ key: req.candidateKey, at: Math.round(performance.now() - t0), phase: 'received' });
      if (holdCommerceMs) await sleep(holdCommerceMs);
      else if (holdFirstCommerceMs && !firstCommerceHeld) {
        firstCommerceHeld = true;
        await sleep(holdFirstCommerceMs);
      }
      arrival.push({ key: req.candidateKey, at: Math.round(performance.now() - t0), phase: 'delivered' });
    },
  };

  const s = preset?.s ?? newSession(ctx, { actor, hooks });
  const det = preset?.det ?? await detect(ctx, s, ids);
  const detections = ids.map((id) => detectionEvidence(ctx, id, det.sinceSeq));
  // Zero paid MODE B before any garment is selected (B35-SCAN-014 #1).
  await s.m.idle(6);
  await sleep(400);
  const commerceBeforeSelection = commerceCalls(s.edge);

  const result = {
    label, ids, actor,
    detection: { status: det.status, error: det.error, elapsedMs: det.elapsedMs, notice: det.detectionNotice, perPhoto: detections },
    commerceRequestsBeforeSelection: commerceBeforeSelection,
    candidates: det.candidates.map((c) => ({ id: c.id, sourceImageId: sourceImageIdOfCandidate(ctx, c, ids.length === 1 ? ids[0] : null), label: str(c.label, 60), category: str(c.category, 40), subtype: str(c.subtype, 60) })),
    items: [],
    findings: [],
    queue: null,
    save: null,
    isolation: null,
  };
  if (det.candidates.length === 0) {
    result.findings.push({ id: 'NO_CANDIDATES', detail: `status=${det.status}` });
    s.m.unmount();
    return result;
  }

  const actorRequest = s.m.actor.createActorRequest();
  const store = kit.createStore(actorRequest, { groupId: `live-${label}` });
  const libHandle = kit.loadLibrary(s.m.actor);
  const screen = kit.createScreen({ m: s.m, store, library: libHandle.library, commerceClient: s.commerceClient });
  const selectedIds = det.candidates.map((c) => c.id);
  store.state.batchSelectedCandidateIds = selectedIds;

  // ── queue ────────────────────────────────────────────────────────────────
  const queueStart = performance.now();
  if (leaveMidQueue) {
    const queuePromise = screen.render().runBatchQueue();
    const started = await kit.waitFor(
      () => s.edge.requests.some((r) => r.requestMode === SELECTED && r.outcome === undefined),
      { timeoutMs: 30_000, stepMs: 10 },
    );
    const selectedBeforeLeave = s.edge.requests.filter((r) => r.requestMode === SELECTED).length;
    try { s.m.unmount(); } catch { /* unmount of a live probe may throw after abort */ }
    await Promise.race([queuePromise, sleep(8_000)]);
    await sleep(2_500);
    const selectedAfter = s.edge.requests.filter((r) => r.requestMode === SELECTED).length;
    result.queue = {
      left: true, startedBeforeLeave: started, selectedBeforeLeave, selectedAfterLeave: selectedAfter,
      commerceAfterLeave: commerceCalls(s.edge),
      itemsReadyAfterLeave: store.state.batchItems.length,
      stoppedDispatching: selectedAfter === selectedBeforeLeave,
    };
    if (selectedAfter !== selectedBeforeLeave) result.findings.push({ id: 'DISPATCH_AFTER_LEAVE', detail: `${selectedBeforeLeave}->${selectedAfter}` });
    if (commerceCalls(s.edge) > 0) result.findings.push({ id: 'COMMERCE_AFTER_LEAVE', detail: String(commerceCalls(s.edge)) });
    return result;
  }

  await screen.render().runBatchQueue();
  if (retryFailed) {
    // One explicit retry of whatever failed or is partial; ready siblings must not be re-dispatched.
    const before = s.edge.requests.filter((r) => r.requestMode === SELECTED && r.outcome !== 'injected_network_error').length;
    const failedIds = selectedIds.filter((id) => {
      const state = store.state.batchItemStates[id];
      const item = store.state.batchItems.find((entry) => entry.id === id);
      return state !== 'ready' || item?.detailStatus === 'partial';
    });
    result.queue = { failedBeforeRetry: failedIds, selectedRequestsBeforeRetry: before };
    if (failedIds.length) await screen.render().runBatchQueue(failedIds);
    const after = s.edge.requests.filter((r) => r.requestMode === SELECTED && r.outcome !== 'injected_network_error').length;
    result.queue.selectedRequestsAfterRetry = after;
    result.queue.retryDispatches = after - before;
    if (failedIds.length && after - before !== failedIds.length) {
      result.findings.push({ id: 'RETRY_AMPLIFICATION', detail: `expected ${failedIds.length}, dispatched ${after - before}` });
    }
  }
  const queueMs = Math.round(performance.now() - queueStart);
  result.queue = { ...(result.queue ?? {}), queueMs, notice: store.state.batchQueueNotice, remaining: store.state.batchRemainingCandidateIds };

  // ── commerce (deferred, selected items only) ─────────────────────────────
  const deferredIds = store.state.batchItems.filter((i) => i.analysis?.commerceDeferred && i.analysis?.commerceEvidence?.identification).map((i) => i.id);
  const commerceStart = performance.now();
  let switchedActor = false;
  let accountTimer = null;
  if (accountChangeAfterMs !== null) {
    accountTimer = setTimeout(() => { switchedActor = true; s.m.actor.advanceActorEpoch('actor-b'); }, accountChangeAfterMs);
  }

  if (saveBeforeOffers) {
    // Kick commerce, then Save All BEFORE any held response is delivered.
    screen.render().dispatchEffect();
    await s.m.idle(2);
    await screen.render().saveAllBatchItems();
    result.save = { savedBeforeOffers: true, savedIdsBeforeOffers: Object.keys(store.state.savedBatchScanIds).length };
  }

  const pumped = await pumpCommerce({ screen, store, m: s.m, edge: s.edge, expectIds: deferredIds, timeoutMs: 75_000 });
  const settled = pumped.settled;
  // ── one explicit commerce retry per errored garment (the screen's own retry action) ──
  const commerceRetries = { attempted: [], selectedItemRequestsDuringRetry: 0 };
  if (retryCommerceOnError && !switchedActor && accountChangeAfterMs === null) {
    const failedNow = deferredIds.filter((id) => store.state.batchCommerceStatuses[id] === 'error');
    if (failedNow.length) {
      const selBefore = s.edge.requests.filter((r) => r.requestMode === SELECTED && r.outcome !== 'injected_network_error' && r.outcome !== 'budget_refused').length;
      const rr = screen.render();
      for (const id of failedNow) {
        const item = store.state.batchItems.find((entry) => entry.id === id);
        if (item) { commerceRetries.attempted.push(id); void rr.hydrateBatchCommerceForItem(item, { isRetry: true }); }
      }
      await pumpCommerce({ screen, store, m: s.m, edge: s.edge, expectIds: commerceRetries.attempted, timeoutMs: 45_000 });
      const selAfter = s.edge.requests.filter((r) => r.requestMode === SELECTED && r.outcome !== 'injected_network_error' && r.outcome !== 'budget_refused').length;
      commerceRetries.selectedItemRequestsDuringRetry = selAfter - selBefore;
    }
  }
  if (accountTimer) clearTimeout(accountTimer);
  const commerceMs = Math.round(performance.now() - commerceStart);
  result.commerce = {
    settled, allTerminal: pumped.terminal, commerceMs, deferredItems: deferredIds.length, requestsIssued: commerceCalls(s.edge), retries: commerceRetries,
    arrival, switchedActor,
  };

  // ── late offers must attach to the already-saved record, once ────────────
  if (saveBeforeOffers) {
    screen.render().attachEffect();
    await sleep(300);
    await s.m.idle(2);
  }

  // ── Save All + reopen ────────────────────────────────────────────────────
  if (saveAll && !saveBeforeOffers && !switchedActor) {
    await screen.render().saveAllBatchItems();
    await screen.render().saveAllBatchItems(); // idempotent: the second press writes nothing
  }
  const records = await libHandle.library.loadLibrary(s.actorId);
  const otherActorRecords = await libHandle.library.loadLibrary('actor-b');

  // ── per-item evidence ────────────────────────────────────────────────────
  const photoDet = Object.fromEntries(detections.map((d) => [d.imageId, d]));
  for (const candidate of det.candidates) {
    const imageId = sourceImageIdOfCandidate(ctx, candidate, ids.length === 1 ? ids[0] : null);
    const item = store.state.batchItems.find((entry) => entry.id === candidate.id) ?? null;
    const detected = (photoDet[imageId]?.detected ?? []).find((d) => d.candidateId === serverIdOf(candidate)) ?? null;
    const assignment = photoDet[imageId]?.detectionScore.assignments.find((a) => a.candidateId === serverIdOf(candidate)) ?? null;
    const image = imageById(ctx, imageId);
    const boundGarment = assignment ? image.expectedGarments.find((g) => g.key === assignment.garment) : null;
    const savedId = store.state.savedBatchScanIds[candidate.id] ?? null;
    const record = savedId ? records.find((r) => r.id === savedId) ?? null : null;
    const evidence = itemEvidence(ctx, {
      imageId, itemId: candidate.id, serverCandidateId: serverIdOf(candidate), detectedCandidate: detected,
      boundGarment, analysis: item?.analysis ?? null, commerceStatus: store.state.batchCommerceStatuses[candidate.id] ?? null,
      sinceSeq: det.sinceSeq, commerceCandidateKey: candidate.id,
    });
    evidence.itemState = store.state.batchItemStates[candidate.id] ?? null;
    evidence.detailStatus = item?.detailStatus ?? null;
    evidence.saved = savedId
      ? {
        saved: true,
        reopened: Boolean(record),
        mediaIsOwnPhoto: record ? String(libHandle.memfs.files.get(record.imageUri) ?? '').includes(item?.sourceImageUri ?? '\u0000') : false,
        sourceImageIdMatches: record ? record.metadata?.multiScan?.sourceImageId === item?.sourceImageId : false,
        savedOfferCount: Array.isArray(record?.purchaseOptions) ? record.purchaseOptions.length : 0,
        resultMatches: record ? record.result === item?.analysis?.result : false,
      }
      : { saved: false };
    result.items.push(evidence);
  }

  result.save = {
    ...(result.save ?? {}),
    recordsForActor: records.length,
    recordsForOtherActor: otherActorRecords.length,
    distinctMediaFiles: new Set(records.map((r) => r.imageUri)).size,
    savedItemCount: Object.keys(store.state.savedBatchScanIds).length,
  };

  // ── integrity findings ───────────────────────────────────────────────────
  const selectedCount = result.items.filter((i) => i.itemState === 'ready').length;
  const requests = commerceCalls(s.edge);
  if (!switchedActor && requests !== deferredIds.length + commerceRetries.attempted.length) {
    result.findings.push({ id: 'COMMERCE_REQUEST_COUNT', detail: `${requests} requests for ${deferredIds.length} selected deferred items + ${commerceRetries.attempted.length} explicit retries` });
  }
  if (commerceRetries.selectedItemRequestsDuringRetry !== 0) {
    result.findings.push({ id: 'GEMINI_ON_COMMERCE_RETRY', detail: String(commerceRetries.selectedItemRequestsDuringRetry) });
  }
  if (commerceBeforeSelection !== 0) result.findings.push({ id: 'COMMERCE_BEFORE_SELECTION', detail: String(commerceBeforeSelection) });
  for (const item of result.items) {
    if (item.selected.sourceImageKeyMatches === false) result.findings.push({ id: 'CANDIDATE_IMAGE_MIXUP', detail: item.itemId });
    if (item.candidateIdentityDrift?.drift) result.findings.push({ id: 'CANDIDATE_IDENTITY_DRIFT', detail: `${item.itemId} ${item.candidateIdentityDrift.detectedFamily}->${item.candidateIdentityDrift.returnedFamily}` });
    if (item.commerce.requests > 1 + (commerceRetries.attempted.includes(item.itemId) ? 1 : 0)) result.findings.push({ id: 'DUPLICATE_COMMERCE', detail: item.itemId });
    if (item.commerce.echoedCandidateId && item.commerce.echoedCandidateId !== item.itemId) {
      result.findings.push({ id: 'COMMERCE_ECHO_MISMATCH', detail: `${item.itemId} sent ${String(item.itemId).length} chars` });
    }
    if (item.saved.saved && (!item.saved.mediaIsOwnPhoto || !item.saved.sourceImageIdMatches)) {
      result.findings.push({ id: 'SAVED_SOURCE_MISMATCH', detail: item.itemId });
    }
    if (!item.offerOrderPreserved) result.findings.push({ id: 'OFFER_ORDER_CHANGED', detail: item.itemId });
  }
  if (result.save.recordsForOtherActor !== 0) result.findings.push({ id: 'ACTOR_CONTAMINATION', detail: 'another actor sees saved items' });
  if (saveBeforeOffers) {
    const attached = result.items.filter((i) => i.saved.saved && i.commerce.uiStatus === 'success');
    result.save.lateOffersAttached = attached.length > 0 && attached.every((i) => i.saved.savedOfferCount > 0);
    if (attached.length > 0 && !result.save.lateOffersAttached) result.findings.push({ id: 'LATE_OFFERS_NOT_ATTACHED' });
  }
  if (switchedActor) {
    const leaked = result.items.filter((i) => i.offers.length > 0);
    const saved = Object.keys(store.state.savedBatchScanIds).length;
    result.isolation = { switchedActor, itemsWithOffersAfterSwitch: leaked.length, savedAfterSwitch: saved };
    if (leaked.length || saved) result.findings.push({ id: 'ACTOR_CONTAMINATION', detail: `offers=${leaked.length} saved=${saved}` });
  }
  void selectedCount;

  result.timings = {
    detectionMs: det.elapsedMs,
    queueMs,
    commerceMs,
    endToEndMs: Math.round(performance.now() - t0),
  };
  s.m.unmount();
  return result;
}

/**
 * Single-photo flow, exactly like the screen decides: one candidate -> the legacy
 * single-item path (hook-owned commerce); several -> the batch path.
 */
async function runPhoto(ctx, id, { actor = 'A', label = `photo-${id}`, identify = true } = {}) {
  const hooks = {};
  const s = newSession(ctx, { actor, hooks });
  const det = await detect(ctx, s, [id]);
  const detection = detectionEvidence(ctx, id, det.sinceSeq);
  await s.m.idle(6);
  await sleep(300);
  const out = {
    label, imageId: id, path: null,
    detection: { status: det.status, error: det.error, elapsedMs: det.elapsedMs, nonFashionMessage: det.nonFashionMessage, evidence: detection },
    commerceRequestsBeforeSelection: commerceCalls(s.edge),
    items: [],
    findings: [],
  };
  if (det.candidates.length === 0 || !identify) {
    out.path = det.candidates.length === 0 ? 'no_candidates' : 'detect_only';
    if (det.candidates.length === 0 && imageById(ctx, id).nonFashion !== true) {
      out.findings.push({ id: 'EXPECTED_GARMENTS_NOT_DETECTED', detail: `status=${det.status}` });
    }
    s.m.unmount();
    return out;
  }
  if (out.commerceRequestsBeforeSelection !== 0) out.findings.push({ id: 'COMMERCE_BEFORE_SELECTION', detail: String(out.commerceRequestsBeforeSelection) });

  if (det.candidates.length > 1) {
    // The screen's own rule: more than one garment continues on the batch path.
    // The detection already paid for is reused; it is never repeated.
    return runBatch(ctx, { label, ids: [id], actor }, { s, det });
  }

  out.path = 'legacy_single_item';
  const candidate = det.candidates[0];
  const image = imageById(ctx, id);
  const assignment = detection.detectionScore.assignments.find((a) => a.candidateId === serverIdOf(candidate)) ?? null;
  const boundGarment = assignment ? image.expectedGarments.find((g) => g.key === assignment.garment) : null;
  s.m.hook.selectConfirmationCandidate(candidate.id);
  await s.m.idle(3);
  const selStartSeq = ctx.recorder.entries.length;
  const t0 = performance.now();
  await s.m.hook.analyzeSelectedCandidate(candidate.id);
  await s.m.idle(6);
  await kit.waitFor(() => ['result', 'error'].includes(s.m.hook.status), { timeoutMs: 60_000, idle: () => s.m.idle(1) });
  const identifyMs = Math.round(performance.now() - t0);
  const sawDeferred = s.m.hook.analysis?.commerceDeferred === true;
  let settled = await kit.waitFor(() => s.m.hook.commerceStatus !== 'pending', { timeoutMs: 60_000, idle: () => s.m.idle(1) });
  await s.m.idle(4);
  let legacyRetry = null;
  if (settled && s.m.hook.commerceStatus === 'error') {
    const selBefore = s.edge.requests.filter((r) => r.requestMode === SELECTED && r.outcome !== 'injected_network_error').length;
    s.m.hook.retryCommerce();
    await s.m.idle(3);
    settled = await kit.waitFor(() => s.m.hook.commerceStatus !== 'pending', { timeoutMs: 45_000, idle: () => s.m.idle(1) });
    await s.m.idle(4);
    legacyRetry = { attempted: true, selectedItemRequestsDuringRetry: s.edge.requests.filter((r) => r.requestMode === SELECTED && r.outcome !== 'injected_network_error').length - selBefore };
    if (legacyRetry.selectedItemRequestsDuringRetry !== 0) out.findings.push({ id: 'GEMINI_ON_COMMERCE_RETRY', detail: String(legacyRetry.selectedItemRequestsDuringRetry) });
  }
  const analysis = s.m.hook.analysis;
  const evidence = itemEvidence(ctx, {
    imageId: id, itemId: candidate.id, serverCandidateId: serverIdOf(candidate),
    detectedCandidate: detection.detected.find((d) => d.candidateId === serverIdOf(candidate)) ?? null,
    boundGarment, analysis, commerceStatus: s.m.hook.commerceStatus, sinceSeq: det.sinceSeq,
    legacyCommerceAfterSeq: selStartSeq,
  });
  evidence.hookStatus = s.m.hook.status;
  evidence.commerceDeferredSeen = sawDeferred;
  evidence.commerceSettled = settled;
  evidence.legacyRetry = legacyRetry;
  evidence.identifyMs = identifyMs;
  if (evidence.selected.sourceImageKeyMatches === false) out.findings.push({ id: 'CANDIDATE_IMAGE_MIXUP', detail: candidate.id });
  if (evidence.candidateIdentityDrift?.drift) out.findings.push({ id: 'CANDIDATE_IDENTITY_DRIFT', detail: candidate.id });
  out.items.push(evidence);
  out.timings = { detectionMs: det.elapsedMs, identifyMs };
  s.m.unmount();
  return out;
}

module.exports = {
  ACTOR_ID,
  DETECTION,
  SELECTED,
  assetOf,
  commerceCalls,
  detect,
  detectionEvidence,
  imageById,
  imageKeys,
  newSession,
  pumpCommerce,
  runBatch,
  runPhoto,
  uriOf,
};
