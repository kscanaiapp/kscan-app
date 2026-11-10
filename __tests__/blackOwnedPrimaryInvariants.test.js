const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const baseline = require('../config/black-owned-discovery-primary-baseline.json');
const vriApproval = require('../config/vri03-primary-integrity-approval.json');
const bobseApproval = require('../config/bobse-primary-integrity-approval.json');
const scanner612Approval = require('../config/scanner-612-primary-integrity-approval.json');
const digest = (source) => crypto.createHash('sha256').update(source).digest('hex');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

/**
 * #612 is an additive record chained AFTER BOBSE. Reversing exactly its listed
 * edits (each must occur once) must reproduce the BOBSE-pinned bytes, so the
 * exception cannot hide any other change to the primary Scanner entrypoint.
 */
function stripScanner612(file, source) {
  const record = scanner612Approval.approvedFiles[file];
  if (!record) return source;
  let out = source;
  for (const edit of record.edits) {
    assert.equal(out.split(edit.to).length - 1, 1, '#612 edit must occur exactly once: ' + file);
    out = out.replace(edit.to, edit.from);
  }
  return out;
}

/**
 * The original secondary-discovery baseline is IMMUTABLE. H1-H4b are separately
 * approved scanner improvements, so only their exact source digests may differ.
 * BOBSE's explicitly requested ordinary-search integration has a separate
 * exact-digest record. Neither historical nor VRI-03 snapshots are rewritten.
 * Any edit outside those three named files still fails against the original pin.
 */
test('Black-owned baseline remains pinned; VRI-03 scanner exceptions are byte-exact and named', () => {
  const allowed = [
    'supabase/functions/scan-identify/index.ts',
    'supabase/functions/scan-identify/scanCommerceRouter.ts',
  ];
  assert.deepEqual(Object.keys(vriApproval.approvedFiles).sort(), allowed.sort());
  assert.equal(vriApproval.baseCommit, 'dd82d40d99a885d163c859a462c7bc30f9755eaf');
  assert.equal(bobseApproval.baseCommit, '4a832287f291086f600cf7411343ae5554cbf344');
  assert.equal(scanner612Approval.baseCommit, '233e2b33bdb1b1d3538094b5d3a7894ef673f996');
  assert.deepEqual(Object.keys(scanner612Approval.approvedFiles), ['supabase/functions/scan-identify/index.ts']);
  assert.deepEqual(Object.keys(bobseApproval.approvedFiles).sort(), [
    'supabase/functions/scan-identify/index.ts',
    'supabase/functions/scan-identify/scanCommerceRouter.ts',
    'supabase/functions/scan-identify/shoppingProvider.ts',
  ].sort());
  for (const [file, historicalHash] of Object.entries(baseline.files)) {
    const source = read(file);
    const entry = vriApproval.approvedFiles[file];
    const expansion = bobseApproval.approvedFiles[file];
    if (entry) {
      assert.equal(entry.historicalSha256, historicalHash, 'historical baseline must remain immutable: ' + file);
    }
    const scanner612 = scanner612Approval.approvedFiles[file];
    if (expansion) {
      assert.equal(expansion.priorSha256, entry?.vri03Sha256 ?? historicalHash, 'prior approved primary snapshot must remain pinned: ' + file);
      if (scanner612) {
        assert.equal(scanner612.priorSha256, expansion.bobseSha256, '#612 must chain from the BOBSE snapshot: ' + file);
        assert.equal(digest(source), scanner612.approvedSha256, 'unapproved #612 Scanner source drift: ' + file);
        assert.equal(digest(stripScanner612(file, source)), expansion.bobseSha256, '#612 record hides additional edits: ' + file);
        assert.ok(scanner612.reason.length > 40);
      } else {
        assert.equal(digest(source), expansion.bobseSha256, 'unapproved ordinary-source integration drift: ' + file);
      }
      assert.ok(expansion.reason.length > 40);
    } else if (entry) {
      assert.equal(digest(source), entry.vri03Sha256, 'unapproved VRI-03 scanner source drift: ' + file);
    } else {
      assert.equal(digest(source), historicalHash, file);
    }
    assert.equal(source.includes('black-owned-discovery'), false, 'secondary discovery directly integrated into primary: ' + file);
  }
});

test('secondary source has no model or scan-image integration and sponsorship has no organic callers',()=>{
  const dir=path.join(root,'supabase/functions/black-owned-discovery');
  for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.ts')&&!f.endsWith('.test.ts'))){
    const source=fs.readFileSync(path.join(dir,file),'utf8');
    assert.doesNotMatch(source,/from\s+['"][^'"]*(?:gemini|genai|paidProvider|safeRemoteMedia)/i,file);
    if(file==='engine.ts')assert.equal(source.includes("from './sponsorshipPolicy"),false,file);
  }
});


test('consent promotion stays byte-pinned with explicitly approved VRI-03 additions', () => {
  const source = read('supabase/functions/scan-identify/index.ts');
  const original = source
    .replace("import { requireGeminiConsent } from '../_shared/geminiConsent.ts';\n", '')
    .replace('  const consentGate = await requireGeminiConsent(userId);\n  if (consentGate) return consentGate;\n\n', '');
  assert.notEqual(original, source, 'the actor consent prerequisite must still exist');
  assert.equal(
    vriApproval.consentPromotion.historicalPriorEntrypointSha256,
    baseline.consentAuthorityPromotion.priorScanEntrypointDigest,
    'historical consent snapshot must remain immutable',
  );
  assert.equal(bobseApproval.consentPromotion.priorConsentStrippedSha256, vriApproval.consentPromotion.vri03ConsentStrippedSha256);
  assert.equal(scanner612Approval.consentPromotion.priorConsentStrippedSha256, bobseApproval.consentPromotion.bobseConsentStrippedSha256);
  assert.equal(digest(original), scanner612Approval.consentPromotion.approvedConsentStrippedSha256);
  assert.equal(
    digest(stripScanner612('supabase/functions/scan-identify/index.ts', original)),
    bobseApproval.consentPromotion.bobseConsentStrippedSha256,
    'the BOBSE consent snapshot must remain reproducible after reversing #612',
  );

  // These controls supplement, rather than substitute for, the VRI-03 flag-OFF
  // equivalence, no-fabrication and merchant-eligibility runtime tests.
  const flags = read('supabase/functions/_shared/vri03/scanImprovementsFlag.ts');
  assert.match(source, /const vri03 = resolveVri03Flags\(/);
  assert.match(source, /cohortKey: auth\.isAuthenticated && !auth\.isAnonymous \? userId : null/);
  assert.match(flags, /const inCohort = masterEnabled && cohortBucket !== null && cohortBucket < cohortPercent/);
  assert.match(flags, /subFlags\[sub\] = inCohort && strictTrue\(envGet\(VRI03_SUB_FLAG_ENV\[sub\]\)\)/);
  assert.equal(source.includes("from '../_shared/vri03/scanImprovementsFlag.ts'"), true);
});
