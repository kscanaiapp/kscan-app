/**
 * Sanitized scanner-version observability — Deno tests.
 *
 * The interesting cases here are the hostile ones. The realistic way sensitive
 * data reaches a log is not a decision to log it, but a caller passing a whole
 * request, response or provider object into a telemetry helper that spreads
 * whatever it is given. These tests prove this helper cannot do that.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  formatScannerOperationalMetadata,
  SCANNER_OBSERVABILITY_KEYS,
  scannerOperationalMetadata,
} from './scannerVersionObservability.ts';
import {
  CERTIFIED_CONTROL_VERSION,
  PHASE2A_CANDIDATE_VERSION,
} from './scannerCandidateArtifact.ts';

const baseInput = {
  version: CERTIFIED_CONTROL_VERSION,
  versionReason: 'no_trusted_configuration' as const,
  versionFellBack: false,
  outcome: 'success' as const,
};

Deno.test('the record always carries version attribution and an outcome', () => {
  const record = scannerOperationalMetadata(baseInput);
  assertEquals(record.scannerVersion, CERTIFIED_CONTROL_VERSION);
  assertEquals(record.scannerVersionReason, 'no_trusted_configuration');
  assertEquals(record.scannerVersionFellBack, false);
  assertEquals(record.outcome, 'success');
  assertEquals(Object.isFrozen(record), true);
});

Deno.test('the candidate is attributable, which is the whole point', () => {
  const record = scannerOperationalMetadata({
    ...baseInput,
    version: PHASE2A_CANDIDATE_VERSION,
    versionReason: 'explicit_candidate',
  });
  assertEquals(record.scannerVersion, PHASE2A_CANDIDATE_VERSION);
  assertEquals(record.scannerVersionReason, 'explicit_candidate');
});

Deno.test('absent measurements are omitted, never emitted as null or zero', () => {
  const record = scannerOperationalMetadata(baseInput);
  // A log line must never claim to have measured something it did not.
  assertEquals('latencyMs' in record, false);
  assertEquals('attemptCount' in record, false);
  assertEquals('totalTokenCount' in record, false);
  assertEquals('providerFailureKind' in record, false);
  assertEquals(formatScannerOperationalMetadata(record).includes('latencyMs'), false);
});

Deno.test('present measurements are carried through', () => {
  const record = scannerOperationalMetadata({
    ...baseInput,
    outcome: 'provider_http_error',
    providerFailureKind: 'http_429_quota',
    attemptCount: 2,
    fallbackUsed: true,
    latencyMs: 1234,
    promptTokenCount: 100,
    candidatesTokenCount: 50,
    totalTokenCount: 150,
  });
  assertEquals(record.providerFailureKind, 'http_429_quota');
  assertEquals(record.attemptCount, 2);
  assertEquals(record.fallbackUsed, true);
  assertEquals(record.latencyMs, 1234);
  assertEquals(record.totalTokenCount, 150);
});

Deno.test('non-finite and non-numeric measurements are dropped', () => {
  const record = scannerOperationalMetadata({
    ...baseInput,
    attemptCount: Number.NaN,
    latencyMs: Number.POSITIVE_INFINITY,
    totalTokenCount: ('150' as unknown) as number,
  });
  assertEquals('attemptCount' in record, false);
  assertEquals('latencyMs' in record, false);
  assertEquals('totalTokenCount' in record, false);
});

Deno.test('an unbounded failure kind cannot become an unbounded log line', () => {
  const record = scannerOperationalMetadata({
    ...baseInput,
    providerFailureKind: 'x'.repeat(500),
  });
  assertEquals((record.providerFailureKind as string).length, 48);
});

Deno.test('a whole request, response or provider object cannot reach a log line', () => {
  // The exact failure mode this helper exists to prevent: a caller hands it
  // objects, expecting them to be summarized.
  const hostile = {
    ...baseInput,
    providerFailureKind: ({ body: 'secret', apikey: 'AIzaSyHOSTILE' } as unknown) as string,
    attemptCount: ({ imageBase64: 'SENSITIVE' } as unknown) as number,
    latencyMs: ([1, 2, 3] as unknown) as number,
  };
  const record = scannerOperationalMetadata(hostile);
  const rendered = formatScannerOperationalMetadata(record);

  for (const needle of ['secret', 'AIzaSy', 'SENSITIVE', 'body', 'apikey', 'imageBase64']) {
    assertEquals(rendered.includes(needle), false, `rendered output must not contain ${needle}`);
    assertEquals(JSON.stringify(record).includes(needle), false, `record must not contain ${needle}`);
  }
});

Deno.test('a value smuggled onto the record cannot be rendered', () => {
  const record = scannerOperationalMetadata(baseInput);
  // Simulates a later edit that attaches an extra field somewhere downstream.
  const smuggled = { ...record, rawPrompt: 'You are K Scan AI', imageBytes: 'BASE64' };
  const rendered = formatScannerOperationalMetadata(smuggled);

  assertEquals(rendered.includes('rawPrompt'), false);
  assertEquals(rendered.includes('You are K Scan AI'), false);
  assertEquals(rendered.includes('BASE64'), false);
});

Deno.test('only declared keys are ever rendered', () => {
  const record = scannerOperationalMetadata({
    ...baseInput,
    outcome: 'provider_timeout',
    providerFailureKind: 'timeout',
    attemptCount: 2,
    fallbackUsed: true,
    latencyMs: 900,
  });
  const rendered = formatScannerOperationalMetadata(record);
  for (const pair of rendered.split(' ')) {
    const key = pair.split('=')[0];
    assertEquals(
      (SCANNER_OBSERVABILITY_KEYS as readonly string[]).includes(key),
      true,
      `${key} is not a declared observability key`,
    );
  }
  // And it renders in the declared order, so log lines are stable and diffable.
  assertEquals(
    rendered,
    'scannerVersion=certified-v140 scannerVersionReason=no_trusted_configuration ' +
      'scannerVersionFellBack=false outcome=provider_timeout providerFailureKind=timeout ' +
      'attemptCount=2 fallbackUsed=true latencyMs=900',
  );
});

Deno.test('no alert threshold is defined in this module', async () => {
  // Thresholds require measured certified and candidate results, which do not
  // exist yet. Encoding a number now would later be mistaken for a finding.
  const source = await Deno.readTextFile(
    new URL('./scannerVersionObservability.ts', import.meta.url),
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const pattern of [/threshold/i, /alert/i, /\bslo\b/i, /budget/i]) {
    assertEquals(pattern.test(code), false, `no ${pattern} may be encoded yet`);
  }
});
