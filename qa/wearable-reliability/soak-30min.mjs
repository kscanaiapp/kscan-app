import { uuid, sleep } from './lib.mjs';
import { makeUserPool, pairOnce } from './pair.mjs';
import { scanCycle, doAction, glassesPoll, sendResultShow } from './ops.mjs';

const DURATION_MS = 30 * 60_000;
const WORKER_COUNT = 6;

// Sustained soak: a small number of already-paired, long-lived sessions (not
// fresh pairings per cycle — that would trip the pair.approve throttle) each
// loop scan -> save -> open -> reconnect-check continuously for 30 minutes.
// Samples latency and error rate every minute to catch degradation over time,
// not just a point-in-time check.

const samples = [];
let totalOk = 0;
let totalErr = 0;
let totalRepairs = 0;
const errorsByType = new Map();

function recordError(err) {
  const key = String(err?.message ?? err).slice(0, 80);
  errorsByType.set(key, (errorsByType.get(key) ?? 0) + 1);
}

// Wearable sessions have a real, correct 15-minute TTL (SESSION_TTL_MS in
// wearable-bridge/index.ts). A genuinely sustained 30-minute soak must behave
// like a real long-lived wearable client would — re-pair when a session goes
// stale — rather than either (a) staying on one session and reporting the
// resulting expected 403s as "soak failures", or (b) hiding TTL expiry
// entirely. This is tracked as `repairs`, separate from real errors.
async function workerLoop(session, pool, workerIndex, deadline) {
  let cycles = 0;
  let current = session;
  while (Date.now() < deadline) {
    const cycleStart = Date.now();
    try {
      const resultId = uuid();
      await sendResultShow(current, current.jwt, resultId);
      const save = await doAction(current, current.jwt, resultId, 'save');
      if (save.res.status === 403) throw Object.assign(new Error('session likely expired (403)'), { expired: true });
      if (save.res.status !== 200) throw new Error(`save http ${save.res.status}`);
      const open = await doAction(current, current.jwt, resultId, 'open_on_phone');
      if (open.res.status === 403) throw Object.assign(new Error('session likely expired (403)'), { expired: true });
      if (open.res.status !== 200) throw new Error(`open http ${open.res.status}`);
      if (cycles % 5 === 0) {
        const poll = await glassesPoll(current, 0);
        if (poll.status !== 200) throw new Error(`reconnect poll http ${poll.status}`);
      }
      totalOk++;
    } catch (err) {
      if (err?.expired) {
        totalRepairs++;
        try {
          current = await pairOnce(pool.next().jwt);
        } catch (repairErr) {
          totalErr++;
          recordError(repairErr);
        }
      } else {
        totalErr++;
        recordError(err);
      }
    }
    cycles++;
    const elapsed = Date.now() - cycleStart;
    if (elapsed < 800) await sleep(800 - elapsed); // ~0.75 cycles/sec/worker, sustained not bursty
  }
  return cycles;
}

async function main() {
  console.log(`=== 30-minute soak starting at ${new Date().toISOString()} ===`);
  console.log(`workers=${WORKER_COUNT} durationMin=30`);

  const pool = await makeUserPool(WORKER_COUNT, 'soak');
  const sessions = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    sessions.push(await pairOnce(pool.next().jwt));
  }
  console.log(`${sessions.length} long-lived sessions paired, starting sustained load...`);

  const start = Date.now();
  const deadline = start + DURATION_MS;

  const samplerInterval = setInterval(() => {
    const elapsedMin = Math.round((Date.now() - start) / 60000);
    const total = totalOk + totalErr;
    const errRate = total ? (totalErr / total * 100).toFixed(2) : '0.00';
    const sample = { elapsedMin, totalOk, totalErr, errRatePct: errRate };
    samples.push(sample);
    console.log(`[t+${elapsedMin}m] ok=${totalOk} err=${totalErr} errRate=${errRate}%`);
  }, 60_000);

  const cycleCounts = await Promise.all(sessions.map((s, i) => workerLoop(s, pool, i, deadline)));
  clearInterval(samplerInterval);

  const total = totalOk + totalErr;
  const errRate = total ? (totalErr / total * 100) : 0;
  console.log('\n=== SOAK RESULT ===');
  console.log(`duration: 30 minutes, workers: ${WORKER_COUNT}`);
  console.log(`session re-pairs (expected ~1-2 per worker from the real 15-minute TTL): ${totalRepairs}`);
  console.log(`total cycles: ${total} (ok=${totalOk} err=${totalErr}, errRate=${errRate.toFixed(3)}%)`);
  console.log(`per-worker cycle counts: ${cycleCounts.join(', ')}`);
  console.log('per-minute samples:', JSON.stringify(samples));
  if (errorsByType.size) {
    console.log('error breakdown:');
    for (const [msg, count] of errorsByType) console.log(`  ${count}x  ${msg}`);
  }

  // Degradation check: compare first-10-minutes error rate to last-10-minutes.
  const first10 = samples.filter((s) => s.elapsedMin <= 10);
  const last10 = samples.filter((s) => s.elapsedMin >= 20);
  const firstRate = first10.length ? Number(first10[first10.length - 1].errRatePct) : 0;
  const lastRate = last10.length ? Number(last10[last10.length - 1].errRatePct) : 0;
  console.log(`\ndegradation check: errRate at t~10m=${firstRate}% vs t~30m=${lastRate}%`);

  const pass = errRate < 1.0 && (lastRate - firstRate) < 2.0;
  console.log(pass ? '\nPASS: soak completed with low, stable error rate' : '\nFAIL: elevated or growing error rate over the soak window');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('SOAK CRASHED', e); process.exit(2); });
