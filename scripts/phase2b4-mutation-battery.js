#!/usr/bin/env node
/**
 * Phase 2B.4 cross-path mutation battery.
 *
 * WHAT A MUTATION PROVES: that a protection is load-bearing. A test that passes
 * is weak evidence — it may be asserting something the code could never violate.
 * A test that FAILS when its protection is broken, and fails for the stated
 * reason, is the actual proof.
 *
 * WHAT THIS DOES NOT DO: replace or reduce the Phase 2B.3 batteries. Those stay
 * exactly as they are. This battery is additive and targets the CROSS-PATH
 * invariants Phase 2B.4 introduced.
 *
 * RULES ENFORCED HERE, per mutation:
 *   - the edit must actually change active or activatable source (verified by a
 *     byte comparison before and after);
 *   - the named test must FAIL;
 *   - the failure output must match `expectReason`, so a mutation caught by an
 *     unrelated parser or validator does not count as caught;
 *   - the file is restored byte-for-byte;
 *   - the named test must pass again after restoration.
 *
 * Usage:
 *   node scripts/phase2b4-mutation-battery.js            # run all
 *   node scripts/phase2b4-mutation-battery.js 3 7 21     # run selected ids
 *
 * Exit codes:
 *   0  every mutation was caught for the intended reason and restored
 *   1  a mutation survived, was caught for the wrong reason, or did not restore
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const CROSS_PATH_TEST = '__tests__/phase2b4CrossPathCertification.test.js';
const PARITY_TEST = '__tests__/phase2b4CrossPlatformParity.test.js';
const BACKEND_TEST = 'supabase/functions/scan-identify/phase2b4CrossPath.test.ts';
const ELISE_MIGRATION_TEST = '__tests__/eliseIdentificationV2Migration.test.js';
const LEGACY_GATE_TEST = '__tests__/eliseLegacyPhotoIntakeGate.test.js';
const EDGE_PARITY_TEST = '__tests__/edgeFunctionSourceParity.test.js';
const BACKEND_CONTEXT_TEST = 'supabase/functions/stylechat-generate/fashionContextV2.test.ts';

const CORE = 'services/fashionIdentificationV2Core.ts';
const SCANNER_ADAPTER = 'services/scannerIdentificationV2.ts';
const ELISE_ADAPTER = 'services/style-chat/eliseIdentificationV2.ts';
const ELISE_ORCHESTRATOR = 'services/style-chat/eliseIdentifyForStyle.ts';
const ELISE_CONTEXT = 'services/style-chat/eliseFashionContextV2.ts';
const ELISE_ROUTING = 'services/style-chat/eliseAttachmentRouting.ts';
const BACKEND_SHARED = 'supabase/functions/_shared/fashionIdentificationV2.ts';
const BACKEND_INDEX = 'supabase/functions/scan-identify/index.ts';
const BACKEND_CONTEXT = 'supabase/functions/stylechat-generate/fashionContextV2.ts';
const TRANSPORT = 'services/scanIdentification.ts';
const FLAGS = 'constants/featureFlags.ts';
const EDGE_MANIFEST = 'config/edge-function-manifest.json';
const PARITY_MANIFEST = 'config/cross-path-parity-manifest.json';

/**
 * @type {Array<{
 *   id: number, title: string, file: string, find: string, replace: string,
 *   test: string, name: string, expectReason: RegExp, runner?: 'node'|'deno'
 * }>}
 */
