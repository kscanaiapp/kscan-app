#!/usr/bin/env node
/**
 * Identification-recheck accuracy-movement evaluator (Phase 7.1 §16, §17).
 *
 * Answers the ONLY question that licenses promotion:
 *
 *     does the confidence-gated recheck produce more correct fashion
 *     assertions than incorrect ones, and what did that cost?
 *
 * It compares two runs of the SAME cases:
 *
 *     CONTROL   — primary identification only  (recheck flag OFF)
 *     CANDIDATE — confidence-gated recheck     (recheck flag ON)
 *
 * and reports movement per taxonomy tier, because a build that fixes subtypes
 * while corrupting categories is not an improvement and a single blended
 * accuracy number would hide that.
 *
 * DELIBERATELY NOT AN ACCURACY SCORER FOR ANYTHING ELSE. Field-population
 * counts, null counts, latency alone and response-completion rate are NOT
 * success measures here — Phase 6 established that faster and more complete is
 * not more accurate. Completeness is reported only as context.
 *
 * OFFLINE. This computes metrics from recorded results; it makes no provider,
 * staging or production call of its own.
 *
 * Usage:
 *   node scripts/identification-recheck-accuracy.js <paired-results.json>
 *   node scripts/identification-recheck-accuracy.js <file> --json
 *
 * Input shape:
 *   {
 *     "cases": [
 *       {
 *         "caseId": "case-001",
 *         "truth":     { "category": "pants", "clothingType": "jeans", "subtype": "wide_leg_jeans" },
 *         "control":   { "category": "pants", "clothingType": "jeans", "subtype": null },
 *         "candidate": { "category": "pants", "clothingType": "jeans", "subtype": "wide_leg_jeans" },
 *         "controlCost":   { "latencyMs": 1800, "inputTokens": 900, "responseTokens": 400,
 *                            "thinkingTokens": 300, "providerCalls": 1, "finishReason": "STOP" },
 *         "candidateCost": { "latencyMs": 2500, "inputTokens": 1800, "responseTokens": 440,
 *                            "thinkingTokens": 420, "providerCalls": 2, "finishReason": "STOP" },
 *         "recheckTriggered": true
 *       }
 *     ]
 *   }
 *
 * Exit codes:
 *   0  evaluation completed (see the verdict; a NO-PROMOTE verdict is still a
 *      successful evaluation)
 *   2  usage / malformed input
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TIERS = ['category', 'clothingType', 'subtype'];

/** Label comparison is case- and separator-insensitive: `wide_leg_jeans` === `Wide Leg Jeans`. */
function canon(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(unknown|n\/a|none|null|undefined)$/i.test(trimmed)) return null;
  return trimmed.toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Three-state grading. `unknown` is a genuine third outcome, not a failure:
 * §3 makes abstention preferable to unsupported specificity, so an abstained
 * field must never be scored as though it were a wrong answer.
 */
function grade(observed, truth) {
  const o = canon(observed);
  if (o === null) return 'unknown';
  return o === truth ? 'correct' : 'incorrect';
}

const MOVEMENTS = [
  'incorrect->correct',
  'correct->incorrect',
  'unknown->correct',
  'unknown->incorrect',
  'correct->unknown',
  'incorrect->unknown',
  'unchanged correct',
  'unchanged incorrect',
  'unchanged unknown',
];

function movementKey(before, after) {
  if (before === after) return `unchanged ${before}`;
  return `${before}->${after}`;
}

