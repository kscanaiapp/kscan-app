/**
 * K-SCAN Deployment Convergence Validator
 *
 * Sends N rapid requests to the deployed backend and verifies that ALL
 * responses return identical deployment version headers.
 *
 * Mixed versions indicate rolling deployment lag, stale container instances,
 * or CDN edge-cache persistence. Do NOT run live fixture validation until
 * convergence is confirmed.
 *
 * Usage:
 *   BASE_URL=https://your-private-qa-host.example node scripts/qa-convergence.js
 */

const BASE_URL = process.env.BASE_URL || process.env.KSCAN_API_URL?.replace('/api/analyze', '');
if (!BASE_URL) {
  throw new Error('Set BASE_URL or KSCAN_API_URL explicitly; no legacy hosted default exists.');
}
const HEALTH_URL = BASE_URL + '/api/health';

const TOTAL_REQUESTS     = parseInt(process.env.CONVERGENCE_N || '5', 10);
const CONCURRENCY        = parseInt(process.env.CONVERGENCE_C || '3', 10);
// Token-gated validation: in production, diagnostic headers require this secret.
const VALIDATION_SECRET  = process.env.VALIDATION_SECRET_KEY || '';

async function probe(index) {
  const start   = Date.now();
  const headers = { 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' };
  if (VALIDATION_SECRET) headers['X-KScan-Validation-Auth'] = VALIDATION_SECRET;
  const response = await fetch(HEALTH_URL, { headers });
  const latencyMs = Date.now() - start;
  const body = await response.json().catch(() => ({}));

  return {
    index,
    status:              response.status,
    latencyMs,
    parserVersion:        response.headers.get('x-kscan-parser-version')        || 'not-present',
    normalizationVersion: response.headers.get('x-kscan-normalization-version') || 'not-present',
    promptVersion:        response.headers.get('x-kscan-prompt-version')        || 'not-present',
    deployedCommit:       response.headers.get('x-kscan-deployed-commit')       || 'not-present',
    ok:                  body?.ok === true,
    server:              response.headers.get('server') || '',
    cfRay:               response.headers.get('cf-ray') || '',
    renderOrigin:        response.headers.get('x-render-origin-server') || '',
  };
}

async function main() {
  console.log(`[K-SCAN CONVERGENCE] Target: ${HEALTH_URL}`);
  console.log(`[K-SCAN CONVERGENCE] Sending ${TOTAL_REQUESTS} requests (concurrency ${CONCURRENCY})...\n`);

  const results = [];
  for (let i = 0; i < TOTAL_REQUESTS; i += CONCURRENCY) {
    const batch = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, TOTAL_REQUESTS); j++) {
      batch.push(probe(j + 1));
    }
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
  }

  console.table(results.map(r => ({
    '#':             r.index,
    status:          r.status,
    latencyMs:       r.latencyMs,
    parserVersion:   r.parserVersion,
    normVersion:     r.normalizationVersion,
    deployedCommit:  r.deployedCommit,
  })));

  // ── Version convergence check ─────────────────────────────────────────────
  const parserVersions       = [...new Set(results.map(r => r.parserVersion))];
  const normalizationVersions = [...new Set(results.map(r => r.normalizationVersion))];
  const promptVersions        = [...new Set(results.map(r => r.promptVersion))];
  const deployedCommits       = [...new Set(results.map(r => r.deployedCommit))];

  const headersPresent = results.some(r => r.parserVersion !== 'not-present');
  if (!headersPresent) {
    if (!VALIDATION_SECRET) {
      console.warn('\n[K-SCAN CONVERGENCE] ⚠  No VALIDATION_SECRET_KEY set in environment.');
      console.warn('  In production, X-KScan-* headers require a valid auth token.');
      console.warn('  Set VALIDATION_SECRET_KEY=<secret> (must match server VALIDATION_SECRET_KEY)');
      console.warn('  and re-run: VALIDATION_SECRET_KEY=<secret> npm run qa:convergence\n');
    } else {
      console.warn('\n[K-SCAN CONVERGENCE] ⚠  X-KScan-* headers not present even with auth token.');
      console.warn('  Backend may be running a pre-v3.0 build or VALIDATION_SECRET_KEY mismatch.');
      console.warn('  DEPLOYMENT IS STALE — redeployment required before live fixture validation.');
    }
    process.exit(1);
  }

  let converged = true;
  if (parserVersions.length > 1) {
    console.error(`\n[K-SCAN CONVERGENCE] ✗ MIXED parser versions: ${parserVersions.join(', ')}`);
    console.error('  Stale container or rolling deployment still in progress. Wait and retry.');
    converged = false;
  }
  if (normalizationVersions.length > 1) {
    console.error(`[K-SCAN CONVERGENCE] ✗ MIXED normalization versions: ${normalizationVersions.join(', ')}`);
    converged = false;
  }
  if (!converged) {
    console.error('\n  Platform-specific cache invalidation steps:');
    console.error('  Render: check "Deployments" tab — confirm only one active revision.');
    console.error('  Cloudflare CDN: /api/analyze is DYNAMIC (CF-Cache-Status: DYNAMIC) — not cached.');
    console.error('  Health endpoint: may be cached by edge. Use Cache-Control: no-cache in probes.');
    process.exitCode = 1;
    return;
  }

  // ── Latency summary ───────────────────────────────────────────────────────
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const avg = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1] || latencies[latencies.length - 1];

  console.log(`\n[K-SCAN CONVERGENCE] ✓ All ${TOTAL_REQUESTS} instances running version:`);
  console.log(`  parser=${parserVersions[0]}  normalization=${normalizationVersions[0]}  prompt=${promptVersions[0]}`);
  console.log(`  deployed_commit=${deployedCommits[0]}`);
  console.log(`[K-SCAN CONVERGENCE] Health latency: avg=${avg}ms  p95=${p95}ms`);
  console.log('[K-SCAN CONVERGENCE] Deployment convergence: PASS — safe to run live fixture validation.\n');
}

main().catch(err => {
  console.error('[K-SCAN CONVERGENCE] Error:', err?.message || err);
  process.exit(1);
});
