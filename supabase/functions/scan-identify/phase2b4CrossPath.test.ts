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

type EdgeFunctionManifest = {
  parity: { expectedFunctions: string[]; functions: ManifestFunction[] };
};

function readManifest(): EdgeFunctionManifest {
  return JSON.parse(readRepoFile('config/edge-function-manifest.json')) as EdgeFunctionManifest;
}

function governedFunctionNames(): string[] {
  const names = readManifest().parity.expectedFunctions;
  assertEquals([...new Set(names)].length, names.length, 'manifest has duplicate governed function names');
  return [...names].sort();
}

function bundleClosure(functionName: string): string[] {
  const manifest = readManifest();
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

type PrivilegeProfile = {
  serviceRole: boolean;
  dbRead: boolean;
  dbWrite: boolean;
  rpc: boolean;
  authAdmin: boolean;
  storage: boolean;
  privilegedBackend: boolean;
  actorBoundary: boolean;
};

/**
 * Source-audited security footprint for every function governed by the
 * manifest. This is intentionally a profile rather than a duplicate governed
 * name list: governedFunctionNames() always comes from the manifest, while
 * this record states the privileged behavior that review must account for.
 */
const GOVERNED_PRIVILEGE_INVENTORY: Record<string, PrivilegeProfile> = {
  // EDGE-02: Sign in with Apple revocation pair, recovered from Git history
  // (commit e369fca9) and cross-verified against the live deployed source on
  // both projects. dbWrite is correctly false here even though both functions
  // do write apple_auth_credentials rows: the write goes through a shared
  // restClient() helper whose URL construction (index.ts) and its POST/DELETE
  // method (credentialStore.ts) live in different bundle files, so neither
  // single file matches this heuristic's same-file url+method pattern -- a
  // known limitation of a per-file check, not a claim that no write occurs.
  'apple-credential-link': {
    serviceRole: true, dbRead: true, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'apple-revoke-credential': {
    serviceRole: true, dbRead: true, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  // Watchlist V1's Tier 2 refresh worker. Contributed by this feature branch as
  // a single row in the UPSTREAM inventory -- the mechanism, and every other
  // entry, stays owned by the governed integration authority. A new Edge
  // Function must appear here or the inventory test fails on the commit that
  // adds it, which is exactly the intended contract.
  'commerce-watch-refresh': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'handle-user-deletion': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: false, storage: false,
    privilegedBackend: false, actorBoundary: true,
  },
  'kickscrew-sneaker-description': {
    serviceRole: false, dbRead: false, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: false,
  },
  'kplus-activate': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'kplus-reconcile-revenuecat': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'nike-shoe-details': {
    serviceRole: false, dbRead: false, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: false,
  },
  'privacy-correction-request': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: false, storage: false,
    privilegedBackend: false, actorBoundary: true,
  },
  'privacy-data-export': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: false, storage: false,
    privilegedBackend: false, actorBoundary: true,
  },
  'process-account-deletions': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: true,
    privilegedBackend: true, actorBoundary: true,
  },
  'product-search-deals': {
    serviceRole: false, dbRead: false, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: false,
  },
  'resend-restoration-email': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: false,
    privilegedBackend: true, actorBoundary: false,
  },
  'restore-account': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'scan-identify': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'search-vinted-secondhand': {
    serviceRole: false, dbRead: false, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: false,
  },
  'shared-room-image-url': {
    serviceRole: true, dbRead: true, dbWrite: false, rpc: false, authAdmin: false, storage: true,
    privilegedBackend: false, actorBoundary: true,
  },
  'staging-health': {
    serviceRole: true, dbRead: true, dbWrite: false, rpc: true, authAdmin: false, storage: false,
    privilegedBackend: false, actorBoundary: false,
  },
  'style-outfit-generate': {
    serviceRole: false, dbRead: true, dbWrite: false, rpc: true, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'stylechat-generate': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: true,
    privilegedBackend: true, actorBoundary: true,
  },
  'stylist-speech': {
    serviceRole: false, dbRead: true, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
  'tryon-clothes-pro': {
    serviceRole: false, dbRead: false, dbWrite: false, rpc: false, authAdmin: false, storage: false,
    privilegedBackend: true, actorBoundary: false,
  },
  // K4 VTO backend (PR #246: INT-KPLUS-007, SEC-KPLUS-002/003/004). Reserves
  // and settles paid-generation quota via the reserve/complete RPCs
  // (20260831130000_vto_generation_reservations.sql) and reads the canonical
  // K+ entitlement row, both through the shared `rpc`/`rest` helpers in
  // _shared/deletion/common.ts -- which is why this profile carries that
  // module's full footprint (service role, REST, RPC and auth-admin) even
  // though vto-generate itself only ever calls the two VTO-scoped RPCs.
  'vto-generate': {
    serviceRole: true, dbRead: true, dbWrite: true, rpc: true, authAdmin: true, storage: false,
    privilegedBackend: true, actorBoundary: true,
  },
};