function emptyTierReport() {
  const movements = {};
  for (const key of MOVEMENTS) movements[key] = 0;
  return {
    scorable: 0,
    unscorable: 0,
    movements,
    control: { correct: 0, incorrect: 0, unknown: 0 },
    candidate: { correct: 0, incorrect: 0, unknown: 0 },
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function sum(values) {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return finite.length ? finite.reduce((a, b) => a + b, 0) : null;
}

function mean(values) {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
}

function percentile(values, p) {
  const finite = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!finite.length) return null;
  const index = Math.min(finite.length - 1, Math.floor((p / 100) * finite.length));
  return finite[index];
}

function evaluate(cases) {
  const tiers = {};
  for (const tier of TIERS) tiers[tier] = emptyTierReport();

  const controlCost = { latencyMs: [], inputTokens: [], responseTokens: [], thinkingTokens: [], calls: [] };
  const candidateCost = { latencyMs: [], inputTokens: [], responseTokens: [], thinkingTokens: [], calls: [] };
  let controlMaxTokens = 0;
  let candidateMaxTokens = 0;
  let triggered = 0;

  for (const entry of cases) {
    for (const tier of TIERS) {
      const report = tiers[tier];
      const truth = canon(entry.truth ? entry.truth[tier] : null);

      // A case with no ground truth for this tier cannot score it. Counted and
      // reported rather than silently dropped: a shrinking denominator is how
      // an accuracy number quietly stops meaning what it claims.
      if (truth === null) {
        report.unscorable += 1;
        continue;
      }
      report.scorable += 1;

      const before = grade(entry.control ? entry.control[tier] : null, truth);
      const after = grade(entry.candidate ? entry.candidate[tier] : null, truth);
      report.control[before] += 1;
      report.candidate[after] += 1;
      report.movements[movementKey(before, after)] += 1;
    }

    if (entry.recheckTriggered) triggered += 1;

    for (const [source, bucket, maxKey] of [
      [entry.controlCost, controlCost, 'control'],
      [entry.candidateCost, candidateCost, 'candidate'],
    ]) {
      if (!source || typeof source !== 'object') continue;
      bucket.latencyMs.push(source.latencyMs);
      bucket.inputTokens.push(source.inputTokens);
      bucket.responseTokens.push(source.responseTokens);
      bucket.thinkingTokens.push(source.thinkingTokens);
      bucket.calls.push(source.providerCalls);
      if (String(source.finishReason || '').toUpperCase() === 'MAX_TOKENS') {
        if (maxKey === 'control') controlMaxTokens += 1;
        else candidateMaxTokens += 1;
      }
    }
  }

  // ── The promotion metric ───────────────────────────────────────────────────
  const perTier = {};
  let netTotal = 0;
  let correctionsTotal = 0;
  let reversalsTotal = 0;

  for (const tier of TIERS) {
    const r = tiers[tier];
    const corrections = r.movements['incorrect->correct'];
    const reversals = r.movements['correct->incorrect'];
    const net = corrections - reversals;
    netTotal += net;
    correctionsTotal += corrections;
    reversalsTotal += reversals;

    const controlAnswered = r.control.correct + r.control.incorrect;
    const candidateAnswered = r.candidate.correct + r.candidate.incorrect;

    perTier[tier] = {
      scorable: r.scorable,
      unscorable: r.unscorable,
      movements: r.movements,
      corrections,
      reversals,
      net,
      controlAccuracyAll: ratio(r.control.correct, r.scorable),
      candidateAccuracyAll: ratio(r.candidate.correct, r.scorable),
      // Accuracy among ANSWERED is the number that abstention can flatter, so
      // it is always reported beside the answer rate rather than alone.
      controlAccuracyAnswered: ratio(r.control.correct, controlAnswered),
      candidateAccuracyAnswered: ratio(r.candidate.correct, candidateAnswered),
      controlAnswerRate: ratio(controlAnswered, r.scorable),
      candidateAnswerRate: ratio(candidateAnswered, r.scorable),
      abstentions: r.movements['correct->unknown'] + r.movements['incorrect->unknown'],
      // An abstention that discarded a WRONG answer is a gain, not a loss.
      abstentionsFromIncorrect: r.movements['incorrect->unknown'],
      abstentionsFromCorrect: r.movements['correct->unknown'],
    };
  }

  const costSummary = (bucket) => ({
    latencyMsMean: mean(bucket.latencyMs),
    latencyMsP95: percentile(bucket.latencyMs, 95),
    inputTokensTotal: sum(bucket.inputTokens),
    responseTokensTotal: sum(bucket.responseTokens),
    thinkingTokensTotal: sum(bucket.thinkingTokens),
    providerCallsTotal: sum(bucket.calls),
  });

  return {
    caseCount: cases.length,
    recheckTriggeredCount: triggered,
    recheckTriggerRate: ratio(triggered, cases.length),
    perTier,
    totals: {
      corrections: correctionsTotal,
      reversals: reversalsTotal,
      net: netTotal,
    },
    cost: {
      control: costSummary(controlCost),
      candidate: costSummary(candidateCost),
      controlMaxTokensCount: controlMaxTokens,
      candidateMaxTokensCount: candidateMaxTokens,
    },
    // The promotion rule, stated as data rather than left to the reader.
    verdict: netTotal > 0
      ? 'NET_POSITIVE'
      : netTotal === 0
      ? 'NET_NEUTRAL'
      : 'NET_NEGATIVE',
    promotionRecommended: netTotal > 0,
  };
}

function render(result) {
  const lines = [];
  lines.push('='.repeat(78));
  lines.push('IDENTIFICATION RECHECK — ACCURACY MOVEMENT (PRIMARY ONLY vs GATED RECHECK)');
  lines.push('='.repeat(78));
  lines.push('');
  lines.push(`cases:                ${result.caseCount}`);
  lines.push(
    `recheck triggered:    ${result.recheckTriggeredCount} (${pct(result.recheckTriggerRate)} of scans)`,
  );
  lines.push('');

  for (const tier of TIERS) {
    const t = result.perTier[tier];
    lines.push('-'.repeat(78));
    lines.push(`TIER: ${tier}    scorable=${t.scorable}  unscorable(no ground truth)=${t.unscorable}`);
    lines.push('-'.repeat(78));
    for (const key of MOVEMENTS) {
      lines.push(`  ${key.padEnd(22)} ${String(t.movements[key]).padStart(5)}`);
    }
    lines.push('');
    lines.push(
      `  accuracy (all scorable)   control ${pct(t.controlAccuracyAll)}  →  candidate ${
        pct(t.candidateAccuracyAll)
      }`,
    );
    lines.push(
      `  accuracy (among answered) control ${pct(t.controlAccuracyAnswered)}  →  candidate ${
        pct(t.candidateAccuracyAnswered)
      }`,
    );
    lines.push(
      `  answer rate               control ${pct(t.controlAnswerRate)}  →  candidate ${
        pct(t.candidateAnswerRate)
      }`,
    );
    lines.push(
      `  abstentions               ${t.abstentions}  (from incorrect ${t.abstentionsFromIncorrect} = gain, from correct ${t.abstentionsFromCorrect} = loss)`,
    );
    lines.push('');
    lines.push(
      `  NET (incorrect→correct − correct→incorrect) = ${t.corrections} − ${t.reversals} = ${t.net}`,
    );
    lines.push('');
  }

  const c = result.cost;
  lines.push('-'.repeat(78));
  lines.push('COST / LATENCY');
  lines.push('-'.repeat(78));
  const row = (label, a, b) =>
    `  ${label.padEnd(26)} control ${String(a ?? 'n/a').padStart(10)}   candidate ${
      String(b ?? 'n/a').padStart(10)
    }`;
  lines.push(row('latency mean (ms)', c.control.latencyMsMean?.toFixed(0), c.candidate.latencyMsMean?.toFixed(0)));
  lines.push(row('latency p95 (ms)', c.control.latencyMsP95, c.candidate.latencyMsP95));
  lines.push(row('input tokens', c.control.inputTokensTotal, c.candidate.inputTokensTotal));
  lines.push(row('visible output tokens', c.control.responseTokensTotal, c.candidate.responseTokensTotal));
  lines.push(row('thinking tokens', c.control.thinkingTokensTotal, c.candidate.thinkingTokensTotal));
  lines.push(row('provider calls', c.control.providerCallsTotal, c.candidate.providerCallsTotal));
  lines.push(row('MAX_TOKENS finishes', c.controlMaxTokensCount, c.candidateMaxTokensCount));
  lines.push('');
  lines.push('='.repeat(78));
  lines.push(
    `TOTAL NET: ${result.totals.corrections} corrections − ${result.totals.reversals} reversals = ${result.totals.net}`,
  );
  lines.push(`VERDICT:   ${result.verdict}`);
  lines.push(
    `PROMOTION: ${
      result.promotionRecommended
        ? 'net-positive on accuracy — weigh against the measured cost above'
        : 'DO NOT PROMOTE — the recheck does not produce a net accuracy gain'
    }`,
  );
  lines.push('='.repeat(78));
  return lines.join('\n');
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const asJson = argv.includes('--json');
  if (args.length !== 1) {
    console.error('Usage: node scripts/identification-recheck-accuracy.js <paired-results.json> [--json]');
    return 2;
  }
  const file = path.resolve(process.cwd(), args[0]);
  if (!fs.existsSync(file)) {
    console.error(`[recheck-accuracy] not found: ${file}`);
    return 2;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[recheck-accuracy] unparseable JSON: ${err.message}`);
    return 2;
  }
  const cases = Array.isArray(payload) ? payload : payload.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error('[recheck-accuracy] input must carry a non-empty `cases` array');
    return 2;
  }

  const result = evaluate(cases);
  console.log(asJson ? JSON.stringify(result, null, 2) : render(result));
  return 0;
}

module.exports = { evaluate, grade, canon, movementKey, TIERS, MOVEMENTS };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
