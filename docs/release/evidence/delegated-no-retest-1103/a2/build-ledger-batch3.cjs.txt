// Builds audit/a2/out/a2-batch3-ledger.json (StyleChat / stylechat-generate, 43 matrix rows) from the Deno results + the retained matrix snapshot.
// Usage: node audit/a2/build-ledger-batch3.cjs <path to mandatory-hostile-probes.json from PR #646 head 49ab7fad>
const fs = require('fs');
const matrix = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const res = JSON.parse(fs.readFileSync(__dirname + '/out/stylechat-batch3-results.json', 'utf8'));
const mut = JSON.parse(fs.readFileSync(__dirname + '/out/stylechat-batch3-mutations.json', 'utf8'));
const b1 = JSON.parse(fs.readFileSync(__dirname + '/out/a2-batch1-ledger.json', 'utf8'));
const b2 = JSON.parse(fs.readFileSync(__dirname + '/out/a2-batch2-ledger.json', 'utf8'));
const byId = {};
for (const r of res.results) byId[r.probeId] = r;

const PASS = 'PASS (source harness, proposed)';
const PASSA = 'PASS (source harness, analog - needs Codex ruling)';
const NT = 'NOT TESTED (kept)';
const rec = (id) => (byId[id] ? 'audit/a2/out/stylechat-batch3-results.json#' + id : null);
const cells = [];
const cell = (n, disposition, why, remaining, overlap) => {
  const id = 'B35-MAND-' + n;
  const m = matrix.find((x) => x.probeId === id);
  if (!m) throw new Error('no matrix row ' + id);
  if (m.endpoint !== 'function:stylechat-generate') throw new Error('wrong endpoint ' + id);
  if (m.verdict !== 'NOT TESTED') throw new Error('cell not outstanding: ' + id);
  if (m.coverageDisposition.category === 2) throw new Error('already N/A: ' + id);
  if (disposition !== NT && !byId[id]) throw new Error('no harness record ' + id);
  cells.push({ probeId: id, probe: m.probe, currentVerdict: m.verdict, currentCategory: m.coverageDisposition.category, proposedDisposition: disposition, rationale: why, evidence: rec(id), harnessVerdict: byId[id] ? byId[id].verdict : null, overlapRefs: overlap || [], remainingGap: remaining || null });
};
const lim = 'Stubbed Auth/PostgREST/Gemini; handler default flags; not a deployed function.';

