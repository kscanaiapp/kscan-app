/**
 * CI-06 report runner (operator tool, not a test, not deployed).
 *
 *   deno run --allow-read --allow-env --allow-run=deno,git --allow-write=<out dir> \
 *     supabase/functions/_shared/corporateIntelligence/measurement/runGateReport.ts <out.md> <out.json> [telemetry.log]
 *
 * Runs the governed suites for real (deno test) and the offline measurements,
 * then writes the G1–G12 report. An optional exported log file is aggregated
 * with the metadata-only CI-v2 telemetry schema. No network, no model calls.
 */
import { buildGateReport, estimateG9, type GovernedRun, measureG1, measureG3, measureG6, measureG7, measureG8, measureG12, renderGateReportMarkdown } from './gateReport.ts';
import { aggregateTelemetry, parseTelemetryLines } from './telemetry.ts';

const here = new URL('.', import.meta.url);
const functionsRoot = new URL('../../../', import.meta.url);

const GOVERNED = [
  '_shared/corporateIntelligence/acceptanceFixtures.test.ts',
  '_shared/corporateIntelligence/contractHardening.test.ts',
  '_shared/corporateIntelligence/outputValidation.test.ts',
  '_shared/corporateIntelligence/boundaries.test.ts',
  'stylechat-generate/corporateIntelligenceV2.handler.test.ts',
];

async function runGoverned(rel: string): Promise<GovernedRun> {
  const out = await new Deno.Command('deno', {
    args: ['test', '--allow-read', '--allow-env', rel],
    cwd: functionsRoot,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  // deno-lint-ignore no-control-regex
  const text = new TextDecoder().decode(out.stdout).replace(/\x1b\[[0-9;]*m/g, '');
  const m = text.match(/(?:ok|FAILED) \| (\d+) passed(?: \(\d+ steps\))? \| (\d+) failed/);
  return { file: rel, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : 1 };
}

async function commit(): Promise<string> {
  try {
    const out = await new Deno.Command('git', { args: ['rev-parse', '--short=8', 'HEAD'], cwd: functionsRoot, stdout: 'piped' }).output();
    return new TextDecoder().decode(out.stdout).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

if (import.meta.main) {
  const [mdPath, jsonPath, telemetryPath] = Deno.args;
  if (!mdPath || !jsonPath) throw new Error('usage: runGateReport.ts <out.md> <out.json> [telemetry.log]');
  const index = await Deno.readTextFile(new URL('stylechat-generate/index.ts', functionsRoot));
  const sp = index.match(/const SYSTEM_PROMPT = `([\s\S]*?)`\n/);
  const governed: GovernedRun[] = [];
  for (const g of GOVERNED) governed.push(await runGoverned(g));
  const evidence = {
    g1: measureG1(), g3: measureG3(), g6: measureG6(index), g7: measureG7(), g8: measureG8(),
    g9: estimateG9(sp ? sp[1].length : 0), g12: measureG12(), governed,
  };
  const results = buildGateReport(evidence);
  const meta = { commit: await commit(), generatedAt: new Date().toISOString().slice(0, 10) };
  const telemetry = telemetryPath
    ? aggregateTelemetry(parseTelemetryLines((await Deno.readTextFile(telemetryPath)).split(/\r?\n/)), new Date())
    : null;
  await Deno.writeTextFile(mdPath, renderGateReportMarkdown(results, meta));
  await Deno.writeTextFile(jsonPath, JSON.stringify({ meta, results, evidence, telemetry }, null, 2) + '\n');
  console.log(results.map((r) => `${r.id} ${r.status}`).join('\n'));
  void here;
}
