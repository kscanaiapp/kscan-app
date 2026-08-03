// Enforces the rule that makes an un-deployed repository safe.
//
// `check-edge-function-parity.js` compares the committed manifest against the
// current source. It is a REPO-INTERNAL check — it never contacts Supabase — so
// a green parity gate proves the manifest is up to date, NOT that the
// repository matches production. Once the repository moves ahead (as it does
// from Checkpoint 3 onward), that distinction stops being academic: someone
// reading a passing gate could reasonably conclude a deploy is a no-op.
//
// The rule this file enforces:
//
//   The repository may be ahead of production, but ONLY while every
//   behavioural change it adds sits behind a flag that defaults off.
//
// Which means a deploy from this checkout changes nothing until an operator
// deliberately turns something on — the same property that makes the drift
// reconciliation safe, applied in the opposite direction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'deployed-edge-baseline.json'), 'utf8'),
);
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'edge-function-manifest.json'), 'utf8'),
);

function manifestFor(name) {
  return MANIFEST.parity.functions.find((fn) => fn.name === name);
}

test('the deployed baseline records what production was actually running', () => {
  assert.equal(BASELINE.projectRef, MANIFEST.parity.approvedProjectRef);
  assert.equal(BASELINE.functions['scan-identify'].deployedVersion, 141);
  assert.equal(BASELINE.functions['stylechat-generate'].deployedVersion, 84);
  for (const name of Object.keys(BASELINE.functions)) {
    assert.ok(manifestFor(name), `${name} must also be governed by the manifest`);
  }
});

test('divergence from the deployed baseline is declared, not implicit', () => {
  const diverged = Object.entries(BASELINE.functions).filter(([name, recorded]) => {
    const current = manifestFor(name);
    return current && current.bundleHash !== recorded.bundleHashAtThatCommit;
  });

  // Not an assertion that divergence is absent — it is expected from
  // Checkpoint 3 on. The assertion is that when it exists, the rule that makes
  // it safe is written down alongside it.
  if (diverged.length > 0) {
    assert.match(
      BASELINE.aheadOfProductionRule,
      /only while every behavioural change it adds is behind a flag that defaults off/,
    );
    assert.ok(
      Array.isArray(BASELINE.checkpoint3Flags) && BASELINE.checkpoint3Flags.length > 0,
      'a diverged repository must name the flags holding its new behaviour back',
    );
  }
});

test('every flag named in the baseline actually defaults to disabled', () => {
  // The rule above is only worth anything if the flags really are off. Each
  // default is read from source rather than trusted from the JSON.
  const sources = {
    SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED: [
      'supabase/functions/scan-identify/multiItemSelectionContract.ts',
      /SELECTION_CONTRACT_DEFAULT_ENABLED\s*=\s*false/,
    ],
    SCAN_PRODUCT_MATCH_ENABLED: [
      'supabase/functions/scan-identify/productMatchBridge.ts',
      /PRODUCT_MATCH_BRIDGE_DEFAULT_ENABLED\s*=\s*false/,
    ],
    SCAN_SIMILAR_ITEM_FLAG_ENABLED: [
      'supabase/functions/scan-identify/scanJourneyContract.ts',
      /SIMILAR_ITEM_FLAG_DEFAULT_ENABLED\s*=\s*false/,
    ],
  };

  for (const flag of BASELINE.checkpoint3Flags) {
    const entry = sources[flag];
    assert.ok(entry, `${flag} is named in the baseline but has no known default declaration`);
    const [relative, pattern] = entry;
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, pattern, `${flag} must default to disabled in ${relative}`);
    // And the flag string itself must appear, so a rename cannot leave the
    // baseline naming a flag nothing reads.
    assert.ok(source.includes(flag), `${relative} must read the env var ${flag}`);
  }
});

test('the Checkpoint 3 modules are inside the governed scan-identify bundle', () => {
  // If they were not, the parity gate would not notice them changing, and the
  // whole point of regenerating the manifest would be lost.
  const scanIdentify = manifestFor('scan-identify');
  const bundled = new Set(
    scanIdentify.files.filter((file) => file.bundle).map((file) => file.path),
  );
  for (const required of [
    'supabase/functions/_shared/scanJourneyState.ts',
    'supabase/functions/scan-identify/multiItemSelectionContract.ts',
    'supabase/functions/scan-identify/productMatchBridge.ts',
    'supabase/functions/scan-identify/scanJourneyContract.ts',
    'supabase/functions/scan-identify/existingItemCandidates.ts',
  ]) {
    assert.ok(bundled.has(required), `${required} must be part of the governed bundle`);
  }
});

test('product-match is still NOT governed, because it is still not deployed', () => {
  // The bridge calls it over HTTP and degrades cleanly when it 404s, so the
  // repository can carry the caller before the callee exists. Adding it to the
  // manifest would make `deploy-edge-functions.js` deploy it.
  assert.ok(!MANIFEST.parity.expectedFunctions.includes('product-match'));
});