cell('1167', PASS, 'Expired/empty/non-bearer/missing credentials => 401 with only the Auth check executed; valid control still served. Mutation S11 (bearer prefix check) survived as an equivalent mutant: a second guard (Auth getUser) fails closed.', lim + ' No live signed-JWT validation.', ['B35-MAND-1168/1169 are Production-gateway PASSes for malformed/tampered JWT; expired JWT had no record']);
cell('1170', PASS, 'Seven identity headers and userId/user_id/actorId body fields naming actor B with actor A token: refused on B session (404), served as A on A session, no downstream call carries B id. Mutations S1, S2 detected.', lim + ' Stub does not emulate RLS, so the handler-side ownership filter is what is observed.');
cell('1175', PASS, '500 chars accepted; 501, 5,000 and 500,000 => 400 before quota/provider. Mutation S3 detected.', lim + ' OBSERVATION: no raw byte cap in the handler (a 2 MB unknown field is parsed and ignored); the request-size bound is the platform gateway.');
cell('1176', PASS, 'Six homoglyph/zero-width/fullwidth variants of a valid sessionId => 400 with zero downstream calls. Mutation S4 detected.', lim + ' requestId/sourceMessageId are free text (80-char bounded) and not an authority.');
cell('1177', PASS, 'Traversal/query-injection shaped sessionId values => 400 before any query; no traversal sequence reaches a downstream URL. Mutation S4 detected.', lim + ' No file/storage path operation exists in the text-chat path; V2 attachment storage resolution not exercised.');
cell('1178', PASS, 'Six SSRF-shaped URLs injected into message, requestId, sourceMessageId, weather locale, every activeContext text field and unknown URL fields: outbound hosts limited to the Supabase fixture, Gemini and the fixed weather host.', lim + ' Server-side storage downloads for owned attachments and Open-Meteo responses not exercised. Not mutation-checked (no single guard to break).');
cell('1179', PASS, 'Delimiter-breaking injection in 10 model-bound fields: no [SYSTEM] header, markup or fences reach the system prompt; closed enum/number fields (gender, style signals, weather) have no free-text path; message stays in the user turn; hostile model output is stripped. Mutations S7, S10 detected.', lim + ' Proves prompt STRUCTURE only; obedience of a real model needs a paid provider (excluded), same as 0749. Free-text Closet/attachment fields not exercised.');
cell('1183', PASS, 'Same body under Content-Type image/png, multipart, text/plain, octet-stream and empty gives the identical outcome as the honest request.', lim);
cell('1185', PASS, 'Ten rapid requests: first 4 served, 6 denied with 429 + Retry-After 37; denied attempts reach neither the provider nor the daily quota; malformed limiter payload fails closed. Mutation S5 detected.', lim + ' The limiter itself (check_and_increment_stylechat_burst) is SQL and not exercised.');
cell('1188', PASS, 'Actor B token naming actor A session => 404, zero quota, zero provider; concurrent A/B requests never cross text or history queries.', lim + ' Client session-switch UX is a device/client concern. Mutation S2 detected.');
cell('1189', PASS, 'Slow A provider reply released after B completes: each reply returned only to its own request; no cross-actor text in provider requests.', lim + ' Client-side supersession (UI discarding a late reply) not exercised.');
cell('1190', PASS, 'Only module-level cache in the handler is weatherCache (rounded coordinates -> public weather). Actor A message and id never appear in actor B request; actor-scoped reads carry B id only.', lim + ' K+ entitlement and Signature Style caches belong to other lanes.');
cell('1191', PASS, 'Provider 500 => HTTP 200 status:error with the fixed fallback copy, no provider detail, 1 attempt, no write. Mutation S9 detected.', lim + ' OBSERVATION: the daily quota unit is reserved before the provider call and there is no refund RPC, so a failed generation still spends one daily message.');
cell('1192', PASS, 'Provider 429 (hostile Retry-After 9999) => same controlled fallback, 1 attempt (retry flag off), no write. Mutation S9 detected.', lim + ' Same quota observation as 1191.');
cell('1193', PASS, 'Provider that never answers is aborted by the attempt timeout (12 s scaled to 25 ms in the harness) => same controlled fallback, no hang. Mutation S9 detected.', lim + ' Same quota observation as 1191; real 12 s not waited.');
cell('1194', PASS, 'HTTP 200 non-JSON body => same controlled fallback; no raw text echoed. Mutation S9 detected.', lim + ' Same quota observation.');
cell('1195', PASS, 'HTTP 200 empty body => same controlled fallback. Mutation S9 detected.', lim + ' Same quota observation.');
cell('1196', PASS, 'Wrong-schema payloads (candidates not an array; parts with non-string text) => same controlled fallback. Mutation S9 detected.', lim + ' Same quota observation. Only the first-attempt variant was driven because one attempt is made.');
cell('1197', PASS, 'Auth ok then 401 on burst RPC or daily-quota RPC => 500 "Usage check failed", zero provider. Mutation S8 detected.', lim + ' OBSERVATION: a 401 on the session lookup is returned to the client as 404 "Session not found" (error and absence are not distinguished).');
cell('1203', PASS, 'Ten replays from a pending_deletion account => 403 ACCOUNT_PENDING_DELETION before consent, session, quota or provider; RPC lifecycle guard also yields 403. Mutation S6 detected.', lim + ' SQL deletion state machine is another lane.');
cell('1181', PASSA, 'The text-chat request has no byte-upload field: PNG bytes labelled jpeg, zero-byte and truncated image payloads placed in the chat request are rejected (400 ACTIVE_CONTEXT_INVALID) or dropped, and never forwarded to the provider.', 'Ruling needed: PASS-scoped vs N/A-by-construction. The real gap for byte-level cells is the server-side download of OWNED storage objects (attachment / visual-context pipeline), which is not exercised.');
cell('1182', PASSA, 'As 1181 for zero-byte/truncated payloads.', 'Same ruling and same server-side download gap as 1181.');

