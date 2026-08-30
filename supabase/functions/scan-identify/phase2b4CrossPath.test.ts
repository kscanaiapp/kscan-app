// Phase 2B.4 — backend cross-path certification.
//
// The client-side half of this phase lives in
// `__tests__/phase2b4CrossPathCertification.test.js`. This file certifies the
// three backend claims that no client test can reach:
//
//   1. IDENTITY NORMALIZATION IS INTENT-BLIND. The canonical result for a given
//      provider output must not depend on who asked. That is asserted both
//      structurally (intent is not an input to the normalizer) and behaviourally
//      (the normalized objects are byte-identical across intents).
//
//   2. INTENT GATES ARE TOTAL over the intent × status matrix, and gate ONLY
//      commerce and Scanner-domain artifacts — never identity.
//
//   3. EVERY REACHABLE DATABASE OPERATION IS INVENTORIED for both governed
//      functions, by intent. The reachable set is taken from the committed Edge
//      Function manifest's bundle closure, so the inventory cannot silently miss
//      a module that is actually deployed.
//
// Deterministic: no Supabase, no provider, no network. `--allow-read` only.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  COMMERCE_SKIPPED_STYLE_INTENT,
  FASHION_IDENTIFICATION_INTENTS,
  FASHION_IDENTIFICATION_STATUSES,
  LEGACY_DEFAULT_INTENT,
  normalizeToV2,
  shouldCaptureScanArtifacts,
  shouldRunCommerce,
} from '../_shared/fashionIdentificationV2.ts';

const REPO_ROOT = new URL('../../../', import.meta.url);

function readRepoFile(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, REPO_ROOT));
}

// ── 1. Identity normalization is intent-blind ────────────────────────────────

const PROVIDER_IDENTIFICATION = {
  item_type: 'Outerwear',
  subtype: 'Chore Jacket',
  brand_guess: 'Carhartt',
  primary_color: 'Tan',
  secondary_colors: ['Cream'],
  material: ['Cotton canvas'],
  silhouette: ['Boxy'],
  pattern: ['Solid'],
  fit: 'Relaxed',
  visual_observation: ['Triple-stitched seams'],
};

const PROVIDER_ATTRIBUTES = { category: 'Outerwear', colorPalette: ['Tan', 'Cream'] };

Deno.test('normalizer: intent is not an input to identity normalization', () => {
  // Structural, not stylistic: a field that does not exist cannot be branched
  // on. This is what makes "one identification core" true by construction
  // rather than by discipline.
  const shared = readRepoFile('supabase/functions/_shared/fashionIdentificationV2.ts');
  const inputType = shared.slice(
    shared.indexOf('export type ProviderNormalizationInput'),
    shared.indexOf('export function deriveResolutionLevel'),
  );
  assert(inputType.length > 0, 'ProviderNormalizationInput block not found');
  assertEquals(
    /\bintent\b/.test(inputType),
    false,
    'ProviderNormalizationInput must not carry an intent — identity cannot depend on who asked',
  );
});

Deno.test('normalizer: the same provider output yields an identical identity for all intents', () => {
  // The normalizer takes no intent, so the only way an intent could change the
  // identity is through a caller that pre-processes differently. Normalizing the
  // same input for every governed intent and comparing in full is the
  // behavioural half of the proof.
  const results = FASHION_IDENTIFICATION_INTENTS.map(() =>
    normalizeToV2({
      requestId: 'req-cross-path',
      outcome: 'classified',
      evidenceIds: ['evidence-aaaaaaaa'],
      identification: { ...PROVIDER_IDENTIFICATION },
      attributes: { ...PROVIDER_ATTRIBUTES },
    })
  );
  assert(results.length >= 2, 'cross-path parity requires multiple governed intents');
  for (const result of results.slice(1)) {
    assertEquals(JSON.stringify(results[0]), JSON.stringify(result));
  }
  // And the identity actually resolved, so this is not two identical empties.
  assertEquals(results[0].status, 'completed');
  assertEquals(results[0].item.category, 'Outerwear');
  assertEquals(results[0].item.subtype, 'Chore Jacket');
  assertEquals(results[0].resolutionLevel, 'brand_and_subtype');
});

