// Builds audit/a2/out/a2-batch4-ledger.json (style-outfit-generate, 43 matrix rows) from the Deno results + the retained matrix snapshot.
// Usage: node audit/a2/build-ledger-batch4.cjs <path to mandatory-hostile-probes.json from PR #646 head 49ab7fad>
const fs = require('fs');
const matrix = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const res = JSON.parse(fs.readFileSync(__dirname + '/out/outfit-batch4-results.json', 'utf8'));
const mut = JSON.parse(fs.readFileSync(__dirname + '/out/outfit-batch4-mutations.json', 'utf8'));
const prior = ['a2-batch1-ledger', 'a2-batch2-ledger', 'a2-batch3-ledger'].map((n) => JSON.parse(fs.readFileSync(__dirname + '/out/' + n + '.json', 'utf8')));
const byId = {};
for (const r of res.results) byId[r.probeId] = r;

const PASS = 'PASS (source harness, proposed)';
const PASSA = 'PASS (source harness, analog - needs Codex ruling)';
const NA = 'N/A (proposed, needs Codex ruling)';
const NT = 'NOT TESTED (kept)';
const rec = (id) => (byId[id] ? 'audit/a2/out/outfit-batch4-results.json#' + id : null);
const mutsFor = (n) => mut.muts.filter((m) => m.applied && m.detected && m.failing.some((f) => f.includes(String(n)))).map((m) => m.name.split(' ')[0]);
const cells = [];
const cell = (n, disposition, why, remaining, overlap, evidenceId) => {
  const id = 'B35-MAND-' + n;
  const m = matrix.find((x) => x.probeId === id);
  if (!m) throw new Error('no matrix row ' + id);
  if (m.endpoint !== 'function:style-outfit-generate') throw new Error('wrong endpoint ' + id);
  if (m.verdict !== 'NOT TESTED') throw new Error('cell not outstanding: ' + id);
  if (m.coverageDisposition.category === 2) throw new Error('already N/A: ' + id);
  const ev = evidenceId || id;
  if ((disposition === PASS || disposition === PASSA) && !byId[id]) throw new Error('no harness record ' + id);
  if (disposition === NA && !byId[ev]) throw new Error('no evidence record ' + ev);
  cells.push({
    probeId: id, probe: m.probe, currentVerdict: m.verdict, currentCategory: m.coverageDisposition.category, proposedDisposition: disposition,
    rationale: why, evidence: rec(ev), harnessVerdict: byId[ev] ? byId[ev].verdict : null,
    mutationsDetecting: disposition === PASS || disposition === PASSA ? mutsFor(n) : [], overlapRefs: overlap || [], remainingGap: remaining || null,
  });
};
const lim = 'Stubbed Auth/PostgREST/Gemini; handler default flags; not a deployed function.';
const quotaObs = ' OBSERVATION: the daily quota unit is reserved before the provider call and there is no refund RPC, so a failed generation still spends one of the 10 daily generations.';

