#!/usr/bin/env node
// Reproduce the benchmark image set from its manifest.
//
//   node tools/scanner-benchmark/scripts/fetch-assets.mjs <asset-root> [--manifest <path>]
//
// * Downloads each SOURCE case's standard-size Commons thumbnail to
//   <asset-root>/<caseId>.jpg and verifies its SHA-256 against the manifest.
// * Never writes inside the repository: refuses an asset root under the repo.
// * Polite by construction: one request every 8 s, stops after sustained 429s.
// * Derived "difficult condition" cases are produced afterwards by
//   derive-variants.py from the verified sources.
//
// Image bytes are third-party licensed content (CC0 / PD / CC BY / CC BY-SA);
// attribution for every file is in the manifest. They are never committed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Wikimedia's bot policy asks automated clients to name a contact; the owner approved the
// project site. Override with KSCAN_BENCHMARK_USER_AGENT.
const UA = process.env.KSCAN_BENCHMARK_USER_AGENT || 'KScanScannerBenchmark/1.0 (https://kscan.app; scanner accuracy evaluation)';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const root = args[0];
const manifestPath = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : path.join(here, '..', 'manifest', 'cases.v1.json');
if (!root) { console.error('usage: fetch-assets.mjs <asset-root> [--manifest <path>]'); process.exit(64); }
const absRoot = path.resolve(root);
if (absRoot.toLowerCase().startsWith(repoRoot.toLowerCase() + path.sep) || absRoot.toLowerCase() === repoRoot.toLowerCase()) {
  console.error('refusing: asset root must be outside the repository'); process.exit(65);
}
fs.mkdirSync(absRoot, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let ok = 0, fetched = 0, mismatched = 0, failed = 0, consecutive429 = 0;
for (const c of manifest.cases.filter((x) => x.source?.kind === 'commons')) {
  const file = path.join(absRoot, `${c.caseId}.jpg`);
  if (fs.existsSync(file) && sha(fs.readFileSync(file)) === c.source.sha256) { ok++; continue; }
  await sleep(8000);
  try {
    const r = await fetch(c.source.fetchUrl, { headers: { 'User-Agent': UA } });
    if (r.status === 429) {
      if (++consecutive429 >= 5) { console.error('stopping: sustained HTTP 429 from the image host; retry later'); break; }
      await sleep(300000); continue;
    }
    consecutive429 = 0;
    if (!r.ok) { console.error(`fail ${c.caseId} HTTP ${r.status}`); failed++; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (sha(buf) !== c.source.sha256) { console.error(`sha256 mismatch ${c.caseId} (upstream file changed?)`); mismatched++; continue; }
    fs.writeFileSync(file, buf); fetched++; ok++;
  } catch (e) { console.error(`fail ${c.caseId} ${String(e).slice(0, 80)}`); failed++; }
}
console.log(JSON.stringify({ assetRoot: absRoot, verified: ok, fetched, mismatched, failed }));
process.exit(mismatched || failed ? 1 : 0);