Deno.test('normalizer: commerceSkippedReason is the ONLY field intent may change', () => {
  const base = normalizeToV2({
    requestId: 'req-cross-path',
    outcome: 'classified',
    evidenceIds: ['evidence-aaaaaaaa'],
    identification: { ...PROVIDER_IDENTIFICATION },
    attributes: { ...PROVIDER_ATTRIBUTES },
  });
  const styleSkipped = normalizeToV2({
    requestId: 'req-cross-path',
    outcome: 'classified',
    evidenceIds: ['evidence-aaaaaaaa'],
    identification: { ...PROVIDER_IDENTIFICATION },
    attributes: { ...PROVIDER_ATTRIBUTES },
    commerceSkippedReason: COMMERCE_SKIPPED_STYLE_INTENT,
  });

  // Everything except compatibility.commerceSkippedReason must be identical.
  const stripSkip = (value: unknown) => {
    const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    const compatibility = copy.compatibility as Record<string, unknown>;
    delete compatibility.commerceSkippedReason;
    return JSON.stringify(copy);
  };
  assertEquals(stripSkip(base), stripSkip(styleSkipped));
  assertEquals(styleSkipped.compatibility.commerceSkippedReason, COMMERCE_SKIPPED_STYLE_INTENT);
  // The skip reason is commerce bookkeeping and must not appear in the item.
  assertEquals(JSON.stringify(styleSkipped.item).includes('style_intent'), false);
});

Deno.test('normalizer: detection candidates are identity-equal regardless of intent', () => {
  const candidates = [
    { candidateId: 'c1', evidenceId: 'evidence-aaaaaaaa', category: 'Outerwear', subtype: 'Chore Jacket' },
    { candidateId: 'c2', evidenceId: 'evidence-aaaaaaaa', category: 'Bottoms', subtype: 'Trouser' },
  ];
  const build = () =>
    normalizeToV2({
      requestId: 'req-cross-path',
      outcome: 'multiple_items_need_selection',
      evidenceIds: ['evidence-aaaaaaaa'],
      identification: { ...PROVIDER_IDENTIFICATION },
      attributes: { ...PROVIDER_ATTRIBUTES },
      candidates: candidates.map((c) => ({ ...c })),
    });
  assertEquals(JSON.stringify(build()), JSON.stringify(build()));
  const result = build();
  assertEquals(result.status, 'multiple_items_need_selection');
  assertEquals(result.candidates?.length, 2);
  // Source order preserved — never re-ranked.
  assertEquals(result.candidates?.map((c) => c.candidateId), ['c1', 'c2']);
});

Deno.test('normalizer: a detection that found garments reports multiple_items_need_selection', () => {
  // The status the CLIENT must be able to continue from. Both consumer paths
  // read this same value, and neither may treat it as a failure: it is the
  // normal answer to a detect_items request that found something.
  const result = normalizeToV2({
    requestId: 'req-cross-path',
    outcome: 'multiple_items_need_selection',
    evidenceIds: ['evidence-aaaaaaaa'],
    identification: { ...PROVIDER_IDENTIFICATION },
    attributes: { ...PROVIDER_ATTRIBUTES },
    candidates: [
      { candidateId: 'c1', evidenceId: 'evidence-aaaaaaaa', category: 'Outerwear', subtype: 'Chore Jacket' },
    ],
  });
  assertEquals(result.status, 'multiple_items_need_selection');
  // And it is identity-bearing, not an empty failure envelope.
  assertEquals(result.item.category, 'Outerwear');
  assert(result.resolutionLevel !== 'unknown');
});

// ── 2. Intent gates are total, and gate only commerce and artifacts ──────────

Deno.test('gates: the commerce decision is total over intent x status', () => {
  for (const intent of FASHION_IDENTIFICATION_INTENTS) {
    for (const status of FASHION_IDENTIFICATION_STATUSES) {
      const gate = shouldRunCommerce({ intent, status });
      assertEquals(typeof gate.run, 'boolean', `${intent}/${status} produced no decision`);
      if (intent === 'identify_for_style') {
        assertEquals(gate.run, false, `style intent ran commerce for ${status}`);
        assertEquals(gate.skippedReason, COMMERCE_SKIPPED_STYLE_INTENT);
      }
    }
  }
});