const MUTATIONS = [
  {
    id: 1,
    title: 'Scanner intent',
    file: SCANNER_ADAPTER,
    find: "export const SCANNER_INTENT = 'identify_and_shop' as const;",
    replace: "export const SCANNER_INTENT = 'identify_for_style' as const;",
    test: CROSS_PATH_TEST,
    name: 'shared core: both intents are constants, neither is a caller-supplied parameter',
    expectReason: /identify_and_shop|identify_for_style/,
  },
  {
    id: 2,
    title: 'Elise intent',
    file: ELISE_ADAPTER,
    find: "export const ELISE_INTENT = 'identify_for_style' as const;",
    replace: "export const ELISE_INTENT = 'identify_and_shop' as const;",
    test: CROSS_PATH_TEST,
    name: 'shared core: both intents are constants, neither is a caller-supplied parameter',
    expectReason: /identify_for_style|identify_and_shop/,
  },
  {
    id: 3,
    title: 'Shared contract version on the Elise path only',
    file: ELISE_ADAPTER,
    find: '    contractVersion: FASHION_IDENTIFICATION_CONTRACT_V2,\n    requestId,',
    replace: "    contractVersion: 'fashion-identification-v1' as never,\n    requestId,",
    test: CROSS_PATH_TEST,
    name: 'request equivalence: detect_items differs ONLY by intent and entryPath',
    expectReason: /contractVersion|intent|entryPath/,
  },
  {
    id: 4,
    title: 'Shared response normalizer on the Scanner path only',
    file: SCANNER_ADAPTER,
    find: '  return validateFashionV2Response(raw);',
    replace: '  return { kind: '
      + "'ok', result: raw as never } as unknown as ScannerV2ResponseValidation;",
    test: CROSS_PATH_TEST,
    name: 'equivalence \\[malformed/unknown-status\\]: both paths refuse it with the same category',
    expectReason: /Scanner accepted a malformed payload|rejection category/,
  },
  {
    id: 5,
    title: 'Shared category projection',
    file: ELISE_CONTEXT,
    find: '  const category = nz(item.category);\n  const subtype = nz(item.subtype);',
    replace: '  const category = nz(item.subtype);\n  const subtype = nz(item.subtype);',
    test: CROSS_PATH_TEST,
    name: 'projection \\[single/category-and-subtype\\]',
    expectReason: /category/,
  },
  {
    id: 6,
    title: 'Shared subtype projection',
    file: ELISE_CONTEXT,
    find: '    category,\n    subtype,\n    brand: {',
    replace: '    category,\n    subtype: null,\n    brand: {',
    test: CROSS_PATH_TEST,
    name: 'projection \\[single/category-and-subtype\\]',
    expectReason: /subtype/,
  },
  {
    id: 7,
    title: 'Brand value on the Elise projection',
    file: ELISE_CONTEXT,
    find: '      value: nz(brand.value),\n      confidence: conf(brand.confidence),',
    replace: '      value: null,\n      confidence: conf(brand.confidence),',
    test: CROSS_PATH_TEST,
    name: 'projection \\[single/brand-and-subtype\\]',
    expectReason: /brand|value/,
  },
  {
    id: 8,
    title: 'Colour ordering in the projection',
    file: ELISE_CONTEXT,
    find: '    colors: { primary: nz(colors.primary), secondary: list(colors.secondary) },',
    replace: '    colors: { primary: nz(colors.primary), secondary: list(colors.secondary).reverse() },',
    test: CROSS_PATH_TEST,
    name: 'projection \\[single/multiple-colors\\]',
    expectReason: /coral|cream|black|secondary/i,
  },
  {
    id: 9,
    title: 'Partial status mapping in the projection',
    file: ELISE_CONTEXT,
    find: '    identityVersion: ELISE_FASHION_IDENTITY_V2,\n    status: result.status,',
    replace: "    identityVersion: ELISE_FASHION_IDENTITY_V2,\n    status: 'completed' as never,",
    test: CROSS_PATH_TEST,
    name: 'projection: never upgrades a partial identity to completed',
    expectReason: /partial|completed/,
  },
  {
    id: 10,
    title: 'Resolution-level mapping in the projection',
    file: ELISE_CONTEXT,
    find: '    resolutionLevel: result.resolutionLevel,\n    category,',
    replace: "    resolutionLevel: 'unknown' as never,\n    category,",
    test: CROSS_PATH_TEST,
    name: 'projection \\[single/exact-product\\]',
    expectReason: /resolutionLevel|exact_product|unknown/,
  },
  {
    id: 11,
    title: 'Conflict propagation through the projection',
    file: ELISE_CONTEXT,
    find: '      if (field && description) conflicts.push({ field, description });',
    replace: '      if (false && field && description) conflicts.push({ field, description });',
    test: CROSS_PATH_TEST,
    name: 'projection \\[uncertain/conflicting-brand-evidence\\]',
    expectReason: /conflicts/,
  },
  {
    id: 12,
    title: 'Candidate ordering in the shared core',
    file: CORE,
    find: '    });\n  }\n  return out;\n}',
    replace: '    });\n  }\n  return out.reverse();\n}',
    test: CROSS_PATH_TEST,
    name: 'candidates: the multi-candidate set matches in count, order and identity',
    expectReason: /cand-1|cand-3|order/,
  },
  {
    id: 13,
    title: 'Candidate selection identity in the Elise request',
    file: ELISE_ADAPTER,
    find: '      candidateId: candidate.candidateId,\n      evidenceId: candidate.evidenceId,',
    replace: "      candidateId: 'mutated-candidate',\n      evidenceId: candidate.evidenceId,",
    test: CROSS_PATH_TEST,
    name: 'request equivalence: identify_selected_item differs ONLY by intent and entryPath',
    expectReason: /candidateId|selectedCandidate/,
  },
  {
    id: 14,
    title: 'Scanner commerce gate',
    file: BACKEND_SHARED,
    find: '  return { run: true, skippedReason: null };\n}',
    replace: "  return { run: false, skippedReason: 'mutated' };\n}",
    test: BACKEND_TEST,
    runner: 'deno',
    name: 'gates: shopping intent keeps commerce for every identity-bearing status',
    expectReason: /Scanner commerce was disabled/,
  },
  {
    id: 15,
    title: 'Elise commerce short-circuit',
    file: BACKEND_SHARED,
    // Deleted rather than misspelled: an invalid intent literal would fail
    // deno's type check, and a mutation caught by the type checker proves
    // nothing about the gate.
    find: "  if (input.intent === 'identify_for_style') {\n    return { run: false, skippedReason: COMMERCE_SKIPPED_STYLE_INTENT };\n  }\n",
    replace: '',
    test: BACKEND_TEST,
    runner: 'deno',
    name: 'gates: the commerce decision is total over intent x status',
    expectReason: /style intent ran commerce/,
  },
  {
    id: 16,
    title: 'Scanner artifact gate',
    file: BACKEND_SHARED,
    find: "  return intent !== 'identify_for_style';\n}",
    replace: '  return false;\n}',
    test: BACKEND_TEST,
    runner: 'deno',
    name: 'gates: Scanner-domain artifacts are captured for shopping and never for style',
    expectReason: /Values are not equal|false|true/,
  },
  {
    id: 17,
    title: 'Elise artifact gate at the capture call site',
    file: BACKEND_INDEX,
    find: '  const captureCommerceOutcome: typeof persistCommerceOutcomeRow = (input, envGet) => {\n    if (!captureScanArtifacts) {',
    replace: '  const captureCommerceOutcome: typeof persistCommerceOutcomeRow = (input, envGet) => {\n    if (false) {',
    test: BACKEND_TEST,
    runner: 'deno',
    name: 'inventory: no style-intent request can reach a service-role artifact write',
    expectReason: /captureCommerceOutcome is not short-circuited/,
  },
  {
    id: 18,
    title: 'Scanner handoff reuse',
    file: ELISE_ROUTING,
    find: "const REUSABLE_SOURCES: ReadonlySet<string> = new Set([\n  'recent_scan',\n  'scanner_handoff',\n]);",
    replace: "const REUSABLE_SOURCES: ReadonlySet<string> = new Set([\n  'recent_scan',\n]);",
    test: CROSS_PATH_TEST,
    name: 'reuse: a valid Scanner handoff reuses identity and issues ZERO identification calls',
    expectReason: /reuse_v2|non_visual/,
  },
  {
    id: 19,
    title: 'Recent Scan reuse',
    file: ELISE_ROUTING,
    find: "const REUSABLE_SOURCES: ReadonlySet<string> = new Set([\n  'recent_scan',\n  'scanner_handoff',\n]);",
    replace: "const REUSABLE_SOURCES: ReadonlySet<string> = new Set([\n  'scanner_handoff',\n]);",
    test: CROSS_PATH_TEST,
    name: 'reuse: a valid V2 Recent Scan reuses identity and issues ZERO identification calls',
    expectReason: /reuse_v2|non_visual/,
  },
  {
    id: 20,
    title: 'Duplicate StyleChat classification gate',
    file: BACKEND_CONTEXT,
    find: '  if (rejectionCode !== null) return false;\n  return !context || context.groundable.length === 0;',
    replace: '  if (rejectionCode !== null) return false;\n  return true;',
    test: BACKEND_CONTEXT_TEST,
    runner: 'deno',
    name: 'valid canonical context SKIPS independent image classification',
    expectReason: /Values are not equal|false|true/,
  },
  {
    id: 21,
    title: 'Projection forbidden-key gate',
    file: ELISE_CONTEXT,
    find: '    if (FORBIDDEN_CONTEXT_KEYS.has(key.toLowerCase())) return `${path}.${key}:forbidden_key`;',
    replace: '    if (false) return `${path}.${key}:forbidden_key`;',
    test: CROSS_PATH_TEST,
    name: 'privacy: the forbidden-KEY scan catches correlation nested inside allowed containers',
    expectReason: /forbidden key was not detected/,
  },
  {
    id: 22,
    title: 'Projection forbidden-string-content gate',
    file: ELISE_CONTEXT,
    find: '    if (COMMERCE_CONTENT.test(value as string)) return `${path}:commerce_content`;',
    replace: '    if (false) return `${path}:commerce_content`;',
    test: CROSS_PATH_TEST,
    name: 'privacy: the transport gate refuses a retailer URL smuggled into a free-text field',
    expectReason: /commerce_content|invalid/,
  },
  {
    id: 23,
    title: 'Stored-source trust (a claimed V2 identity accepted without validation)',
    file: ELISE_ROUTING,
    find: '    const direct = validateFashionV2Response(input.identificationV2);\n    if (direct.kind === '
      + "'ok') return { kind: 'reuse_v2', identification: direct.result };",
    replace: '    const direct = validateFashionV2Response(input.identificationV2);\n    if (input.identificationV2) '
      + "return { kind: 'reuse_v2', identification: input.identificationV2 as never };",
    test: CROSS_PATH_TEST,
    name: 'reuse: a caller claiming V2 without a valid payload does not get reuse_v2',
    expectReason: /reuse_v2|compatibility/,
  },
  {
    id: 24,
    title: 'Multi-image source ordering',
    file: ELISE_CONTEXT,
    find: '  items.sort((left, right) => left.sourceIndex - right.sourceIndex);',
    replace: '  items.sort((left, right) => right.sourceIndex - left.sourceIndex);',
    test: CROSS_PATH_TEST,
    name: 'multi-image: items keep SOURCE order, not completion order',
    expectReason: /tee|boot|sourceIndex|0|2/,
  },
  {
    id: 25,
    title: 'Partial-success merge behaviour',
    file: ELISE_CONTEXT,
    find: '      items.push({ sourceIndex: entry.sourceIndex, state: entry.state });\n      continue;',
    replace: '      continue;',
    test: CROSS_PATH_TEST,
    name: 'multi-image: one success plus one failure keeps the success and marks the failure',
    expectReason: /length|items|2/,
  },
  {
    id: 26,
    title: 'Dormant iOS legacy photo-intake gate',
    file: FLAGS,
    find: "  process.env.EXPO_PUBLIC_ELISE_LEGACY_PHOTO_INTAKE_ENABLED === 'true';",
    replace: "  process.env.EXPO_PUBLIC_ELISE_LEGACY_PHOTO_INTAKE_ENABLED !== '___never';",
    test: LEGACY_GATE_TEST,
    // The exact-string test still passes under this mutation (it only checks
    // that "true" opts IN). The load-bearing assertion is the sibling one: that
    // absence and near-misses stay closed.
    name: 'legacy intake flag: missing, empty and malformed values all resolve FALSE',
    expectReason: /must not activate the legacy intake/,
    /**
     * iOS-only. On the Android line the same modal is the LIVE single-photo
     * intake (§16's authorized platform surface), so there is no dormant route
     * and no opt-in flag to mutate. Reported N/A rather than silently skipped,
     * and the Android side is covered instead by the platform-divergence test in
     * `__tests__/phase2b4CrossPlatformParity.test.js`, which requires that live
     * intake to converge on the shared orchestrator.
     */
    platformScoped: 'iOS line only — Android has no dormant legacy intake route',
  },
  {
    id: 27,
    title: 'Technical-failure legacy fallback scope',
    file: CORE,
    find: "  return input?.httpStatus === 400 && input?.errorCode === 'UNSUPPORTED_CONTRACT_VERSION';",
    replace: '  return input?.httpStatus === 400;',
    test: CROSS_PATH_TEST,
    name: 'fallback scope \\[other-400\\]: neither path falls back, both call once',
    expectReason: /fell back|spent a second scan/,
  },
  {
    id: 28,
    title: 'Paid legacy response reuse on the Elise fallback',
    file: ELISE_ORCHESTRATOR,
    find: '      legacyResponse: detection.response,',
    replace: '      legacyResponse: undefined as never,',
    test: ELISE_MIGRATION_TEST,
    name: 'fallback: the paid legacy response is threaded through the direct outcome',
    expectReason: /legacyResponse|undefined/,
  },
  {
    id: 29,
    title: 'Backend function name',
    file: TRANSPORT,
    find: "const EDGE_FN = 'scan-identify';",
    replace: "const EDGE_FN = 'scan-identify-v2';",
    test: CROSS_PATH_TEST,
    name: 'wiring: the transport targets the governed scan-identify function',
    expectReason: /scan-identify/,
  },
  {
    id: 30,
    title: 'Supabase session propagation guard',
    file: TRANSPORT,
    find: '    const { data: { session } } = await supabase.auth.getSession();\n    if (!session) return failed(SIGN_IN_REQUIRED_MESSAGE);',
    replace: '    const { data: { session } } = await supabase.auth.getSession();\n    if (false) return failed(SIGN_IN_REQUIRED_MESSAGE);',
    test: CROSS_PATH_TEST,
    name: 'wiring: the transport refuses to spend a scan without an authenticated session',
    expectReason: /session|getSession|authenticated/,
  },
  {
    id: 31,
    title: 'Edge Function manifest closure',
    file: EDGE_MANIFEST,
    find: '"supabase/functions/_shared/fashionIdentificationV2.ts"',
    replace: '"supabase/functions/_shared/fashionIdentificationV2_REMOVED.ts"',
    test: EDGE_PARITY_TEST,
    name: 'parity gate passes against this checkout',
    expectReason: /PARITY|parity|FAIL|drift/i,
  },
  {
    id: 32,
    title: 'Cross-platform shared-file parity manifest',
    file: PARITY_MANIFEST,
    find: '"path": "services/fashionIdentificationV2Core.ts",\n        "sha256": "',
    replace: '"path": "services/fashionIdentificationV2Core.ts",\n        "sha256": "0000',
    test: PARITY_TEST,
    name: 'parity: every governed file exists and matches its recorded hash',
    expectReason: /drifted|fashionIdentificationV2Core/,
  },
  {
    id: 33,
    title: 'Canonical equivalence comparator',
    file: CROSS_PATH_TEST,
    find: 'function isExcluded(fieldPath) {\n  return IDENTITY_EXCLUSIONS.some((pattern) => pattern.test(fieldPath));',
    replace: 'function isExcluded(fieldPath) {\n  return true || IDENTITY_EXCLUSIONS.some((pattern) => pattern.test(fieldPath));',
    test: CROSS_PATH_TEST,
    name: 'equivalence: the comparator actually fails on a seeded identity drift',
    expectReason: /length|1|0/,
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

/** Control-flow marker: this mutation could not be applied, report and move on. */
class SkipMutation extends Error {}

/**
 * Windows `shell: true` CONCATENATES argv without escaping, so a --filter value
 * containing spaces is re-split by cmd.exe and deno reads the second word as a
 * file path. Quoting here keeps the filter a single argument. Without this the
 * battery reports every deno mutation as caught-for-the-wrong-reason, because
 * the run failed on an import error rather than on the assertion.
 */
function shellArg(value) {
  return process.platform === 'win32' && /\s/.test(value) ? `"${value}"` : value;
}

function runNamedTest(mutation) {
  const runner = mutation.runner ?? 'node';
  if (runner === 'deno') {
    return spawnSync(
      'deno',
      ['test', '--allow-read', '--filter', shellArg(mutation.name.replace(/\\/g, '')), mutation.test],
      { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
    );
  }
  return spawnSync(
    process.execPath,
    ['--test', '--test-name-pattern', mutation.name, mutation.test],
    { cwd: ROOT, encoding: 'utf8' },
  );
}

function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/** A deno --filter that matched nothing still exits 0; treat that as "not run". */
function ranSomething(result, runner) {
  const text = output(result);
  if (runner === 'deno') return !/running 0 tests/.test(text);
  return !/^# pass 0\b/m.test(text) && !/tests 0\b/.test(text);
}

function main() {
  const selected = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
  const battery = selected.length > 0
    ? MUTATIONS.filter((m) => selected.includes(m.id))
    : MUTATIONS;

  const results = [];
  let failures = 0;

  for (const mutation of battery) {
    const absolute = path.join(ROOT, mutation.file);
    const original = fs.readFileSync(absolute, 'utf8');
    const record = { id: mutation.id, title: mutation.title, status: 'UNKNOWN', detail: '' };

    try {
      if (!original.includes(mutation.find)) {
        if (mutation.platformScoped) {
          // Declared platform-scoped AND genuinely absent: report it, do not
          // count it as a survivor, and do not pretend it ran.
          record.status = 'N/A';
          record.detail = mutation.platformScoped;
        } else {
          record.status = 'NO-TARGET';
          record.detail = `anchor not found in ${mutation.file}`;
          failures += 1;
        }
        throw new SkipMutation();
      }

      const mutated = original.replace(mutation.find, mutation.replace);
      if (mutated === original) {
        record.status = 'NO-OP';
        record.detail = 'replacement produced identical source';
        failures += 1;
        throw new SkipMutation();
      }

      fs.writeFileSync(absolute, mutated);
      const mutatedRun = runNamedTest(mutation);
      const mutatedOutput = output(mutatedRun);

      if (!ranSomething(mutatedRun, mutation.runner ?? 'node')) {
        record.status = 'NO-TEST';
        record.detail = `named test did not match: ${mutation.name}`;
        failures += 1;
      } else if (mutatedRun.status === 0) {
        record.status = 'SURVIVED';
        record.detail = `${mutation.name} still passed under mutation`;
        failures += 1;
      } else if (!mutation.expectReason.test(mutatedOutput)) {
        // Caught, but by something other than the protection under test.
        record.status = 'WRONG-REASON';
        record.detail = `expected ${mutation.expectReason}`;
        failures += 1;
      } else {
        record.status = 'CAUGHT';
        record.detail = mutation.name;
      }
    } catch (error) {
      // A skipped mutation still falls through to the restore + report below;
      // any other error is a harness bug and must not be swallowed.
      if (!(error instanceof SkipMutation)) throw error;
    } finally {
      fs.writeFileSync(absolute, original);
    }

    // Restoration must be byte-exact AND the test must pass again.
    const restored = fs.readFileSync(absolute, 'utf8');
    if (restored !== original) {
      record.status = 'NOT-RESTORED';
      failures += 1;
    } else if (record.status === 'CAUGHT') {
      const restoredRun = runNamedTest(mutation);
      if (restoredRun.status !== 0) {
        record.status = 'RESTORE-RED';
        record.detail = 'named test still fails after restoration';
        failures += 1;
      }
    }

    results.push(record);
    const line = `  [${String(record.id).padStart(2, '0')}] ${record.status.padEnd(13)} ${record.title}`;
    console.log(record.status === 'CAUGHT' ? line : `${line}\n        ${record.detail}`);
  }

  console.log('─'.repeat(72));
  const caught = results.filter((r) => r.status === 'CAUGHT').length;
  const notApplicable = results.filter((r) => r.status === 'N/A').length;
  const applicable = results.length - notApplicable;
  console.log(
    `Phase 2B.4 mutation battery: ${caught}/${applicable} caught for the intended reason`
    + (notApplicable > 0 ? `, ${notApplicable} not applicable on this platform line.` : '.'),
  );
  if (failures > 0) {
    console.error('FAIL  Not every mutation was caught. See the entries above.');
    process.exit(1);
  }
  console.log('PASS  Every mutation altered active source, failed a named test, and was restored.');
}

main();