const ntWhy = {
  1163: ['Cat 4 (Staging fixture). Own-session success is shown by the harness control, but no signed live actor JWT exists. Supplementary only, no credit.', 'Needs Staging synthetic actor via a Codex-queued workflow.'],
  1164: ['Cat 4. Handler-level refusal of B on A session is shown (1188), but the cell requires a real two-actor Staging fixture with RLS. Supplementary only, no credit.', 'Needs two Staging actors.'],
  1165: ['Cat 4. The text-chat path touches no storage path; storage-path IDOR belongs to the attachment resolver, which is not exercised.', 'Needs the V2 attachment path with two Staging actors.'],
  1166: ['Cat 4. Shared-room membership resolution (fetchSharedRoomAccess) is behind sharedRoomEvidenceV1 and needs real membership rows.', 'Needs Staging rooms and flag state.'],
  1171: ['Feature-independent client-bundle control; only the response-side control was observed (no service-role or provider key in response/headers).', 'Needs one cross-feature client-bundle scan owner (same as 0741/2762).'],
  1180: ['OBSERVATION only. Flag off: no caller text reaches any RPC. With quotaIdempotencyV1 on, up to 80 chars of raw requestId are concatenated into p_operation_key and sent as a JSON-bound RPC parameter; whether the SQL function is injection-safe is unproven here.', 'Needs a real-Postgres proof of increment_stylechat_daily_usage_idempotent.'],
  1184: ['OBSERVATION only. With default flags ten concurrent identical requests spend ten quota units and ten provider calls; suppression exists only behind generationSafetyV1/quotaIdempotencyV1 in SQL.', 'Needs Production flag state and a real concurrent SQL run.'],
  1186: ['Cancel-then-reissue is client behaviour (AbortController in the StyleChat service); the server cannot observe a client cancel.', 'Client lane or device.'],
  1187: ['Navigate-away-and-return is client navigation behaviour.', 'Client lane or device.'],
  1200: ['Not attempted. K+ entitlement is consulted only behind closetWardrobeContextV1 (has_active_k_plus); stale-entitlement behaviour of that gate was not driven.', 'Could be added with the flag on and has_active_k_plus false/error.'],
  1202: ['Not attempted. Assistant persistence is server-side only behind generationSafetyV1 (persistAssistantOnce, SQL idempotency); with default flags the handler writes nothing.', 'Needs flag state and real SQL for idempotency.'],
  1204: ['Cat 4. The text-chat path issues no signed URLs; attachment signed-URL handling is not exercised.', 'Needs the V2 attachment path in Staging.'],
};
for (const [n, [why, gap]] of Object.entries(ntWhy)) cell(n, NT, why, gap);