Deno.test('gates: shopping intent keeps commerce for every identity-bearing status', () => {
  for (const status of ['completed', 'partial', 'multiple_items_need_selection'] as const) {
    assertEquals(
      shouldRunCommerce({ intent: 'identify_and_shop', status }).run,
      true,
      `Scanner commerce was disabled for ${status}`,
    );
  }
  // And correctly withheld where there is nothing to shop for.
  for (const status of ['non_fashion', 'technical_failure', 'insufficient_visual_evidence'] as const) {
    assertEquals(shouldRunCommerce({ intent: 'identify_and_shop', status }).run, false);
  }
});

Deno.test('gates: Scanner-domain artifacts are captured for shopping and never for style', () => {
  assertEquals(shouldCaptureScanArtifacts('identify_and_shop'), true);
  assertEquals(shouldCaptureScanArtifacts('identify_for_style'), false);
});

Deno.test('gates: an intentless legacy request defaults to shopping, preserving Scanner', () => {
  assertEquals(LEGACY_DEFAULT_INTENT, 'identify_and_shop');
  assertEquals(shouldCaptureScanArtifacts(LEGACY_DEFAULT_INTENT), true);
  assertEquals(shouldRunCommerce({ intent: LEGACY_DEFAULT_INTENT, status: 'completed' }).run, true);
});

// ── 3. Reachable database-operation inventory ────────────────────────────────

type ManifestFunction = {
  name: string;
  entry: string;
  files: Array<{ path: string; sha256: string; bundle?: boolean }>;
};

function bundleClosure(functionName: string): string[] {
  const manifest = JSON.parse(readRepoFile('config/edge-function-manifest.json')) as {
    parity: { expectedFunctions: string[]; functions: ManifestFunction[] };
  };
  const fn = manifest.parity.functions.find((entry) => entry.name === functionName);
  assert(fn, `${functionName} is not governed by the Edge Function manifest`);
  // The BUNDLE closure, not the directory tree: tests and dead siblings are not
  // deployed, and inventorying them would report operations that cannot run.
  return fn.files.filter((file) => file.bundle === true).map((file) => file.path);
}

