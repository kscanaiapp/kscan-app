// Builds audit/a2/out/a2-batch2-ledger.json (Live Camera VTO, 43 cells) from the harness results + the retained matrix snapshot.
// Usage: node audit/a2/build-ledger-batch2.cjs <path to mandatory-hostile-probes.json from PR #646 head 49ab7fad>
const fs = require('fs');
const matrix = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const res = JSON.parse(fs.readFileSync(__dirname + '/out/live-batch2-results.json', 'utf8'));
const b1 = JSON.parse(fs.readFileSync(__dirname + '/out/a2-batch1-ledger.json', 'utf8'));
const byId = {};
for (const r of res.results) byId[r.probeId] = r;

const PASS = 'PASS (source harness, proposed)';
const PASSA = 'PASS (source harness, analog - needs Codex ruling)';
const NA = 'N/A (proposed, needs Codex ruling)';
const NT = 'NOT TESTED (kept)';
const DEV = 'NOT TESTED (kept, device-excluded cat 6 - untouched)';
const SRC = 'audit/a2/live-remote-source-1102.test.cjs';
const mut = 'audit/a2/out/live-batch2-mutations.md';
const rec = (id) => (byId[id] ? 'audit/a2/out/live-batch2-results.json#' + id : null);
const cell = (id, disposition, why, remaining, evidence, overlap) => {
  const m = matrix.find((x) => x.probeId === id);
  if (!m) throw new Error('no matrix row ' + id);
  if (m.verdict !== 'NOT TESTED') throw new Error('cell not outstanding: ' + id);
  return { probeId: id, probe: m.probe, currentVerdict: m.verdict, currentCategory: m.coverageDisposition.category, proposedDisposition: disposition, rationale: why, evidence: evidence || null, overlapRefs: overlap || [], remainingGap: remaining || null };
};
const remote = (id, srcId, label) => cell('B35-MAND-' + id, PASSA,
  'Real getVtoRemoteConfig/availability/resolver over a faulted app_config read (' + label + '); Live is never offered and native is never dispatched. Retained B35-LIVE-SRC-' + srcId + ' re-run at the current head (56/56) and mutation-checked here.',
  'Live has no provider or endpoint (on-device camera). The only remote dependency is the app_config availability read, so this is the closest honest analog of "provider ' + label + '". Ruling needed: PASS-scoped vs N/A. Mock config reader, not a live Supabase.',
  SRC + ' (B35-LIVE-SRC-' + srcId + '); ' + mut,
  ['B35-LIVE-SRC-' + srcId + ' in live-source-executed-probes-1102.json is the retained PR #646 record of the same test; same source family, not additive']);

const cells = [
  cell('B35-MAND-2775', PASS, 'Ten concurrent enterLive() during one permission dialog: one prompt, one controller, one native start; ten concurrent photoreal requests: one capture and one adoption; all controllers disposed.', 'Real hook with injected native/permission/sanitizer fakes; not a device.', rec('B35-MAND-2775'), ['Retained HA-002/HA-003 cover 2-3 taps; this extends to 10']),
  cell('B35-MAND-2776', PASS, 'Ten rapid sequential taps, ten after a denial, ten enter/exit cycles within one second: one controller, none after denial, <=1 live controller across cycles, all disposed.', 'Rate-limit semantics do not exist for an on-device camera; proves no resource amplification only. Ask-once-after-denial of the real permission module is faked.', rec('B35-MAND-2776')),
  cell('B35-MAND-2791', PASS, 'Every stale/expired/unknown entitlement state through the real mapping and the real Studio gate: Live is offered only for member; stale never grants. Mutations L6/L7 detected.', 'Derivation stale->expired lives in useKPlusEntitlement (K+ lane) and is stubbed; no RevenueCat or network.', rec('B35-MAND-2791') + ' + ' + rec('B35-MAND-2791-COMPOSITION')),
  cell('B35-MAND-2767', PASS, 'Cyrillic/fullwidth/zero-width/combining homoglyph garment identifiers and URLs never resolve ELIGIBLE; the exact pilot URLs still do (control). Mutation L5 detected.', 'Governed pilot registry only; Photo/commerce identifier handling belongs to other lanes.', rec('B35-MAND-2767')),
  cell('B35-MAND-2768', PASS, 'Path-traversal, encoded traversal and query/fragment tricks against the governed asset URL are refused.', 'Resolver only; post-resolution product-URL opening (openPersistedCommerceUrl) is a Commerce-lane boundary, not exercised.', rec('B35-MAND-2768')),
  cell('B35-MAND-2769', PASS, 'Metadata (169.254.169.254), localhost, file:, gopher:, userinfo and DNS-rebind-shaped hosts are refused by the asset-selection boundary; the Live source graph issues no outbound request.', 'Does not cover native image decode or remote fetch inside the native module.', rec('B35-MAND-2769') + ' + ' + rec('STATIC-LIVE-SURFACE')),
  remote('2782', '033', '500'),
  remote('2783', '034', '429'),
  remote('2784', '039', 'timeout'),
  remote('2785', '037', 'malformed JSON'),
  remote('2786', '036', 'empty body'),
  remote('2787', '038', 'wrong schema'),
  remote('2788', '035', 'Supabase 401'),
];

