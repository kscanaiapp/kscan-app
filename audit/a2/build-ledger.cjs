// Builds audit/a2/out/a2-batch1-ledger.json from the Deno results + the retained matrix snapshot.
// Usage: node audit/a2/build-ledger.cjs <path to mandatory-hostile-probes.json from PR #646 head 49ab7fad>
const fs = require('fs');
const matrix = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const res = JSON.parse(fs.readFileSync(__dirname + '/out/receipt-batch1-results.json', 'utf8'));
const byId = {};
for (const r of res.results) byId[r.probeId] = r;

const overlap = {
  'B35-MAND-0745': ['B35-EXEC-0586 hit the 2MB image bound (image_size branch), not the body_size branch; no credit shared'],
  'B35-MAND-0747': ['B35-EXEC-0586 requestId "../../etc" (one value); this adds 4 more shapes + request-URL inertness'],
  'B35-MAND-0751': ['B35-EXEC-0586 PNG prefix (one value); this adds gif/pdf/webp/html/zip + caller mime claim'],
  'B35-MAND-0761': ['B35-EXEC-0588 (503 transient) exercises the same retry branch; status differs (500)'],
  'B35-MAND-0764': ['B35-EXEC-0592 sanitize-level malformed envelope; this is handler-level incl. billing side effect'],
  'B35-MAND-0766': ['B35-EXEC-0592 (unit), B35-EXEC-0591 (enum collapse)'],
  'B35-MAND-0767': ['B35-EXEC-0587 uses reserve=>null stub; this drives the REAL default reserve adapter with a 401 transport'],
  'B35-MAND-0737': ['B35-MAND-0738/0739 are Production-gateway PASSes for malformed/tampered JWT; expired JWT had no executed record'],
  'B35-MAND-0733': ['continuation-f025-boundary-reconciliation-1102.json notMapped (kept NOT TESTED)'],
  'B35-MAND-0755': ['continuation-f025-boundary-reconciliation-1102.json notMapped (kept NOT TESTED)'],
};
const PASS = 'PASS (source harness, proposed)';
const NA = 'N/A (proposed, needs Codex ruling)';
const NT = 'NOT TESTED (kept)';
const ref = (id) => 'audit/a2/out/receipt-batch1-results.json#' + id;
const L = (id, disposition, why, remaining, hasRecord = true) => {
  const m = matrix.find((x) => x.probeId === id);
  if (!m) throw new Error('no matrix row ' + id);
  const r = byId[id];
  if (hasRecord && !r) throw new Error('no harness record ' + id);
  return {
    probeId: id,
    feature: m.feature,
    probe: m.probe,
    currentVerdict: m.verdict,
    currentCategory: m.coverageDisposition && m.coverageDisposition.category,
    proposedDisposition: disposition,
    rationale: why,
    evidence: r ? ref(id) : null,
    harnessVerdict: r ? r.verdict : null,
    overlapRefs: overlap[id] || [],
    remainingGap: remaining || null,
  };
};
const cells = [
  L('B35-MAND-0737', PASS, 'Real requireUser + stubbed Auth server rejects expired/non-bearer/empty/missing credentials with 401 and zero side effects; valid control reserves as actor A.', 'Stubbed Auth server: no live signed-JWT validation.'),
  L('B35-MAND-0740', PASS, 'Identity-spoof headers/body fields naming actor B never change reserve/settle actor (A) nor reach provider payload; mutation M6 (header-sourced actor) is detected.', 'Stubbed Auth server.'),
  L('B35-MAND-0745', PASS, 'Body 10x MAX_BODY_CHARS => 413 before any side effect; control request still 200. Mutation M1 (guard removed) detected.', 'Handler cap only; gateway cap not exercised.'),
  L('B35-MAND-0746', PASS, 'Cyrillic/fullwidth/zero-width identifiers and homoglyph contract/tier values all 400 with zero side effects. Mutation M4 detected.', null),
  L('B35-MAND-0747', PASS, 'Five traversal-shaped requestIds 400; traversal in request URL path/query is inert. Mutation M4 detected.', 'No file/path operation exists; proves identifier allowlist + URL inertness.'),
  L('B35-MAND-0750', PASS, 'Metacharacter requestIds rejected before any RPC; real default reserve adapter sends only server UUID + SHA-256 digest, never the caller identifier. Mutation M4 detected.', 'Settle RPC params not re-driven (server-derived); PGlite SQL coverage lives in retained F025 evidence.'),
  L('B35-MAND-0751', PASS, 'png/gif/pdf/webp/html/zip payloads with caller mime claim => 400, provider never sees them. Mutation M2 detected.', 'Magic-byte prefix only.'),
  L('B35-MAND-0753', PASS, 'Request Content-Type is not authority (4 lying values processed identically, provider mime fixed image/jpeg); PNG under image/jpeg header still refused. Mutation M2 detected.', null),
  L('B35-MAND-0761', PASS, 'Provider 500 => 503 provider_unavailable, <=2 attempts, released not billed, secret provider text not echoed. Mutation M3 (always billable) detected.', 'Mock provider.'),
  L('B35-MAND-0762', PASS, 'Provider 429 (transient + quota wording, hostile Retry-After 9999) => controlled 503, <=2 attempts, backoff <=30s, released. Mutation M3 detected.', 'Mock provider.'),
  L('B35-MAND-0763', PASS, 'Non-answering provider aborted by attempt timeout, <=2 attempts, 503, released, no hang. Mutation M3 detected.', '25ms test timeout; production constant 18000ms not waited.'),
  L('B35-MAND-0764', PASS, 'HTTP 200 with truncated outer JSON or prose inner text => 502 schema_validation_failed, no partial items.', 'OBSERVATION: unusable provider output is settled billable=true (completed, not released). Flag for owner; not asserted as defect.'),
  L('B35-MAND-0765', PASS, 'Five empty provider shapes (empty string, {}, no candidates, empty parts, blank text) all 502 schema_validation_failed, never empty-success.', 'Same billable=true observation as 0764.'),
  L('B35-MAND-0766', PASS, 'Seven wrong-schema payloads => 502 no items; item-level garbage cannot add foreign keys or out-of-enum values.', 'OBSERVATION: non-object entries in items[] become confidence-0 placeholder rows with ok:true; downstream must filter on confidence.'),
  L('B35-MAND-0767', PASS, 'Real default reserve adapter receives 401 PGRST301 => fail closed 503, zero provider dispatch, no backend detail leaked. Mutation M5 (fail open) detected.', 'Transport stub; 401 on the SETTLE leg after dispatch not exercised (settle failures are swallowed by design).'),
  L('B35-MAND-0748', NA, 'Request contract has no caller-controlled outbound target; URL-valued extra fields never reach provider body; handler has exactly one fetch to the fixed Gemini base.', 'Ruling needed: N/A-by-construction vs PASS.'),
  L('B35-MAND-0734', NA, 'Static scan: no caller-addressable resource id, table access or storage; actor-scoped fingerprint differs for the same session id across actors (behavioural companion).', 'Ruling needed.'),
  L('B35-MAND-0735', NA, 'Static scan: no storage path input, no storage client, no signed-URL code.', 'Ruling needed.'),
  L('B35-MAND-0736', NA, 'Static scan: no shared-room/room-member concept in handler/extraction/sensitive.', 'Ruling needed.'),
  L('B35-MAND-0770', NA, 'Static scan: no entitlement/RevenueCat/K+ dependency in the route; receipt decision log has no K+ gating requirement.', 'CONDITIONAL on owner confirming Receipt is intentionally not entitlement-gated; if gating is intended, its absence is a finding, not N/A.'),
  L('B35-MAND-0772', NA, 'Handler header declares no persistence; static scan found no insert/upsert/update/delete/write.', 'Ruling needed. Client-side save of extracted items belongs to a different lane.'),
  L('B35-MAND-0773', NA, 'Route stores no record; only the account-active guard touches deletion state.', 'Ruling needed; deletion-cycle work is deferred by owner scope.'),
  L('B35-MAND-0774', NA, 'Route issues and accepts no signed URLs (static scan).', 'Ruling needed.'),
  L('B35-MAND-0749', NT, 'Output containment proven (text bounded, enums collapse, no structure/authority change) but whether the real model obeys instructions printed on a receipt image needs a paid provider (excluded).', 'Needs authorized real-provider injection fixture.'),
  L('B35-MAND-0752', NT, 'Structural invalid images (empty/prefix-only/odd-length/non-base64) refused 400, but corrupted bytes behind a valid /9j/ prefix reach the paid provider; real provider behaviour untested.', 'Needs provider-side corrupt-image fixture, or owner ruling that structural validation suffices.'),
  L('B35-MAND-0733', NT, 'Own-actor baseline passes with synthetic identity but no signed live User A JWT/authorized fixture exists (as already recorded by F025 reconciliation).', 'Needs Staging synthetic actor via Codex-queued workflow.', false),
  L('B35-MAND-0741', NT, 'Feature-independent control (client bundle must not contain the service-role key); not attributable to this route. Within the route, service role is used only in settle with a server-derived actor, but that is not the cell as written.', 'Needs one cross-feature client-bundle scan owner.', false),
  L('B35-MAND-0755', NT, 'F025 tests launch 10 in-flight retries but do not measure a one-second dispatch window; no new timing harness in this batch.', 'Needs real concurrent quota SQL (independent connections) or owner-accepted fake-clock equivalent.', false),
];