cell('1124', PASS, 'Expired/empty/non-bearer/missing credentials, on both the unversioned and versioned bodies => 401 with only the Auth check executed; valid control still served.', lim + ' No live signed-JWT validation. Mutation O23 (bearer regex bypass) survives as an equivalent mutant: the Auth getUser call still rejects a non-JWT.', ['B35-MAND-1125/1126 are Production-gateway PASSes for malformed/tampered JWT; expired JWT had no record']);
cell('1127', PASS, 'Seven identity headers and userId/user_id/actorId/ownerId body fields naming actor B presented with actor A token: a B-owned anchor is refused 403 with zero quota and zero provider, an A-owned anchor is served as A, no downstream call carries the B actor id. Unknown/null/empty schemaVersion => 400 UNSUPPORTED_SCHEMA_VERSION before any read; a nested lookalike does not switch dispatch.', lim + ' Stub does not emulate RLS, so the handler-side ownership filter is what is observed.');
cell('1132', PASS, 'Bounds observed in the model-bound prompt: note 280, keepItems 6, excludeItems 12, maximumOutfits 3, private instruction 200, private requestId 64; structural violations on the versioned branch (21 candidates, unknown field incl. 2 MB, wrong type) => 400 before quota/provider.', lim + ' OBSERVATION: no raw byte cap in the handler; over-long text fields are TRUNCATED, not rejected, so an oversize text request is still served and spends quota. The request-size bound is the platform gateway.');
cell('1133', PASS, 'Seven homoglyph/fullwidth/zero-width/hyphen-look-alike/combining-mark variants of a valid anchor UUID => 400 with zero closet reads, quota or provider; homoglyph mode and contractVersion refused; homoglyph ids returned by the provider never enter an outfit; real id with case/whitespace variation canonicalises to the same owned item.', lim);
cell('1134', PASS, 'Six traversal/query-injection shaped anchor ids => 400 before any closet query; no traversal sequence reaches a downstream URL; of eight inspiration rows only the exact own-prefix .jpg under the style-library bucket is a pool member, and no Storage request is ever made.', lim + ' The handler reads storage_path only as an eligibility predicate and never downloads it, so the server download guard is not exercised.');
cell('1135', PASS, 'Six SSRF-shaped URLs injected into event fields, anchor id, unknown URL fields, private instruction/context/candidate fields and a hostile model env value: outbound hosts limited to the Supabase fixture and Gemini; the model path stays on the allowlist.', lim + ' No server-side URL or image download exists in this function, so DNS-rebind against a fetched caller URL has no surface. Not mutation-checked (no single guard to break).');
cell('1136', PASS, 'Prompt structure and output containment: no field changes the system prompt (byte-identical to control); closed-enum fields drop injected text; free text stays in the user turn; a model that obeys a forged ANCHOR line, an invented id and a role spoof still cannot surface any out-of-pool or role-spoofed outfit; the private response is limited to contract fields and an out-of-vocabulary occasion fails closed.', lim + ' OBSERVATIONS (owner to rule): (1) event.note and user-authored closet/scan metadata are NOT delimiter-escaped, unlike stylechat-generate, so a newline can forge ANCHOR/closet lines in the user turn; containment is the output validator. (2) A provider-authored "reason" is capped at 240 chars but otherwise unfiltered, so a hostile or injected model could surface a URL or markup. Whether a real model obeys needs a paid provider (excluded), as with 0749.');
cell('1137', PASS, 'Every caller field carries a SQL metacharacter + DROP TABLE payload on both branches: the two RPC bodies are exactly {p_limit: <server env limit>}, no caller string appears in any RPC, URL or PostgREST filter, table query shapes are identical to the control, and caller p_limit/dailyLimit/burstLimit overrides are ignored.', lim + ' SQL bodies of check_and_increment_style_outfit_burst / increment_style_outfit_daily_usage not exercised (needs real Postgres).');
cell('1140', PASS, 'Same body under Content-Type image/png, multipart, text/plain, octet-stream and empty gives the identical outcome as the honest request; a non-JSON body is a controlled 400.', lim);
cell('1142', PASS, 'Ten rapid requests: first 3 served, 7 denied 429 burst_limit; denied attempts reach neither the provider nor the daily quota; malformed or errored limiter fails closed (500); daily exhaustion => 429 quota_exceeded with no provider; the versioned branch returns BURST_LIMIT / QUOTA_EXCEEDED the same way.', lim + ' The limiters themselves are SQL and not exercised. The 429 carries retryAfterSeconds in the body but no Retry-After header.');
cell('1145', PASS, 'Actor B token naming actor A closet item => 403, zero quota, zero provider; concurrent A/B requests never cross text, items or closet queries.', lim + ' Client account-switch UX is a device/client concern.');
cell('1146', PASS, 'Slow A provider reply released after B completes: each reply returned only to its own request; no cross-actor text or item in either provider request.', lim + ' Client-side supersession (UI discarding a late reply) not exercised.');
cell('1147', PASS, 'No module-level mutable store in the handler tree (static scan); interleaved A/B/A requests: no actor data in another actor request or response.', lim + ' The function has no cache of its own; platform caching not exercised.');
cell('1148', PASS, 'Provider 500 => HTTP 503 provider_unavailable with fixed copy, no provider detail, 1 attempt, no write; versioned branch => 200 safe_failure with contract fields only.' + quotaObs, lim);
cell('1149', PASS, 'Provider 429 (hostile Retry-After 9999) => same controlled 503, 1 attempt, no write; versioned safe_failure.' + quotaObs, lim);
cell('1150', PASS, 'Provider that never answers is aborted by the attempt timeout (15 s scaled to 25 ms in the harness) => same controlled 503, no hang; versioned safe_failure.' + quotaObs, lim + ' Real 15 s not waited; the timeout constant is not mutation-checked because the harness keys off its literal value.');
cell('1151', PASS, 'HTTP 200 non-JSON body => exactly one retry then 503 provider_unavailable; no raw text echoed; versioned safe_failure.' + quotaObs, lim);
cell('1152', PASS, 'Empty HTTP body, candidates with no parts and blank text part => exactly one retry then 503; versioned safe_failure.' + quotaObs, lim);
cell('1153', PASS, 'Eleven wrong-shape / out-of-pool provider outputs (envelope, JSON null, wrong shape, junk array, invented, other-actor, duplicate, missing anchor, no shoes, 7 items, retailer source type) never surface an outfit (200 no_result or 503); five wrong-shape versioned outputs fail closed to safe_failure.' + quotaObs, lim);
cell('1154', PASS, 'Auth ok then 401 on closet read, saved_scans read, burst RPC, daily RPC (both branches) => 500 and zero provider; consent read 401 => 503; lifecycle profile read 401 => 403.', lim + ' OBSERVATIONS: a transient lifecycle-read failure is reported as 403 ACCOUNT_PENDING_DELETION (non-retryable "scheduled for deletion"); an inspiration_items read failure is intentionally ignored (documented graceful degradation).');
cell('1160', PASS, 'Ten alternating unversioned/versioned replays from a pending_deletion account and a locked account => 403 ACCOUNT_PENDING_DELETION before consent, closet, quota or provider; RPC lifecycle guard also yields 403 on both branches.', lim + ' SQL deletion state machine is another lane.');
cell('1138', PASSA, 'The unversioned request has no byte-upload field (image fields are ignored; client candidate arrays are never read) and the versioned strict allow-list rejects every image/storage field with 400 before quota. No provider request ever carries a binary part.', 'Ruling needed: PASS-scoped vs N/A-by-construction. The endpoint has no byte path (text-only prompt; inspiration storage_path is an eligibility predicate and is never downloaded).');
cell('1139', PASSA, 'As 1138 for zero-byte/truncated payloads.', 'Same ruling and same no-byte-path gap as 1138.');
cell('1157', NA, 'The function never consults an entitlement: no K+/RevenueCat/subscription reference exists in the handler tree (comment-stripped static scan) and the daily limit is one flat env value for every caller, so a stale entitlement cannot change any decision here.', 'Needs Codex N/A ruling. Stale-entitlement behaviour is owned by the entitlement-consuming endpoints.', [], 'SURFACE-SCAN');
cell('1159', NA, 'The function performs no persistence: zero .insert/.upsert/.update/.delete on any table and zero Storage calls in the handler tree (static scan), and zero non-RPC writes in every probe of this batch, so there is no save to replay. Replays only spend quota (see 1141).', 'Needs Codex N/A ruling. The Look save belongs to the client service and its own endpoint.', [], 'SURFACE-SCAN');