const naStatic = 'Static scan of the 17 Live-named JS/TS source files (STATIC-LIVE-SURFACE) finds no fetch/XHR/WebSocket/functions.invoke/rpc/supabase/storage/axios; the only outbound-capable call is user-initiated Linking in the pilot product card.';
const defGap = 'Ruling needed (N/A by construction). Caveat: the shared availability read and K+ entitlement are other lanes\' surfaces.';
const na = (id, why, gap) => cell('B35-MAND-' + id, NA, why + ' ' + naStatic, gap || defGap, rec('STATIC-LIVE-SURFACE'));
cells.push(
  na('2753', 'Live exposes no endpoint, so there is no anonymous-caller request to make; the Studio gate hides Live from anonymous actors (retained B35-LIVE-SRC-029/030).'),
  na('2754', 'No user-owned resource: Live persists nothing and addresses no resource id.'),
  na('2755', 'No resource id parameter exists to substitute (IDOR requires an addressable resource).'),
  na('2756', 'No storage path input or storage client in the Live graph.'),
  na('2757', 'No shared-room or room-member concept in the Live graph (grep for room/storage/persistence terms: no hits).'),
  na('2758', 'No JWT is parsed or sent by Live code; the only authenticated call is the shared app_config read (Supabase client). Production-gateway JWT PASSes already exist as B35-MAND-0738/0739.', 'Ruling needed. Caveat: shared Supabase client auth is another lane.'),
  na('2759', 'As 2758.', 'Ruling needed. Caveat as 2758.'),
  na('2760', 'As 2758.', 'Ruling needed. Caveat as 2758.'),
  na('2761', 'No in-function auth exists; Live runs on-device and reads no caller-controlled header.'),
  na('2763', 'Live has no request body to send empty.'),
  na('2764', 'Live has no request body to send null.'),
  na('2765', 'Live has no JSON request body. (Malformed JSON in the app_config RESPONSE is covered by 2785.)'),
  na('2766', 'Live has no request body to oversize.'),
  na('2770', 'Live has no model, prompt or model-field input; garment data is a closed governed registry.'),
  na('2771', 'Live issues no RPC; there are no RPC parameters to inject into.'),
  na('2790', 'Live has no speech or voice surface (grep for speech/voice/elevenlabs over the Live JS/TS graph: no hits). Frame timestamps in native code are pose-frame times, not speech.', 'Ruling needed. Speech belongs to Elise/StyleChat.'),
  na('2792', 'Live has no purchase, entitlement-grant or webhook handler; it only consumes the canonical entitlement state (2791).', 'Ruling needed. Webhook replay belongs to the K+ lane.'),
  na('2793', 'Live saves nothing (no persistence terms in the Live graph), so there is no save to replay.'),
  na('2794', 'Live stores no record, so there is no deletion to replay.'),
  na('2795', 'Live issues and accepts no signed URLs (static scan: no storage client / createSignedUrl).'),
);

const nt = (id, why, gap) => cell('B35-MAND-' + id, NT, why, gap);
cells.push(
  nt('2762', 'Feature-independent control (client bundle must not contain the service-role key); not attributable to Live.', 'Needs one cross-feature client-bundle scan owner (same as 0741).'),
  nt('2772', 'Live neither accepts nor validates image bytes; the captured frame is handed to the Photo sanitizer (other lane). Live-side refusal is exercised only with an injected sanitizer fake (B35-LIVE-SRC-011/023).', 'Belongs to the Photo/sanitizer lane.'),
  nt('2773', 'As 2772.', 'Belongs to the Photo/sanitizer lane.'),
  nt('2774', 'As 2772; Live sends no Content-Type.', 'Belongs to the Photo/sanitizer lane; could be N/A for Live alone - ruling item.'),
  nt('2781', 'Live files hold no cache. The shared config memo in vtoFeatureControl is process-global app_config (not actor-scoped); actor scoping of the entitlement read is in the K+ lane. Not tested here.', 'Needs the K+ entitlement cache cell owner.'),
  nt('2789', 'No test hangs the secondary discovery read (resolveVtoActorKPlusState). The config-read timeout (2784) is a different read.', 'Could be added: hang the discovery read and assert Studio shows no Live.'),
);
for (const id of ['2777', '2778', '2779', '2780']) {
  cells.push(cell('B35-MAND-' + id, DEV, 'Device cell (category 6). Source-level fences exist (retained B35-LIVE-SRC-007/012/019/024 for late-start and late-capture discards) but there is no physical/signed-app run, so no credit is proposed.', 'Needs a signed test app and device.', null, ['B35-LIVE-SRC-007/012/019/024 are source fences, not the device cell']));
}