const tally = (rows, pick) => rows.reduce((a, r) => ((a[pick(r)] = (a[pick(r)] || 0) + 1), a), {});
const cur = tally(matrix, (r) => r.verdict);
const cat = tally(matrix, (r) => r.coverageDisposition && r.coverageDisposition.category);
const prop = tally(cells, (c) => c.proposedDisposition);
const nPass = prop[PASS] || 0;
const nNA = prop[NA] || 0;
const before = { PASS: cur.PASS, FAIL: cur.FAIL, NOT_TESTED: cur['NOT TESTED'], total: matrix.length, naCategory2: cat[2], deviceCategory6: cat[6] };
before.applicablePending = before.NOT_TESTED - before.naCategory2;
before.inScopeApplicablePending = before.applicablePending - before.deviceCategory6;
const after = {
  PASS: before.PASS + nPass,
  FAIL: before.FAIL,
  NOT_TESTED: before.NOT_TESTED - nPass,
  total: matrix.length,
  naCategory2: before.naCategory2 + nNA,
  deviceCategory6: before.deviceCategory6,
};
after.applicablePending = after.NOT_TESTED - after.naCategory2;
after.inScopeApplicablePending = after.applicablePending - after.deviceCategory6;
if (before.PASS + before.FAIL + before.NOT_TESTED !== before.total) throw new Error('before identity broken');
if (after.PASS + after.FAIL + after.NOT_TESTED !== after.total) throw new Error('after identity broken');
const ids = cells.map((c) => c.probeId);
if (new Set(ids).size !== ids.length) throw new Error('duplicate cell');
for (const c of cells) if (c.currentVerdict !== 'NOT TESTED') throw new Error('cell not outstanding: ' + c.probeId);

