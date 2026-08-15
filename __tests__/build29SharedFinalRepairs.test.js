/**
 * Build 29 — final bounded shared P2–P5 repairs.
 *
 * One file per pass rather than per defect: these are small, independent
 * repairs authorised together, and keeping their guards adjacent makes it
 * obvious what the pass was allowed to touch. Each block states the behaviour
 * that regressed, not merely the symbol that changed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      exports: module.exports,
      module,
      // The sandbox is a fresh realm with no web globals of its own. URL
      // parsing IS the logic under test here, so it has to be provided —
      // without it every input throws and the guard would pass vacuously.
      URL,
      URLSearchParams,
      console,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

// ── DEF-017 — the match badge must render ─────────────────────────────────

test('DEF-017: the view model reads the field the scan pipeline actually writes', () => {
  const types = read('components/scan-results/types.ts');
  const mapper = read('services/scanIdentificationMapper.ts');

  // The producer side is the authority for the field name.
  assert.match(mapper, /meta\.confidenceScore = conf/, 'producer still writes confidenceScore');

  const block = types.slice(types.indexOf('confidence:'), types.indexOf('styleTags: meta.styleTags'));
  assert.match(block, /meta\.confidenceScore/, 'the live field must be read');
  assert.match(block, /meta\.confidence\b/, 'the legacy field must remain a fallback');
  assert.ok(
    block.indexOf('meta.confidenceScore') < block.indexOf('meta.confidence '),
    'the live field must take precedence over the legacy one',
  );
  // The type must admit the live field, or the mismatch can silently return.
  assert.match(read('components/scan-results/types.ts'), /confidenceScore\?: number;/);
});

// ── DEF-010 — the commerce kill switch must reach the shipping surface ────

test('DEF-010: Scan Result V2 gates both commerce shelves on the freeze', () => {
  const v2 = read('components/scan-results/ScanResultV2.tsx');

  assert.match(v2, /useFeatureFreeze/, 'V2 must consult the freeze');
  assert.match(
    v2,
    /priceDiscoveryEnabled = !featureFreezeLoading && isFeatureEnabled\('priceDiscovery'\)/,
    'derivation must match AnalysisCard, including treating loading as OFF',
  );
  assert.match(v2, /\{priceDiscoveryEnabled && hasRenderableSimilarFinds \?/, 'similar finds gated');
  assert.match(v2, /\{priceDiscoveryEnabled\s*\n\s*&& Array\.isArray\(v2Data\.purchaseOptions\)/, 'purchase options gated');
});

test('DEF-010: a freeze cannot be briefly ignored on first paint', () => {
  const v2 = read('components/scan-results/ScanResultV2.tsx');
  // `!featureFreezeLoading &&` is what makes the loading state resolve to OFF.
  assert.ok(
    !/isFeatureEnabled\('priceDiscovery'\)(?!.*featureFreezeLoading)/.test(
      v2.replace(/\n/g, ' '),
    ) || /!featureFreezeLoading && isFeatureEnabled\('priceDiscovery'\)/.test(v2),
    'the freeze must be treated as ON while its config is loading',
  );
});

// ── DEF-030 — owner resolution failure must not remove Report/Block ───────

test('DEF-030: the panel latches the owner id from the access call it already makes', () => {
  const panel = read('components/rooms/RoomMessagesPanel.tsx');

  assert.match(panel, /const \[resolvedOwnerId, setResolvedOwnerId\]/, 'a latch must exist');
  assert.match(panel, /const effectiveOwnerId = roomOwnerId \?\? resolvedOwnerId/, 'prop wins, latch backs it');
  assert.match(
    panel,
    /access\.currentOwnerId[\s\S]{0,120}setResolvedOwnerId\(access\.currentOwnerId\)/,
    'revalidateAccess must stop discarding currentOwnerId',
  );
});

test('DEF-030: every owner consumer uses the effective id, not the raw prop', () => {
  const panel = read('components/rooms/RoomMessagesPanel.tsx');

  assert.match(panel, /roomOwnerId: effectiveOwnerId/, 'counterparty listing');
  assert.match(panel, /message\.senderId === effectiveOwnerId/, 'per-message block consequence copy');
  assert.match(panel, /target === effectiveOwnerId/, 'safety-row block consequence copy');
  // The raw prop must survive only as the seed/override, never as a consumer.
  const consumers = panel.match(/roomOwnerId(?!\?|:|\s*=|\s*\}|\))/g) || [];
  assert.ok(consumers.length <= 6, `raw prop still consumed directly ${consumers.length} times`);
});

test('DEF-030: no new request is introduced to repair the owner id', () => {
  const panel = read('components/rooms/RoomMessagesPanel.tsx');
  // The repair must reuse the existing access call, not add polling.
  assert.equal(
    (panel.match(/resolveCollaborationAccess\(/g) || []).length,
    1,
    'exactly one access call site; the latch must not add another',
  );
  assert.ok(!/setInterval/.test(panel), 'no polling may be introduced');
});

// ── DEF-031 — UGC shown to a signed-out visitor needs a reporting path ────

test('DEF-031: a signed-out visitor seeing shared items gets a reporting path', () => {
  const screen = read('app/(public)/rooms/[token].tsx');

  assert.match(
    screen,
    /\{!isAuthenticated && preview\.items\.length > 0 \?/,
    'the CTA must appear exactly where UGC is shown to a signed-out visitor',
  );
  assert.match(screen, /public-room-safety-signin/, 'the surface must be addressable in tests');
  assert.match(screen, /Sign in to report or block/, 'the control must name the capability');
  assert.match(screen, /accessibilityRole="button"/, 'the control must be a button to VoiceOver');
});

test('DEF-031: the safety control meets the HIG target size', () => {
  const screen = read('app/(public)/rooms/[token].tsx');
  const style = screen.slice(screen.indexOf('publicSafetyButton: {'));
  assert.match(style.slice(0, 400), /minHeight: 44/, 'a safety control must be at least 44pt');
});

test('DEF-031: public room access itself is unchanged', () => {
  const screen = read('app/(public)/rooms/[token].tsx');
  // The panel gate is the architecture; the repair adds a CTA beside it and
  // must not loosen who may see or act in a room.
  assert.match(
    screen,
    /if \(!canChat \|\| !isAuthenticated\) \{\s*\n\s*return null;/,
    'the authenticated-only chat/safety panel gate must remain',
  );
});

// ── DEF-061 — STOPPED, not repaired ──────────────────────────────────────
//
// The upscale is real, but the repair is not the "very small change" the
// triage represented. services/imageUtils.js is a deliberately pure module --
// it imports only expo-image-manipulator, takes everything else by argument,
// and __tests__/imageUploadSourceCoverage.test.js ENFORCES that purity by
// loading it in a sandbox whose require map rejects anything unexpected.
// Measuring the source needs react-native's Image.getSize, so the fix either
// breaks that enforced contract (7 canonical Scanner-path tests fail) or
// threads a measurer through the Scanner call sites. Both exceed the
// authorised scope, so the item was stopped and reclassified rather than
// widening the pass. Guarded here so the purity contract stays visible.

test('DEF-061: imageUtils stays dependency-pure (why the repair was stopped)', () => {
  const utils = read('services/imageUtils.js');
  const imports = utils.match(/^import .*$/gm) || [];
  assert.deepEqual(
    imports,
    ["import * as ImageManipulator from 'expo-image-manipulator';"],
    'imageUtils takes its dependencies by argument; adding one breaks the Scanner test harness',
  );
  // The unconditional resize is still present. This is the known, accepted
  // state, recorded so the finding is not silently lost.
  assert.match(utils, /\[\{ resize: \{ width: SCANNER_IMAGE_MAX_WIDTH \} \}\]/);
});

// ── DEF-054 — the report sheet must never trap the user ──────────────────

test('DEF-054: the submission is bounded', () => {
  const ctx = read('contexts/AiOutputReportingContext.tsx');

  const timeout = ctx.match(/REPORT_SUBMIT_TIMEOUT_MS = (\d+)/);
  assert.ok(timeout, 'the deadline must be a named constant');
  const ms = Number(timeout[1]);
  assert.ok(ms >= 8000 && ms <= 30000, `timeout ${ms}ms outside a sane band for a user-initiated write`);
  assert.match(ctx, /withReportTimeout\(/, 'the submission must be wrapped');
});

test('DEF-054: the sheet can always be dismissed', () => {
  const ctx = read('contexts/AiOutputReportingContext.tsx');
  const close = ctx.slice(ctx.indexOf('const close = useCallback'), ctx.indexOf('const openAiOutputReport'));

  assert.ok(
    !/if \(state === 'submitting'\) return;/.test(close),
    'the regression: dismissal refused while submitting',
  );
  assert.match(close, /sheetGenerationRef\.current \+= 1/, 'dismissal must invalidate the in-flight attempt');
});

test('DEF-054: a late or timed-out result cannot repaint a dismissed sheet', () => {
  const ctx = read('contexts/AiOutputReportingContext.tsx');
  assert.equal(
    (ctx.match(/generation !== sheetGenerationRef\.current/g) || []).length,
    2,
    'both the success path and the failure path must check the generation',
  );
  // A timeout must land somewhere the user can act, not on a dead end.
  assert.match(ctx, /const retry = useCallback\(\(\) => setState\('form'\)/, 'retry path preserved');
});

test('DEF-054: no new reporting infrastructure was introduced', () => {
  const ctx = read('contexts/AiOutputReportingContext.tsx');
  assert.match(ctx, /submitAiOutputReport\(/, 'the existing submission is still the only writer');
  assert.match(ctx, /isReportServerAccepted\(attempt\.value\)/, 'acceptance gating is unchanged');
});

// ── DEF-062 / DEF-063 — speech lifecycle ─────────────────────────────────

test('DEF-062: leaving the Dressing Room stops its cue', () => {
  const hook = read('hooks/useEliseSpeechCue.ts');
  const screen = read('app/stylist/dressing-room/index.tsx');

  assert.match(hook, /export function useStopEliseCueOnLeave/, 'a scoped cleanup hook must exist');
  assert.match(hook, /stopAvatarSpeechPlayback\(\{ actorId, avatarId \}\)/, 'cleanup must be scoped');
  assert.match(screen, /useStopEliseCueOnLeave\(\)/, 'the Dressing Room must use it');
});

test('DEF-062: cleanup targets the scope captured at teardown, not a stale closure', () => {
  const hook = read('hooks/useEliseSpeechCue.ts');
  const block = hook.slice(hook.indexOf('export function useStopEliseCueOnLeave'));
  assert.match(block, /scopeRef/, 'the scope must be read from a ref at cleanup time');
  assert.match(block, /useEffect\(\(\) => \{\s*\n\s*return \(\) => \{/, 'cleanup must run on unmount');
  assert.match(block, /if \(!actorId \|\| !avatarId\) return;/, 'an unknown scope must stop nothing');
});

test('DEF-063: switching stylist stops the outgoing stylist', () => {
  const identity = read('hooks/useStylistIdentity.ts');

  assert.match(identity, /stopOutgoingSpeech/, 'the switch seam must stop speech');
  assert.match(
    identity,
    /input\.avatarId && input\.avatarId !== outgoingAvatarId/,
    'only an actual avatar change may cut off speech',
  );
  assert.match(identity, /const didReset = await resetStylistIdentity\(\);\s*\n\s*if \(didReset\) stopOutgoingSpeech/, 'reset must stop it too');
  assert.match(
    identity,
    /stopAvatarSpeechPlayback\(\{ actorId: userId, avatarId: outgoingAvatarId \}\)/,
    'the OUTGOING avatar is the correct scope',
  );
});

test('DEF-063: renaming the same stylist does not cut her off mid-sentence', () => {
  const identity = read('hooks/useStylistIdentity.ts');
  const update = identity.slice(identity.indexOf('const update = useCallback'), identity.indexOf('const reset = useCallback'));
  assert.match(update, /input\.avatarId !== outgoingAvatarId/, 'a rename-only update must not stop speech');
});

test('DEF-062/063: the avatar speech store itself is untouched', () => {
  const speech = read('services/avatarSpeech.ts');
  assert.match(speech, /export async function stopAvatarSpeechPlayback\(scope\?: AvatarSpeechScope\)/, 'existing API reused as-is');
});

// ── DEF-014 — account deletion session preflight ─────────────────────────

test('DEF-014: deletion preflights the session through the existing helper', () => {
  const privacy = read('app/privacy.tsx');

  assert.match(privacy, /resolveAuthenticatedFunctionSession/, 'the existing helper must be reused');
  const handler = privacy.slice(privacy.indexOf('setDeletionConfirmVisible(false);'), privacy.indexOf('setDeletionPending(true)'));
  assert.ok(
    handler.indexOf('resolveAuthenticatedFunctionSession') < handler.indexOf('submitAccountDeletionRequest'),
    'the preflight must run BEFORE the invoke',
  );
});

test('DEF-014: an expired session gets distinct, actionable copy', () => {
  const privacy = read('app/privacy.tsx');
  assert.match(privacy, /session_expired/, 'the expired case must be distinguished');
  assert.match(privacy, /Your session expired\. Please sign in again to request account deletion\./);
  // It must not be reported as a backend outage.
  assert.ok(
    !/session_expired[\s\S]{0,200}couldn't submit your request right now/.test(privacy),
    'expiry must not fall through to the generic outage copy',
  );
});

test('DEF-014: the deletion service stays dependency-free', () => {
  const service = read('services/accountDeletion.js');
  // This module deliberately takes the client by injection and imports nothing;
  // that is what makes it testable. The preflight belongs at the call site.
  assert.ok(!/^import /m.test(service), 'no ESM imports may be added');
  assert.ok(!/require\(/.test(service), 'no requires may be added');
  assert.match(service, /async function submitAccountDeletionRequest\(supabase, _session\)/, 'injection contract unchanged');
});

// ── DEF-020 — reconciled, NOT re-repaired ────────────────────────────────

test('DEF-020: the prior commerce-URL repair is intact and was not re-applied', () => {
  const commerce = read('services/dressingRoomCommerce.ts');

  // PERSISTENCE: ordinary merchant link parameters must survive.
  for (const key of ["'token'", "'sig'", "'signature'", "'expires'"]) {
    assert.ok(
      !commerce.includes(`  ${key},`),
      `${key} must not be filtered — that was the defect the prior repair removed`,
    );
  }
  // ...while real credentials still never reach a persisted snapshot.
  for (const key of ['access_token', 'api_key', 'authorization', 'secret', 'jwt']) {
    assert.ok(commerce.includes(`'${key}'`), `${key} must still be rejected`);
  }
});

test('DEF-020: the centralized outbound boundary still rejects unsafe destinations', () => {
  const destination = loadTsModule('services/commerceDestination.ts', {
    'react-native': { Linking: { openURL: async () => {} } },
  });
  const { isSafeCommerceUrl } = destination;

  // A legitimate signed merchant link must OPEN.
  assert.equal(
    isSafeCommerceUrl('https://shop.example.com/p/1?token=abc&sig=xyz&expires=99'),
    'https://shop.example.com/p/1?token=abc&sig=xyz&expires=99',
  );

  // ...and unsafe destinations must not.
  for (const bad of [
    'http://shop.example.com/p/1',
    'javascript:alert(1)',
    'https://user:pass@shop.example.com/p',
    'https://localhost/p',
    'https://127.0.0.1/p',
    'https://192.168.1.10/p',
    'not a url',
  ]) {
    assert.equal(isSafeCommerceUrl(bad), null, `must reject ${bad}`);
  }
});
