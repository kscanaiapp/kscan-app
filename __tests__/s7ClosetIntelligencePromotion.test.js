/**
 * S7 / Closet V2 — Closet intelligence, client vs staging vs production.
 *
 * THE CLIENT CONTRACT IS NOT DEFECTIVE, and this file exists to say so with
 * evidence. The mobile client sends `closetIntelligenceContext`; this
 * repository's `stylechat-generate` parses and consumes it; deployed STAGING
 * (v91) matches source. Deployed PRODUCTION (v90) contains ZERO references to
 * the key, so it is silently dropped — the request succeeds, Elise answers, and
 * the wardrobe reasoning the feature exists to provide is simply absent. There
 * is no error and no degraded-mode signal, which is exactly why it went
 * unnoticed.
 *
 * So this is a DEPLOYMENT gap, not a code gap. No client change is made and no
 * second transport is built: inventing an alternative path around a function
 * that is merely out of date would be new architecture solving the wrong
 * problem. What this file does is pin the client→server pair so the two cannot
 * drift while the promotion is pending, and keep the delta recorded.
 *
 * Reference counts read from the deployed function bodies on 2026-08-15:
 *
 *   source                          closetIntelligenceContext  13
 *   staging  v91  yzqjvdfgefveprobvvyw                         13
 *   production v90  wyyuqfdxucjksghsmhry                        0
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('the client sends closetIntelligenceContext on the real request', () => {
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');

  // Present on the request input contract...
  assert.match(provider, /closetIntelligenceContext\?: ClosetIntelligenceContext \| null;/);
  // ...and actually placed on the outbound body, not merely accepted.
  assert.match(
    provider,
    /\.\.\.\(input\.closetIntelligenceContext[\s\S]{0,120}\{ closetIntelligenceContext: input\.closetIntelligenceContext \}/,
    'the field must reach the request body',
  );
});

test('the certified server generation parses and consumes it', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');

  // Accepted off the wire...
  assert.match(index, /closetIntelligenceContext\?: unknown;/);
  assert.match(index, /if \(body\.closetIntelligenceContext != null\)/);
  assert.match(index, /parseClosetIntelligenceContext\(body\.closetIntelligenceContext\)/);

  // ...and reaches the reasoning surfaces rather than being parsed and dropped.
  for (const consumer of [
    'eliseAdvicePipeline.ts',
    'eliseWardrobeGap.ts',
    'eliseWardrobeRetrieval.ts',
  ]) {
    assert.match(
      read(`supabase/functions/stylechat-generate/${consumer}`),
      /ClosetInventoryState/,
      `${consumer} must consume the parsed inventory state`,
    );
  }
});

test('the client key and the server key are the same key', () => {
  // The two deploy separately, so a rename on one side would be invisible until
  // production stopped reasoning about the wardrobe again — which is the exact
  // failure mode already in flight.
  const KEY = 'closetIntelligenceContext';
  assert.ok(read('services/style-chat/providers/edgeStyleChatProvider.ts').includes(KEY));
  assert.ok(read('supabase/functions/stylechat-generate/index.ts').includes(KEY));
});

test('the production promotion delta is recorded in the ledger', () => {
  const ledger = read('docs/release/BUILD29_BACKEND_PROMOTION_LEDGER.md');
  assert.match(ledger, /stylechat-generate/);
  assert.match(ledger, /closetIntelligenceContext/);
  assert.match(ledger, /v90/, 'the production version must be recorded');
  assert.match(ledger, /v91/, 'the staging version must be recorded');
  // The finding that makes it a promotion rather than a code change.
  assert.match(
    ledger,
    /silently dropped|silently drops/i,
    'the ledger must state that production drops the field rather than erroring',
  );
});

test('no alternative Closet intelligence transport was invented', () => {
  // The repair for a stale deployment is a promotion, not a second pathway.
  // A parallel transport would have to be maintained forever and would hide the
  // very drift the ledger is tracking.
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  assert.doesNotMatch(
    provider,
    /closetIntelligenceFallback|closetIntelligenceV2|legacyClosetIntelligence/i,
    'no fallback transport may be introduced for a deployment gap',
  );

  // One outbound placement, not a primary plus a compatibility copy under a
  // second key. A parallel path would have to be maintained forever and would
  // hide the very drift the ledger is tracking.
  const bodyPlacements = provider.match(/\{ closetIntelligenceContext:/g) || [];
  assert.equal(bodyPlacements.length, 1, 'the field must reach the body exactly one way');

  // And the client must not try to detect or work around an old deployment.
  assert.doesNotMatch(
    provider,
    /closetIntelligence[\s\S]{0,80}(?:version|legacy|supported|probe)/i,
    'the client must not branch on which server generation is deployed',
  );
});