const ntWhy = {
  1120: ['Cat 4 (Staging fixture). Own-closet success is shown by the harness control, but no signed live actor JWT exists. Supplementary only, no credit.', 'Needs Staging synthetic actor via a Codex-queued workflow.'],
  1121: ['Cat 4. Handler-level refusal of a foreign anchor is shown (1127, 1145), but the cell requires a real two-actor Staging fixture with RLS. Supplementary only, no credit.', 'Needs two Staging actors.'],
  1122: ['Cat 4. The handler never downloads a storage path; the eligibility predicate rejects foreign and traversal paths (1134), which is supplementary only.', 'Needs Staging objects and the server download path (not present in this function).'],
  1123: ['Cat 4. This function has no shared-room membership read at all (static scan), so removed-member behaviour belongs to the endpoints that resolve membership. Candidate for a Codex N/A ruling; not proposed here to stay consistent with batch 3 1166.', 'Codex to rule N/A vs Staging fixture.'],
  1128: ['Feature-independent client-bundle control; only the response-side control was observed (no service-role or provider key in response/headers).', 'Needs one cross-feature client-bundle scan owner (same as 0741/2762/1171).'],
  1141: ['OBSERVATION only. With default flags ten concurrent identical requests spend ten quota units and ten provider calls; the handler has no idempotency key (response requestId is server-generated).', 'Needs a real concurrent SQL run of the limiters.'],
  1143: ['Cancel-then-reissue is client behaviour; the server cannot observe a client cancel.', 'Client lane or device.'],
  1144: ['Navigate-away-and-return is client navigation behaviour.', 'Client lane or device.'],
  1161: ['Cat 4. The function issues no signed URLs and downloads nothing; expired-signed-URL replay belongs to the endpoints that mint or accept them.', 'Needs Staging with the owning endpoint.'],
};
for (const [n, [why, gap]] of Object.entries(ntWhy)) cell(n, NT, why, gap);

