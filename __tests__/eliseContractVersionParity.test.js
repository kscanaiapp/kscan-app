/**
 * Cross-deployable contract-version parity for the Elise / Dressing Room path.
 *
 * WHY THIS EXISTS: the client (React Native, `types/`) and the backend (Deno
 * Edge Functions, `supabase/functions/`) are separate deployables that cannot
 * import from one another — Deno modules use explicit `.ts` specifiers the RN
 * bundler will not resolve. Every request-shaping contract version is therefore
 * MIRRORED, and several of those mirrors were held identical by nothing but
 * convention.
 *
 * That matters because these constants are not documentation: the backend
 * rejects a request whose `contractVersion` does not equal its own copy. A
 * one-sided bump does not fail a build, fail a type check, or fail any existing
 * test — it ships and every request from the older side starts being refused at
 * runtime.
 *
 * Two of these pairs were already gated:
 *   FASHION_IDENTIFICATION_CONTRACT_V2  — fashionIdentificationContractParity
 *   FASHION_REASONING_CONTRACT_VERSION  — styleOutfitEdgeContract
 * The three below had no cross-deployable assertion at all. This closes that
 * gap without restructuring the repository to deduplicate a string, which would
 * be a far larger change than the risk warrants.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Extracts `export const NAME = 'value';` from a TS mirror.
 *
 * Intentionally literal-only, matching the reader in
 * fashionIdentificationContractParity: if a mirror ever computes its version at
 * runtime this fails loudly rather than silently passing, because a computed
 * version cannot be compared across deployables by reading source.
 */
function extractStringConstant(relativePath, name) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*'([^']*)'(?:\\s+as const)?\\s*;`),
  );
  assert.ok(
    match,
    `${name} not found as a literal string constant in ${relativePath}`,
  );
  return match[1];
}

/**
 * Each entry is one contract the client and backend must agree on, with the
 * consequence spelled out so a future failure explains itself.
 */
const MIRRORED_CONTRACTS = [
  {
    name: 'STYLECHAT_ATTACHMENT_CONTRACT_VERSION',
    client: 'types/styleChatAttachments.ts',
    backend: 'supabase/functions/stylechat-generate/attachments.ts',
    consequence:
      'stylechat-generate refuses attachment requests whose contractVersion is not its own, ' +
      'so a one-sided bump silently disables every Elise visual attachment.',
  },
  {
    name: 'ELISE_FASHION_CONTEXT_V2',
    client: 'types/fashionIdentificationV2.ts',
    backend: 'supabase/functions/stylechat-generate/fashionContextV2.ts',
    consequence:
      'fashionContextV2 rejects a context envelope whose contractVersion differs, ' +
      'so Elise would silently lose all V2 fashion context and answer ungrounded.',
  },
  {
    name: 'ELISE_ADVICE_CONTRACT_VERSION',
    client: 'types/eliseAdvice.ts',
    backend: 'supabase/functions/stylechat-generate/eliseAdviceTypes.ts',
    consequence:
      'the advice envelope is stamped with this version and validated against it, ' +
      'so a one-sided bump makes structured advice unparseable to the client.',
  },
];

for (const contract of MIRRORED_CONTRACTS) {
  test(`${contract.name} is identical in the client and backend mirrors`, () => {
    const client = extractStringConstant(contract.client, contract.name);
    const backend = extractStringConstant(contract.backend, contract.name);
    assert.equal(
      backend,
      client,
      `${contract.name} drifted: ${contract.backend} has '${backend}' but ` +
        `${contract.client} has '${client}'. ${contract.consequence}`,
    );
  });

  test(`${contract.name} is a non-empty version string on both sides`, () => {
    // An empty or whitespace version compares equal on both sides while
    // matching nothing meaningful at runtime.
    for (const relative of [contract.client, contract.backend]) {
      const value = extractStringConstant(relative, contract.name);
      assert.ok(value.trim().length > 0, `${contract.name} is empty in ${relative}`);
    }
  });
}

test('every mirrored contract in this gate names two distinct deployables', () => {
  // Guards the gate itself: a copy/paste error that pointed both sides at the
  // same file would make every assertion above trivially true.
  for (const contract of MIRRORED_CONTRACTS) {
    assert.notEqual(
      contract.client,
      contract.backend,
      `${contract.name} compares a file against itself`,
    );
    assert.ok(contract.client.startsWith('types/'), contract.name);
    assert.ok(contract.backend.startsWith('supabase/functions/'), contract.name);
  }
});

test('the already-gated contracts remain gated elsewhere', () => {
  // These two are deliberately NOT re-asserted here; this test fails if the
  // gate that does cover them is deleted, so coverage cannot silently vanish
  // just because this file looks like the obvious home for it.
  const identityGate = fs.readFileSync(
    path.join(ROOT, '__tests__', 'fashionIdentificationContractParity.test.js'),
    'utf8',
  );
  assert.match(
    identityGate,
    /contract version string is identical across schema and both mirrors/,
    'FASHION_IDENTIFICATION_CONTRACT_V2 lost its parity gate',
  );

  const reasoningGate = fs.readFileSync(
    path.join(ROOT, '__tests__', 'styleOutfitEdgeContract.test.js'),
    'utf8',
  );
  assert.match(
    reasoningGate,
    /FASHION_REASONING_CONTRACT_VERSION/,
    'FASHION_REASONING_CONTRACT_VERSION lost its parity gate',
  );
});