const tally = (rows, pick) => rows.reduce((a, r) => ((a[pick(r)] = (a[pick(r)] || 0) + 1), a), {});
const cur = tally(matrix, (r) => r.verdict);
const cat = tally(matrix, (r) => r.coverageDisposition && r.coverageDisposition.category);
const prop = tally(cells, (c) => c.proposedDisposition);
const scRows = matrix.filter((m) => m.endpoint === 'function:stylechat-generate');
const scPending = scRows.filter((m) => m.verdict === 'NOT TESTED' && m.coverageDisposition.category !== 2).map((m) => m.probeId);
const ids = cells.map((c) => c.probeId);
if (new Set(ids).size !== ids.length) throw new Error('duplicate cell');
if (ids.length !== scPending.length || scPending.some((i) => !ids.includes(i))) throw new Error('coverage mismatch ' + ids.length + '/' + scPending.length);
for (const prior of [b1, b2]) if (cells.some((c) => prior.cells.some((x) => x.probeId === c.probeId))) throw new Error('overlap with prior batch');
const nPass = prop[PASS] || 0, nPassA = prop[PASSA] || 0;
const mk = (pass, na) => {
  const o = { PASS: cur.PASS + pass, FAIL: cur.FAIL, NOT_TESTED: cur['NOT TESTED'] - pass, total: matrix.length, naCategory2: cat[2] + na, deviceCategory6: cat[6] };
  o.applicablePending = o.NOT_TESTED - o.naCategory2;
  o.inScopeApplicablePending = o.applicablePending - o.deviceCategory6;
  if (o.PASS + o.FAIL + o.NOT_TESTED !== o.total) throw new Error('identity broken');
  return o;
};
const sum = (p, k) => (p.proposedBreakdown[k] || 0);
const priorPass = sum(b1, 'PASS (source harness, proposed)') + sum(b2, 'PASS (source harness, proposed)') + sum(b2, 'PASS (source harness, analog - needs Codex ruling)');
const priorNA = sum(b1, 'N/A (proposed, needs Codex ruling)') + sum(b2, 'N/A (proposed, needs Codex ruling)');

const out = {
  lane: 'A2 batch 3 (issue #702) - StyleChat (stylechat-generate)',
  mobileSourceSha: res.sourceSha,
  matrixSnapshot: 'PR #646 head 49ab7fada3639587911849080ff33c6ad17fd9df docs/release/evidence/mandatory-hostile-probes.json',
  fingerprintKind: 'git blob ids at the tested commit',
  sourceFingerprints: {
    'supabase/functions/stylechat-generate/index.ts': '29e39f3e61dd020c1813cbfc4a93fc74a497eb67',
    'supabase/functions/stylechat-generate/activeContext.ts': 'b901b938433b67130d991f89e63a2d2e01242122',
    'supabase/functions/stylechat-generate/promptHardening.ts': '728c250eee3897e6f9302b87a4f7a88589e1f859',
    'supabase/functions/stylechat-generate/eliseConfig.ts': 'b8aa49419176055668d0a60a30fbee2f88b09aa1',
    'supabase/functions/_shared/geminiConsent.ts': 'eb1a771388ae8819e2a941c0bb556fca1690b994',
    'supabase/functions/_shared/deletion/common.ts': '194f43281d3aea58da4e30e5284932836db06099',
  },
  rowsInScope: scRows.length,
  alreadyPass: scRows.filter((m) => m.verdict === 'PASS').map((m) => m.probeId),
  alreadyNA_cat2_not_reproposed: scRows.filter((m) => m.coverageDisposition.category === 2).map((m) => m.probeId),
  cellsEvaluated: cells.length,
  proposedBreakdown: prop,
  mutationControls: mut.muts,
  countsBefore: mk(0, 0),
  countsBatch3Alone: { allProposalsAccepted: mk(nPass + nPassA, 0), analogPassRejected_stays_NT: mk(nPass, 0) },
  countsCumulativeAllBatchesAccepted: mk(priorPass + nPass + nPassA, priorNA),
  cells,
  notCovered: 'style-outfit-generate (43 matrix rows, 37 pending) is a separate Edge function and was not touched. Packing (served by the same stylechat-generate index.ts under schemaVersion) belongs to Agent 7 and was not exercised: every request here is the ordinary chat path.',
  dedupe: 'Not additive with the 886 executed records (stylechat-generate holds B35-EXEC-0005/0027/0028/0217-0222: auth and body shape only; none overlap these cells), the 47 shared-handler or 46 K+ Staging records. 23 Deno test blocks evaluated 37 pending rows; only cells marked PASS change a verdict.',
};
fs.writeFileSync(__dirname + '/out/a2-batch3-ledger.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ prop, before: out.countsBefore, alone: out.countsBatch3Alone, cumulative: out.countsCumulativeAllBatchesAccepted }));