const out = {
  lane: 'A2 batch 1 (issue #702)',
  mobileSourceSha: '2c2c9da41121daa43f4f657ca1aaa2fcf7b7cb27',
  matrixSnapshot: 'PR #646 head 49ab7fada3639587911849080ff33c6ad17fd9df docs/release/evidence/mandatory-hostile-probes.json',
  sourceFingerprints: {
    'supabase/functions/purchase-import-extract/handler.ts': '23bba52e7b67aa4ce68ecd8c63d622efc609cd46',
    'supabase/functions/purchase-import-extract/extraction.ts': '2e94697463cca6d807e5578609a0d6bc161d4855',
    'supabase/functions/purchase-import-extract/sensitive.ts': '2e50519c6ccbafaf816309e64a2d17bed74812c5',
    'supabase/functions/purchase-import-extract/index.ts': '47fcd33ceda99ee50bd871b4b9c166d347bd63a4',
  },
  fingerprintKind: 'git blob ids at the tested commit',
  cellsEvaluated: cells.length,
  proposedBreakdown: prop,
  countsBefore: before,
  countsIfAllProposalsAccepted: after,
  cells,
  dedupe: 'Not additive with the 886 executed records, the 47 shared-handler or 46 K+ Staging records. 19 Deno test blocks evaluated 28 matrix cells; only cells marked PASS (source harness, proposed) would change a matrix verdict. No suite totals are counted.',
};
fs.writeFileSync(__dirname + '/out/a2-batch1-ledger.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ prop, before, after }, null, 1));
