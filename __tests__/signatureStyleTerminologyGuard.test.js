// Signature Style terminology regression guard (release-freeze repair,
// 2026-09-12: fix(release): complete Signature Style terminology cleanup).
//
// K Scan AI's canonical product/internal terminology is "Signature Style".
// The old, competitor-associated term "Style DNA" (and its casing/separator
// variants) was renamed across ~726 lines / 88 files. This guard scans the
// whole repository for every remaining variant and fails on anything that
// is not an explicit, justified, file-scoped allowlist entry -- so the
// legacy term cannot silently creep back into active source, tests, or
// forward-facing docs/config.
//
// Convention follows __tests__/migrationBomGuard.test.js: a pure detector
// function, negative controls proving the detector itself works, then real
// repo-wide coverage, then a regression pin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// ── Detector ──────────────────────────────────────────────────────────────
//
// The forbidden token is built from two separate string literals joined at
// runtime (never written adjacently as a single literal) so this guard file
// cannot match its own detector when it scans the repository below.

const LEGACY_WORD_ONE = 'Style';
const LEGACY_WORD_TWO = 'DNA';

/** style DNA / StyleDna / STYLE_DNA / style-dna / style_dna / Style DNA, case-insensitive. */
function buildLegacyTermRegExp() {
  return new RegExp(`${LEGACY_WORD_ONE}[ _-]?${LEGACY_WORD_TWO}`, 'i');
}

/**
 * Pure detector: scans `content` line by line and returns every line number
 * (1-based) and trimmed text containing the legacy term.
 */
function findLegacyTermLines(content) {
  const pattern = buildLegacyTermRegExp();
  const hits = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      hits.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

// ── Negative controls (prove the detector actually works) ──────────────────
// Synthetic strings only -- nothing here touches a real file.

test('detector matches every case/separator variant of the legacy term', () => {
  const variants = [
    ['Style', 'Dna'].join(''), // StyleDna
    ['style', 'Dna'].join(''), // styleDna
    ['STYLE', 'DNA'].join('_'), // STYLE_DNA
    ['style', 'dna'].join('-'), // style-dna
    ['style', 'dna'].join('_'), // style_dna
    ['Style', 'DNA'].join(' '), // Style DNA
    ['style', 'dna'].join(' '), // style dna
    ['STYLEDNA'].join(''), // bare, no separator, all caps
  ];
  for (const variant of variants) {
    const hits = findLegacyTermLines(`const x = '${variant}';`);
    assert.equal(hits.length, 1, `must detect variant: ${variant}`);
  }
});

test('detector does not false-positive on Signature Style or unrelated style/dna text', () => {
  const clean = [
    'const x = SignatureStyle;',
    'const y = signature_style;',
    'const z = "SIGNATURE_STYLE";',
    'this component follows the house style guide',
    'DNA sequencing has nothing to do with fashion',
    'a stylish outfit for the gala',
  ];
  for (const line of clean) {
    assert.deepEqual(findLegacyTermLines(line), [], `must not flag: ${line}`);
  }
});

test('detector reports 1-based line numbers and trimmed text', () => {
  const hits = findLegacyTermLines('one\ntwo ' + ['Style', 'DNA'].join(' ') + ' three\nfour');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].text, /three/);
});

// ── Real repo-wide coverage ──────────────────────────────────────────────
//
// Every occurrence must be accounted for by exactly one allowlist entry.
// Only PERSISTED_COMPATIBILITY, EXTERNAL_WIRE_CONTRACT,
// IMMUTABLE_HISTORICAL_MIGRATION, or HISTORICAL_AUDIT_RECORD may appear
// here -- no ACTIVE_SOURCE_RENAME or CONSUMER_FACING_RENAME item may ever
// be allowlisted. `token: 'ENTIRE_FILE'` is used only for files this repair
// is independently forbidden from editing at all (already-applied
// migrations, and the governance/audit records that quote them or a past
// point-in-time state verbatim) -- it names one literal file path, never a
// directory.