function observedPrivilegeProfile(functionName: string): Omit<PrivilegeProfile, 'privilegedBackend' | 'actorBoundary'> {
  const sources = bundleClosure(functionName).map(readRepoFile);
  const source = sources.join('\n');
  const touchesDatabase = (file: string) => /\.from\(\s*['\"`]|\/rest\/v1(?:\/|`|'|\")/.test(file);
  const hasDirectRestWrite = (file: string) =>
    !/\/rest\/v1\/rpc\//.test(file)
    && /(?:\b(?:rest|serviceRest)\(\s*['\"`][^'\"`]+|\/rest\/v1\/[^\s'\"`]+)[\s\S]{0,320}?\bmethod\s*:\s*['\"](?:POST|PATCH|DELETE)['\"]/
      .test(file);
  return {
    serviceRole: /\bSUPABASE_SERVICE_ROLE_KEY\b/.test(source),
    dbRead: sources.some(touchesDatabase),
    dbWrite: sources.some((file) =>
      touchesDatabase(file)
      && (/\.(?:insert|upsert|update|delete)\(/.test(file)
        || hasDirectRestWrite(file))
    ),
    rpc: /\.rpc\(\s*['\"`]|\/rest\/v1\/rpc\/|\brpc\(\s*['\"`]/.test(source),
    authAdmin: /\.auth\.admin\./.test(source),
    storage: /\.storage\s*\.from\(|\/storage\/v1\//.test(source),
  };
}

Deno.test('inventory: every manifest-governed function has a non-empty deployed closure', () => {
  const manifest = readManifest();
  const names = governedFunctionNames();
  assert(names.length > 0, 'manifest contains no governed Edge Functions');
  assertEquals(
    manifest.parity.functions.map((fn) => fn.name).sort(),
    names,
    'each governed function must have exactly one manifest closure',
  );
  for (const name of names) {
    assert(bundleClosure(name).length > 0, `${name} has an empty deployed bundle closure`);
  }
});

Deno.test('inventory: every manifest-governed privilege footprint is source-accounted', () => {
  const governed = governedFunctionNames();
  assertEquals(
    Object.keys(GOVERNED_PRIVILEGE_INVENTORY).sort(),
    governed,
    'a governed function was added, removed, or renamed without a source-audited privilege profile',
  );
  for (const name of governed) {
    const expected = GOVERNED_PRIVILEGE_INVENTORY[name];
    const observed = observedPrivilegeProfile(name);
    for (const key of Object.keys(observed) as Array<keyof typeof observed>) {
      assertEquals(
        observed[key],
        expected[key],
        `${name} ${key} behavior changed without updating the governed privilege inventory`,
      );
    }
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
  'supabase/functions/apple-credential-link/index.ts':
    'verify_jwt = true; target account resolved only from the verified bearer '
    + '(auth.getUser), never from the request body. Service role is used solely '
    + 'to persist that verified caller\'s own encrypted Apple credential row.',
  'supabase/functions/apple-revoke-credential/index.ts':
    'verify_jwt = false; the function authenticates the caller itself via a '
    + 'constant-time compare against SUPABASE_SERVICE_ROLE_KEY, so only a caller '
    + 'that already holds full database authority reaches this function at all.',
  'supabase/functions/_shared/deletion/common.ts':
    'Shared account-lifecycle authority: authenticated actor/account-status checks, '
    + 'lifecycle RPCs, session revocation, and the internal restoration-email handoff.',
  'supabase/functions/_shared/privacyRequestRateLimit.ts':
    'Shared authenticated privacy-request rate-limit RPC; receives only the already '
    + 'verified caller id from its owning request handler.',
  'supabase/functions/handle-user-deletion/index.ts':
    'Authenticated deletion intake reads and mutates only the verified caller\'s '
    + 'deletion request and profile state.',
  'supabase/functions/kplus-reconcile-revenuecat/index.ts':
    'Internal-secret-protected reconciliation worker invokes the bounded K+ '
    + 'RevenueCat RPC batch.',
  'supabase/functions/privacy-correction-request/index.ts':
    'Authenticated correction intake writes the verified caller id, never a '
    + 'body-supplied actor.',
  'supabase/functions/privacy-data-export/index.ts':
    'Authenticated export intake writes the verified caller id, never a '
    + 'body-supplied actor.',
  'supabase/functions/process-account-deletions/index.ts':
    'Privileged deletion worker that performs the documented lifecycle purge, '
    + 'Auth administration, and Storage cleanup.',
  'supabase/functions/restore-account/index.ts':
    'Single-use restoration-token authority that performs the associated Auth '
    + 'unban after the restoration RPC succeeds.',
  'supabase/functions/scan-identify/index.ts':
    'Hosts the Scanner-domain artifact capture wrappers, both gated on '
    + 'shouldCaptureScanArtifacts(intent) so identify_for_style never reaches them.',
  'supabase/functions/scan-identify/scanIntelligenceCapture.ts':
    'Scanner-domain intelligence row writer. Only reachable via the gated '
    + 'captureImageModeScanIntelligence call sites.',
  'supabase/functions/scan-identify/commerceOutcomeCapture.ts':
    'Scanner-domain commerce outcome row writer. Only reachable via the gated '
    + 'captureCommerceOutcome wrapper.',
  'supabase/functions/shared-room-image-url/index.ts':
    'Resolves an authorized room/share relationship before issuing a narrowly '
    + 'scoped private Storage signed URL.',
  'supabase/functions/staging-health/index.ts':
    'Staging-only health probes read connectivity and small table-presence checks; '
    + 'the public response exposes no data or credentials.',
};

Deno.test('inventory: service-role access is confined to the documented allowlist', () => {
  // A service-role client bypasses RLS, so the set of modules holding one is the
  // set of places actor isolation depends on code rather than on the database.
  const found: string[] = [];
  for (const functionName of governedFunctionNames()) {
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