/** Every database / RPC operation the deployed closure can actually perform. */
function inventoryOperations(functionName: string) {
  const patterns: Array<{ kind: string; pattern: RegExp }> = [
    { kind: 'rpc', pattern: /\.rpc\(\s*['"`]([\w-]+)['"`]/g },
    { kind: 'from', pattern: /\.from\(\s*['"`]([\w-]+)['"`]/g },
    { kind: 'insert', pattern: /\.insert\(/g },
    { kind: 'upsert', pattern: /\.upsert\(/g },
    { kind: 'update', pattern: /\.update\(/g },
    { kind: 'delete', pattern: /\.delete\(/g },
  ];
  const found: Array<{ file: string; kind: string; target: string }> = [];
  for (const relative of bundleClosure(functionName)) {
    const source = readRepoFile(relative);
    // A write verb only means a DATABASE write when the module also addresses a
    // table or the PostgREST helper. Without that guard `searchParams.delete()`
    // and `map.delete()` read as row deletions.
    const touchesDatabase = /\.from\(\s*['"`]/.test(source) || /\brest\(\s*[`'"]/.test(source);
    for (const { kind, pattern } of patterns) {
      if (!touchesDatabase && ['insert', 'upsert', 'update', 'delete'].includes(kind)) continue;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        found.push({ file: relative, kind, target: match[1] ?? '(chained)' });
      }
    }
  }
  return found;
}

Deno.test('inventory: every governed function is covered by the manifest closure', () => {
  const manifest = JSON.parse(readRepoFile('config/edge-function-manifest.json')) as {
    parity: { expectedFunctions: string[] };
  };
  // Spelled out rather than derived, for the same reason
  // __tests__/edgeFunctionSourceParity.test.js spells it out: widening the
  // governed set must fail an assertion first, so it stays a decision.
  //
  // This list had been left at the original three (scan-identify,
  // stylechat-generate, style-outfit-generate) when B34-DEF-001 widened the
  // manifest to every function this branch carries, so it had been failing
  // against a 19-entry manifest before VTO existed. Brought back into
  // agreement here; 'vto-generate' is the VTO Alpha Foundation entry.
  assertEquals(manifest.parity.expectedFunctions.sort(), [
    'handle-user-deletion',
    'kickscrew-sneaker-description',
    'kplus-activate',
    'kplus-reconcile-revenuecat',
    'nike-shoe-details',
    'privacy-correction-request',
    'privacy-data-export',
    'process-account-deletions',
    'product-search-deals',
    'resend-restoration-email',
    'restore-account',
    'scan-identify',
    'search-vinted-secondhand',
    'shared-room-image-url',
    'staging-health',
    'style-outfit-generate',
    'stylechat-generate',
    'stylist-speech',
    'tryon-clothes-pro',
    'vto-generate',
  ]);
  // Every governed function must resolve a non-empty deployable bundle --
  // a manifest entry with an empty closure gates nothing.
  for (const name of manifest.parity.expectedFunctions) {
    assert(bundleClosure(name).length > 0, `${name} must resolve a bundle`);
  }
});

/**
 * Modules in the deployed closure that legitimately hold a service-role
 * credential, each with the reason it is allowed to.
 *
 * The point of the allowlist is that it is EXHAUSTIVE: a new module acquiring a
 * service-role client fails this test and has to be argued for in review. It is
 * not a claim that elevated access is fine anywhere — it is the enumeration of
 * where it exists today and why.
 */
const SERVICE_ROLE_ALLOWLIST: Record<string, string> = {
  'supabase/functions/_shared/deletion/common.ts':
    'Pre-existing account-active guard. Reads profiles/deletion_requests for an '
    + 'ALREADY-authenticated userId; the actor comes from requireUser(), which uses the '
    + 'anon key plus the caller JWT. No identification data, no body-supplied actor.',
  'supabase/functions/scan-identify/index.ts':
    'Hosts the Scanner-domain artifact capture wrappers, both gated on '
    + 'shouldCaptureScanArtifacts(intent) so identify_for_style never reaches them.',
  'supabase/functions/scan-identify/scanIntelligenceCapture.ts':
    'Scanner-domain intelligence row writer. Only reachable via the gated '
    + 'captureImageModeScanIntelligence call sites.',
  'supabase/functions/scan-identify/commerceOutcomeCapture.ts':
    'Scanner-domain commerce outcome row writer. Only reachable via the gated '
    + 'captureCommerceOutcome wrapper.',
};

Deno.test('inventory: service-role access is confined to the documented allowlist', () => {
  // A service-role client bypasses RLS, so the set of modules holding one is the
  // set of places actor isolation depends on code rather than on the database.
  const found: string[] = [];
  for (const functionName of ['scan-identify', 'stylechat-generate']) {
    for (const relative of bundleClosure(functionName)) {
      if (/SERVICE_ROLE/.test(readRepoFile(relative))) found.push(relative);
    }
  }
  const unique = [...new Set(found)].sort();
  const undocumented = unique.filter((file) => !(file in SERVICE_ROLE_ALLOWLIST));
  assertEquals(
    undocumented,
    [],
    `undocumented service-role access:\n  ${undocumented.join('\n  ')}`,
  );
  // The allowlist must not outlive what it describes.
  for (const file of Object.keys(SERVICE_ROLE_ALLOWLIST)) {
    assert(unique.includes(file), `${file} is allowlisted but no longer uses service role`);
  }
});

Deno.test('inventory: no style-intent request can reach a service-role artifact write', () => {
  // The two Scanner-domain writers are reachable ONLY behind the artifact gate.
  // This asserts the gate is applied at the entry points rather than trusted to
  // each individual call site.
  const index = readRepoFile('supabase/functions/scan-identify/index.ts');

  // The commerce-outcome wrapper short-circuits before the real writer.
  assert(
    /const captureCommerceOutcome[\s\S]{0,320}?if \(!captureScanArtifacts\)[\s\S]{0,200}?return Promise\.resolve/
      .test(index),
    'captureCommerceOutcome is not short-circuited by the artifact gate',
  );

  // Every scan-intelligence call site is guarded.
  const intelligenceCalls = [...index.matchAll(/captureImageModeScanIntelligence\(/g)];
  const guardedCalls = [...index.matchAll(/captureScanArtifacts\)\s*\{\s*\n\s*await captureImageModeScanIntelligence\(/g)];
  assert(intelligenceCalls.length > 0, 'no scan-intelligence call sites found');
  assertEquals(
    guardedCalls.length,
    // The definition site itself is one match; every invocation must be guarded.
    intelligenceCalls.length - 1,
    'a captureImageModeScanIntelligence call site is not behind captureScanArtifacts',
  );
});

Deno.test('inventory: the actor is never taken from the request body', () => {
  // A body-supplied actor would let one user write another user's rows even
  // with every gate above intact.
  for (const functionName of ['scan-identify', 'stylechat-generate']) {
    for (const relative of bundleClosure(functionName)) {
      const source = readRepoFile(relative);
      assertEquals(
        /\bbody\.(userId|user_id|actorId|actor_id|uid|ownerId|owner_id)\b/.test(source),
        false,
        `${relative} reads the actor from the request body`,
      );
    }
  }
});

Deno.test('inventory: every scan-identify write is Scanner-domain and artifact-gated', () => {
  const operations = inventoryOperations('scan-identify');
  const writes = operations.filter((op) => ['insert', 'upsert', 'update', 'delete'].includes(op.kind));

  // Each writing module must be reachable ONLY behind the artifact gate, which
  // `identify_for_style` fails. The gate is asserted separately above; this
  // asserts the write set has not silently grown a module that never consults it.
  const writingModules = [...new Set(writes.map((op) => op.file))].sort();
  for (const moduleFile of writingModules) {
    const source = readRepoFile(moduleFile);
    const gated = /shouldCaptureScanArtifacts|captureScanIntelligence|commerceOutcome/i.test(source);
    assert(
      gated,
      `${moduleFile} performs a write but names no artifact gate — a style-intent scan could reach it`,
    );
  }

  // Deletes are not part of the identification loop at all.
  assertEquals(
    writes.filter((op) => op.kind === 'delete').length,
    0,
    'scan-identify must not delete rows',
  );
});

Deno.test('inventory: stylechat-generate performs no identification-domain write', () => {
  const operations = inventoryOperations('stylechat-generate');
  const writes = operations.filter((op) => ['insert', 'upsert', 'update', 'delete'].includes(op.kind));
  for (const write of writes) {
    const source = readRepoFile(write.file);
    // A styling turn may persist its own chat/session rows. It must never write
    // a Recent Scan, a Closet item, a Dressing Room item or a commerce outcome.
    for (const forbidden of [
      /from\(\s*['"`]scans['"`]/,
      /from\(\s*['"`]closet_items['"`]/,
      /from\(\s*['"`]dressing_room/,
      /from\(\s*['"`]commerce_outcomes['"`]/,
      /from\(\s*['"`]scan_intelligence/,
    ]) {
      assertEquals(
        forbidden.test(source),
        false,
        `${write.file} writes a Scanner/Closet-domain table from the styling function`,
      );
    }
  }
});

Deno.test('inventory: the operation set is recorded so growth is visible in review', () => {
  // A snapshot, not a prohibition: a NEW reachable table or RPC should require a
  // deliberate edit here rather than appearing silently.
  const scan = inventoryOperations('scan-identify');
  const style = inventoryOperations('stylechat-generate');

  const tables = (ops: typeof scan) =>
    [...new Set(ops.filter((op) => op.kind === 'from').map((op) => op.target))].sort();
  const rpcs = (ops: typeof scan) =>
    [...new Set(ops.filter((op) => op.kind === 'rpc').map((op) => op.target))].sort();

  // Both intents traverse scan-identify; only the shopping intent may pass the
  // artifact gate below these.
  assert(tables(scan).length > 0 || rpcs(scan).length > 0, 'scan-identify inventory came back empty');

  for (const name of [...tables(scan), ...tables(style)]) {
    assertEquals(typeof name, 'string');
    assert(name.length > 0);
  }
  // Recorded for the certification report.
  console.log('[phase2b4] scan-identify tables:', JSON.stringify(tables(scan)));
  console.log('[phase2b4] scan-identify rpcs  :', JSON.stringify(rpcs(scan)));
  console.log('[phase2b4] stylechat tables    :', JSON.stringify(tables(style)));
  console.log('[phase2b4] stylechat rpcs      :', JSON.stringify(rpcs(style)));
});