const tally = (rows, pick) => rows.reduce((a, r) => ((a[pick(r)] = (a[pick(r)] || 0) + 1), a), {});
const cur = tally(matrix, (r) => r.verdict);
const cat = tally(matrix, (r) => r.coverageDisposition && r.coverageDisposition.category);
const prop = tally(cells, (c) => c.proposedDisposition);
const rows = matrix.filter((m) => m.endpoint === 'function:style-outfit-generate');
const pending = rows.filter((m) => m.verdict === 'NOT TESTED' && m.coverageDisposition.category !== 2).map((m) => m.probeId);
const ids = cells.map((c) => c.probeId);
if (new Set(ids).size !== ids.length) throw new Error('duplicate cell');
if (ids.length !== pending.length || pending.some((i) => !ids.includes(i))) throw new Error('coverage mismatch ' + ids.length + '/' + pending.length);
for (const p of prior) if (cells.some((c) => p.cells.some((x) => x.probeId === c.probeId))) throw new Error('overlap with prior batch');
const nPass = prop[PASS] || 0, nPassA = prop[PASSA] || 0, nNA = prop[NA] || 0;
const mk = (pass, na) => {
  const o = { PASS: cur.PASS + pass, FAIL: cur.FAIL, NOT_TESTED: cur['NOT TESTED'] - pass, total: matrix.length, naCategory2: cat[2] + na, deviceCategory6: cat[6] };
  o.applicablePending = o.NOT_TESTED - o.naCategory2;
  o.inScopeApplicablePending = o.applicablePending - o.deviceCategory6;
  if (o.PASS + o.FAIL + o.NOT_TESTED !== o.total) throw new Error('identity broken');
  return o;
};
const sum = (p, k) => (p.proposedBreakdown[k] || 0);
const priorPass = prior.reduce((a, p) => a + sum(p, PASS) + sum(p, PASSA), 0);
const priorNA = prior.reduce((a, p) => a + sum(p, NA), 0);

const out = {
  lane: 'A2 batch 4 (issue #702) - style-outfit-generate',
  mobileSourceSha: res.sourceSha,
  matrixSnapshot: 'PR #646 head 49ab7fada3639587911849080ff33c6ad17fd9df docs/release/evidence/mandatory-hostile-probes.json',
  fingerprintKind: 'git blob ids at the tested commit',
  sourceFingerprints: {
    'supabase/functions/style-outfit-generate/index.ts': 'e9062ce8e0e1b8e8642debc7612ac561d3e02814',
    'supabase/functions/style-outfit-generate/validation.ts': '007bd979e71af3b23ba3d645a08b2cae43c4ed2b',
    'supabase/functions/style-outfit-generate/accountActiveGate.ts': 'ffc7506274cb2a6376ffb11be3da64fb69f82214',
    'supabase/functions/style-outfit-generate/modelRouting.ts': '547ae8383c0aa24c190d8c574b959554927fac4a',
    'supabase/functions/style-outfit-generate/reasoningContract.ts': 'e1efb9c23367f208fae52e5614420e3de8cf5c9a',
    'supabase/functions/style-outfit-generate/privateDressingRoomEliseContract.ts': 'ddaa3d8fb0c3863d509fcd5cf92505fb9032c902',
    'supabase/functions/style-outfit-generate/privateDressingRoomEliseHandler.ts': 'c44e55c2f7043b23af5f105cd3adeb56930c3120',
    'supabase/functions/_shared/geminiConsent.ts': 'eb1a771388ae8819e2a941c0bb556fca1690b994',
    'supabase/functions/_shared/deletion/common.ts': '194f43281d3aea58da4e30e5284932836db06099',
  },
  rowsInScope: rows.length,
  alreadyPass: rows.filter((m) => m.verdict === 'PASS').map((m) => m.probeId),
  alreadyNA_cat2_not_reproposed: rows.filter((m) => m.coverageDisposition.category === 2).map((m) => m.probeId),
  cellsEvaluated: cells.length,
  proposedBreakdown: prop,
  mutationControls: mut.muts,
  countsBefore: mk(0, 0),
  countsBatch4Alone: {
    allProposalsAccepted: mk(nPass + nPassA, nNA),
    analogPassAndNaRejected_stay_NT: mk(nPass, 0),
  },
  countsCumulativeAllBatchesAccepted: mk(priorPass + nPass + nPassA, priorNA + nNA),
  cells,
  notCovered: 'Packing (served by stylechat-generate under schemaVersion; Agent 7), the server-side attachment/storage download path, and the SQL bodies of the two quota RPCs were not exercised.',
  dedupe: 'Not additive with the 886 executed records (style-outfit-generate holds auth and body-shape records only; none overlap these cells), the 47 shared-handler or 46 K+ Staging records. Only cells marked PASS change a verdict.',
};
fs.writeFileSync(__dirname + '/out/a2-batch4-ledger.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ prop, before: out.countsBefore, alone: out.countsBatch4Alone, cumulative: out.countsCumulativeAllBatchesAccepted }));