const tally = (rows, pick) => rows.reduce((a, r) => ((a[pick(r)] = (a[pick(r)] || 0) + 1), a), {});
const cur = tally(matrix, (r) => r.verdict);
const cat = tally(matrix, (r) => r.coverageDisposition && r.coverageDisposition.category);
const prop = tally(cells, (c) => c.proposedDisposition);
const liveAll = matrix.filter((m) => m.feature === 'Live Camera VTO').map((m) => m.probeId);
const ids = cells.map((c) => c.probeId);
if (new Set(ids).size !== ids.length) throw new Error('duplicate cell');
if (ids.length !== liveAll.length || liveAll.some((i) => !ids.includes(i))) throw new Error('Live cell coverage mismatch ' + ids.length + '/' + liveAll.length);
for (const c of cells) if (c.currentCategory === 2) throw new Error('already N/A: ' + c.probeId);
const nPass = prop[PASS] || 0, nPassA = prop[PASSA] || 0, nNA = prop[NA] || 0;
const mk = (pass, na) => {
  const o = { PASS: cur.PASS + pass, FAIL: cur.FAIL, NOT_TESTED: cur['NOT TESTED'] - pass, total: matrix.length, naCategory2: cat[2] + na, deviceCategory6: cat[6] };
  o.applicablePending = o.NOT_TESTED - o.naCategory2;
  o.inScopeApplicablePending = o.applicablePending - o.deviceCategory6;
  if (o.PASS + o.FAIL + o.NOT_TESTED !== o.total) throw new Error('identity broken');
  return o;
};
const b1Pass = b1.proposedBreakdown['PASS (source harness, proposed)'];
const b1NA = b1.proposedBreakdown['N/A (proposed, needs Codex ruling)'];
if (cells.some((c) => b1.cells.some((x) => x.probeId === c.probeId))) throw new Error('overlap with batch 1');

const out = {
  lane: 'A2 batch 2 (issue #702) - Live Camera VTO',
  mobileSourceSha: res.sourceSha,
  matrixSnapshot: 'PR #646 head 49ab7fada3639587911849080ff33c6ad17fd9df docs/release/evidence/mandatory-hostile-probes.json',
  fingerprintKind: 'git blob ids at the tested commit',
  sourceFingerprints: {
    'services/vto/vtoFeatureControl.ts': 'ad7daced6b9bff88bf822d1f9f260653548de020',
    'services/vto/vtoLiveGarmentRegistry.ts': 'b0b5ec5efa589a88c379ead9d0e1ef0843f626e8',
    'services/vto/vtoLiveGarment.ts': '5fe4f4187310941910b6aeb7a48252dfad1c2182',
    'services/vto/vtoStudio.ts': '5201340e85b5844ca12001a1bf3954f3b52334b8',
    'services/vto/vtoDiscovery.ts': '37eb333312d023e18b38d74a90f5bf6f6f125eec',
    'hooks/useVtoLiveSession.ts': '47ff980acc9a01211701041a654c02dec8efc40b',
    'hooks/useVtoAvailability.ts': 'f901afb62dcac440675e7179c481a79cc384e59c',
  },
  cellsEvaluated: cells.length,
  proposedBreakdown: prop,
  countsBefore: mk(0, 0),
  countsBatch2Alone: {
    allProposalsAccepted: mk(nPass + nPassA, nNA),
    analogPassRejected_stays_NT: mk(nPass, nNA),
    onlyFirmPass_noNA: mk(nPass, 0),
  },
  countsCumulativeWithBatch1AllAccepted: mk(nPass + nPassA + b1Pass, nNA + b1NA),
  cells,
  dedupe: 'Not additive with the 886 executed records, 47 shared-handler or 46 K+ Staging records, nor with the 40 retained B35-LIVE-SRC records (same source family). 9 node:test blocks here plus the 10 retained remote tests evaluate 43 cells; only cells marked PASS change a verdict.',
};
fs.writeFileSync(__dirname + '/out/a2-batch2-ledger.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ prop, before: out.countsBefore, alone: out.countsBatch2Alone, cumulative: out.countsCumulativeWithBatch1AllAccepted }, null, 1));