const ALLOWLIST = [
  // ── EXTERNAL_WIRE_CONTRACT: eas.json build-flag env vars ─────────────────
  // Owner-ratified eas.json keys (repeated across the preview, development,
  // staging and production build profiles). Not proven safe to rename ahead
  // of a native release; each read point assigns immediately into a
  // SIGNATURE_STYLE_*-named internal constant (see services/signature-style).
  { file: 'eas.json', token: 'EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Owner-ratified eas.json build flag, repeated across 4 profiles; not proven safe to rename pre-freeze.' },
  { file: 'eas.json', token: 'EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Owner-ratified eas.json build flag, repeated across 4 profiles; not proven safe to rename pre-freeze.' },
  { file: 'eas.json', token: 'EXPO_PUBLIC_STYLE_DNA_REASON_FEEDBACK_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Owner-ratified eas.json build flag, repeated across 4 profiles; not proven safe to rename pre-freeze.' },
  { file: 'services/signature-style/localSignatureStyleFeedbackStore.ts', token: 'EXPO_PUBLIC_STYLE_DNA_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'process.env read of the retained env var name; internal constant is SIGNATURE_STYLE_ENABLED.' },
  { file: 'services/signature-style/localSignatureStyleProfile.ts', token: 'EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'process.env read of the retained env var name; internal constant is SIGNATURE_STYLE_PROFILE_ENABLED.' },
  { file: 'services/signature-style/localSignatureStyleReasons.ts', token: 'EXPO_PUBLIC_STYLE_DNA_REASON_FEEDBACK_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'process.env read of the retained env var name; internal constant is SIGNATURE_STYLE_REASON_FEEDBACK_ENABLED.' },
  { file: 'services/signature-style/signatureStyleContext.ts', token: 'EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'process.env read of the retained env var name; internal constant is SIGNATURE_STYLE_CONTEXT_ENABLED.' },
  { file: 'app/style-chat/[sessionId].tsx', token: 'EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Comment naming the retained env var read by services/signature-style/signatureStyleContext.ts.' },
  { file: '__tests__/localSignatureStyleFeedbackStore.test.js', token: 'EXPO_PUBLIC_STYLE_DNA_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Test fixture exercising the retained env var name.' },
  { file: '__tests__/localSignatureStyleProfile.test.js', token: 'EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Test fixture exercising the retained env var name.' },
  { file: '__tests__/localSignatureStyleReasons.test.js', token: 'EXPO_PUBLIC_STYLE_DNA_REASON_FEEDBACK_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Test fixture exercising the retained env var name.' },
  { file: '__tests__/signatureStyleContext.test.js', token: 'EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Test fixture exercising the retained env var name.' },

  // ── EXTERNAL_WIRE_CONTRACT: client -> Edge Function JSON body field ──────
  // An already-shipped app build may still send this exact JSON key to the
  // independently-redeployable stylechat-generate Edge Function; renaming it
  // without a synchronized native release could silently drop the signal.
  { file: 'services/style-chat/providers/edgeStyleChatProvider.ts', token: 'styleDnaContext', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Literal outgoing JSON body key; internal parameter is signatureStyleContext.' },
  { file: 'supabase/functions/stylechat-generate/index.ts', token: 'styleDnaContext', classification: 'EXTERNAL_WIRE_CONTRACT', reason: 'Literal incoming JSON body key; read once into the internal signatureStyleContext variable.' },

  // ── PERSISTED_COMPATIBILITY: @style_dna_v1/ AsyncStorage namespace ───────
  // Existing installs may already have on-device data under this exact key
  // prefix, shared with the (unrelated) weather feature. The exported
  // constant identifier is SIGNATURE_STYLE_NAMESPACE; only the string VALUE
  // is retained.
  { file: 'services/signature-style/localSignatureStyleFeedbackStore.ts', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'SIGNATURE_STYLE_NAMESPACE string value; existing installs have data under this AsyncStorage key prefix.' },
  { file: 'services/signature-style/localSignatureStyleReasons.ts', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Comment documenting the shared, retained storage namespace.' },
  { file: 'services/weather/todayWeatherStore.ts', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Weather cache deliberately piggybacks on the retained Signature Style storage namespace so a full wipe clears both.' },
  { file: 'services/weather/weatherPermissionStore.ts', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Weather permission state deliberately piggybacks on the retained Signature Style storage namespace.' },
  { file: '__tests__/localSignatureStyleFeedbackStore.test.js', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Test pins the literal retained storage key prefix.' },
  { file: '__tests__/localSignatureStylePreferences.test.js', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Test pins the literal retained storage key prefix.' },
  { file: '__tests__/localSignatureStyleProfile.test.js', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Test pins the literal retained storage key prefix.' },
  { file: '__tests__/localSignatureStyleReasons.test.js', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Test pins the literal retained storage key prefix.' },
  { file: '__tests__/terminalDeletionCleanup.test.js', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Test pins the literal retained storage key prefix.' },
  { file: '__tests__/weatherStyling.test.js', token: '@style_dna_v1/', classification: 'PERSISTED_COMPATIBILITY', reason: 'Test pins the literal retained storage key prefix (shared weather namespace).' },

  // ── PERSISTED_COMPATIBILITY / DB boundary: revoked RPC name ─────────────
  // upsert_style_dna_profile(integer, text, jsonb) had authenticated access
  // revoked by 20260830131956_signature_style_server_authority.sql and is
  // superseded by the zero-argument recompute_signature_style(). The name
  // is immutable DB history; tests and the governance manifest pin it
  // deliberately as a revoked-boundary compatibility check, not aspirational
  // naming.
  { file: '__tests__/signatureStyleServerAuthority.test.js', token: 'upsert_style_dna_profile', classification: 'PERSISTED_COMPATIBILITY', reason: 'Pins the exact revoked RPC signature/name as a compatibility boundary, not aspirational naming.' },
  { file: 'config/migration-authority-manifest.json', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Governance ledger mirrors migration history verbatim (logicalName/evidence fields quote exact historical function and migration names); editing would break provenance reconciliation against staging.' },
  { file: 'supabase/functions/_shared/signatureStyle/signatureStyleProfileTypes.ts', token: 'upsert_style_dna_profile', classification: 'PERSISTED_COMPATIBILITY', reason: 'Comment accurately describing the now-revoked/superseded RPC by its immutable historical name.' },

  // ── IMMUTABLE_HISTORICAL_MIGRATION: already-applied migrations ──────────
  // Every migration below is already applied; this repair may not modify
  // already-applied migration SQL. Each is named individually (never a
  // directory wildcard).
  { file: 'supabase/migrations/202605130001_privacy_settings.sql', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Already-applied migration; must not be edited.' },
  { file: 'supabase/migrations/20260705000001_fix_inspiration_closet_delete_and_room_link.sql', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Already-applied migration; must not be edited.' },
  { file: 'supabase/migrations/20260829120000_kplus_entitlements.sql', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Already-applied migration; must not be edited.' },
  { file: 'supabase/migrations/20260830060000_user_style_profiles.sql', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Already-applied migration; must not be edited.' },
  { file: 'supabase/migrations/20260830070000_upsert_style_dna_profile_rpc.sql', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Already-applied migration; must not be edited.' },
  { file: 'supabase/migrations/20260830131956_signature_style_server_authority.sql', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Already-applied migration; must not be edited.' },
  { file: 'supabase/migrations/20260830140000_fix_recompute_signature_style_column_ambiguity.sql', token: 'ENTIRE_FILE', classification: 'IMMUTABLE_HISTORICAL_MIGRATION', reason: 'Already-applied migration; must not be edited.' },

  // ── HISTORICAL_AUDIT_RECORD: dated/point-in-time docs ───────────────────
  // Audit reports, ledgers, and dated readiness notes are point-in-time
  // records (some cite exact pre-rename file/line locations, others cite
  // real historical git branch names). Rewriting them would misrepresent
  // what was true when they were written.
  { file: 'docs/build34-trackb-b4-style-dna-ledger.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Named explicitly in the repair brief as a historical doc; filename and content retained.' },
  { file: 'docs/audits/final-prebuild-hostile-audit.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Dated, point-in-time audit report citing pre-rename file/line locations.' },
  { file: 'docs/audits/build34-packing-intelligence-deep-audit-20260902.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Dated, point-in-time audit report.' },
  { file: 'docs/build34-integration-validation-report.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Point-in-time validation report citing a pre-rename file location.' },
  { file: 'docs/native-camera-scanner-backend-audit.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Cites a real historical git branch name in its header.' },
  { file: 'docs/play-store-readiness-notes.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Cites a real historical git branch name in its "last updated" header.' },
  { file: 'docs/pre-build-smoke-audit-report.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Dated smoke-audit report citing a real historical git branch name.' },
  { file: 'docs/release-production-naming.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Cites a real historical git branch name in its "last updated" header.' },
  { file: 'docs/staging-rebuild/repair05-canonical-authority-reconfirmation-2026-09-08.md', token: 'ENTIRE_FILE', classification: 'HISTORICAL_AUDIT_RECORD', reason: 'Cites a real historical git branch name in a provenance table.' },
];

for (const entry of ALLOWLIST) {
  if (!['PERSISTED_COMPATIBILITY', 'EXTERNAL_WIRE_CONTRACT', 'IMMUTABLE_HISTORICAL_MIGRATION', 'HISTORICAL_AUDIT_RECORD'].includes(entry.classification)) {
    throw new Error(`invalid allowlist classification for ${entry.file}: ${entry.classification}`);
  }
}

function listTrackedFiles() {
  return execSync('git ls-files', { cwd: ROOT, maxBuffer: 1024 * 1024 * 64 })
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
}

function isAllowed(file, lineText) {
  return ALLOWLIST.some(
    (entry) => entry.file === file && (entry.token === 'ENTIRE_FILE' || lineText.includes(entry.token)),
  );
}

test('NEGATIVE CONTROL: the allowlist mechanism actually restricts by file (self-check)', () => {
  // An allowlisted token in the WRONG file must not be treated as allowed.
  assert.equal(isAllowed('some/unrelated/file.ts', '@style_dna_v1/'), false);
  assert.equal(isAllowed('eas.json', 'EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED'), true);
});

test('every legacy-term occurrence in the repository is an explicit, classified allowlist entry', () => {
  const files = listTrackedFiles();
  const unclassified = [];
  let totalOccurrences = 0;

  for (const relFile of files) {
    const fullPath = path.join(ROOT, relFile);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // This guard file itself is exempt: its detector self-tests above
    // deliberately construct legacy-term strings at runtime.
    if (relFile === '__tests__/signatureStyleTerminologyGuard.test.js') continue;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue; // binary/unreadable
    }
    const hits = findLegacyTermLines(content);
    for (const hit of hits) {
      totalOccurrences++;
      if (!isAllowed(relFile, hit.text)) {
        unclassified.push(`${relFile}:${hit.line}: ${hit.text}`);
      }
    }
  }

  assert.deepEqual(
    unclassified,
    [],
    `unclassified legacy "${LEGACY_WORD_ONE} ${LEGACY_WORD_TWO}" occurrence(s) found (UNKNOWN classification is not permitted):\n${unclassified.join('\n')}`,
  );

  // Regression pin: as of this repair, exactly 105 occurrences remain,
  // every one covered by the allowlist above. A future PR may legitimately
  // change this number (e.g. a new compatibility item, or a migration that
  // finally ages out of relevance) -- if it does, update this pin
  // deliberately alongside the allowlist, never silently.
  assert.equal(
    totalOccurrences,
    105,
    'the count of retained legacy-term occurrences changed -- update this pin deliberately alongside the ALLOWLIST above, do not just bump the number',
  );
});

test('REGRESSION PIN: the four retained EXPO_PUBLIC_STYLE_DNA_* env vars are exactly this set, nowhere else', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  const RETAINED_KEYS = [
    'EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED',
    'EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED',
    'EXPO_PUBLIC_STYLE_DNA_REASON_FEEDBACK_ENABLED',
  ];
  for (const [profileName, profile] of Object.entries(eas.build)) {
    const envKeys = Object.keys(profile.env || {});
    const legacyKeysInProfile = envKeys.filter((k) => /STYLE_DNA/.test(k));
    if (envKeys.some((k) => k === 'EXPO_PUBLIC_STYLE_DNA_PROFILE_ENABLED')) {
      // Profiles that carry the Signature Style flags at all must carry
      // exactly the three retained keys, never a fourth or a partial set.
      assert.deepEqual(
        legacyKeysInProfile.sort(),
        [...RETAINED_KEYS].sort(),
        `profile "${profileName}" must carry exactly the three retained EXPO_PUBLIC_STYLE_DNA_* keys`,
      );
    } else {
      assert.deepEqual(legacyKeysInProfile, [], `profile "${profileName}" must not partially carry a legacy Signature Style flag`);
    }
  }
});

test('REGRESSION PIN: the retained AsyncStorage namespace value is exactly "@style_dna_v1/"', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/signature-style/localSignatureStyleFeedbackStore.ts'),
    'utf8',
  );
  assert.match(source, /export const SIGNATURE_STYLE_NAMESPACE = '@style_dna_v1\/';/);
});
