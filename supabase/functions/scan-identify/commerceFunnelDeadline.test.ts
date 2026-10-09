/**
 * Build 35 Scanner live certification — defect B35-SCAN-022.
 *
 * The v127 fast commerce path gave its whole fan-out 1.9 s. The primary provider
 * (Serper) routinely answers in 1.1-1.7 s but has a tail past 1.9 s, and a provider
 * call is aborted AT the deadline (`timeoutMs` = remaining budget) so its late answer
 * is discarded, not cached. Measured on Staging: 8 of 27 fast-path requests over 45
 * days ended in `provider_timeout` (30%), every one clustered at the wall (p50
 * 2006 ms); in the 2026-10-09 live run 4 of 15 garments came back with no offers on
 * the first attempt. A retry is a fresh draw from the same distribution.
 *
 * 3 s is the ceiling Production already shipped for the pre-funnel inline commerce
 * path (IMAGE_MODE_COMMERCE_TIMEOUT_MS). The fast path still returns the moment 3
 * rankable offers exist, so the typical request is unchanged (live successes:
 * 1.1-1.7 s); only the cut-off tail is recovered. Provider calls are already fired in
 * parallel, so no extra provider request is made.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { collectBounded } from './commerceFastPath.ts';
import {
  ENRICHMENT_DEADLINE_MS,
  FAST_COMMERCE_DEADLINE_MS,
  FAST_COMMERCE_SUFFICIENT_RESULTS,
} from './commerceFunnelConfig.ts';

/** The value that cut off ~30% of live fast-path requests. */
const LEGACY_WALL_MS = 1_900;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test('the fast-path deadline is past the legacy 1.9 s wall and inside the shipped 3 s ceiling', () => {
  assert(FAST_COMMERCE_DEADLINE_MS > LEGACY_WALL_MS, 'must clear the wall that cut off live requests');
  assert(FAST_COMMERCE_DEADLINE_MS >= 2_400, 'the B34 audit floor for the measured Serper tail');
  assert(FAST_COMMERCE_DEADLINE_MS <= 3_500, 'a first-paint budget, not an open-ended wait');
  assert(
    FAST_COMMERCE_DEADLINE_MS < ENRICHMENT_DEADLINE_MS,
    'discovery must stay tighter than the deferred enrichment hop',
  );
});

Deno.test('a provider answering after the old 1.9 s wall is now accepted', async () => {
  const answerAtMs = LEGACY_WALL_MS + 500;
  assert(answerAtMs < FAST_COMMERCE_DEADLINE_MS, 'the scenario is inside the new budget');
  const outcome = await collectBounded<{ ok: boolean }>(
    [{
      key: 'shopping',
      promise: sleep(answerAtMs).then(() => ({ ok: true })),
      onTimeout: { ok: false },
    }],
    { deadlineMs: FAST_COMMERCE_DEADLINE_MS },
  );
  assertEquals(outcome.values.get('shopping'), { ok: true }, 'the late-but-in-budget answer is kept');
  assertEquals(outcome.timedOutKeys, []);
});

Deno.test('a fast answer is still returned immediately, never held for the longer deadline', async () => {
  const usable = FAST_COMMERCE_SUFFICIENT_RESULTS;
  const started = Date.now();
  const outcome = await collectBounded<{ n: number }>(
    [
      { key: 'shopping', promise: sleep(60).then(() => ({ n: usable })), onTimeout: { n: 0 } },
      { key: 'poshmark', promise: sleep(30_000).then(() => ({ n: 0 })), onTimeout: { n: 0 } },
    ],
    {
      deadlineMs: FAST_COMMERCE_DEADLINE_MS,
      isSufficient: (settled) => settled.reduce((sum, v) => sum + v.n, 0) >= usable,
    },
  );
  const elapsed = Date.now() - started;
  assert(outcome.earlyExit, 'sufficiency, not the deadline, closed the gate');
  assert(elapsed < 500, `the typical request must not pay the longer deadline (took ${elapsed} ms)`);
  assertEquals(outcome.timedOutKeys, ['poshmark']);
});
