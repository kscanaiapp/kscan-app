/**
 * Trusted scanner version resolution — Deno tests.
 *
 * Most of these are written from the attacker's and the misconfiguring
 * operator's side rather than the happy path: the resolver's job is to be
 * boring, to never throw, and to never let anything a client controls change
 * the answer.
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  createScannerVersionResolution,
  resolveScannerVersion,
  SCANNER_VERSION_DEFAULT,
  SCANNER_VERSION_ENV_KEY,
  scannerVersionTelemetry,
} from './scannerVersionResolver.ts';
import {
  CERTIFIED_CONTROL_VERSION,
  PHASE2A_CANDIDATE_VERSION,
} from './scannerCandidateArtifact.ts';

/** An env reader backed by a fixed map. Never touches the real environment. */
const envOf = (map: Record<string, string>) => (key: string): string | undefined => map[key];

Deno.test('the committed default is the certified control', () => {
  assertEquals(SCANNER_VERSION_DEFAULT, CERTIFIED_CONTROL_VERSION);
  assertEquals(SCANNER_VERSION_DEFAULT, 'certified-v140');
});

Deno.test('absent configuration resolves the certified control', () => {
  const resolution = resolveScannerVersion(envOf({}));
  assertEquals(resolution.resolvedVersion, CERTIFIED_CONTROL_VERSION);
  assertEquals(resolution.isControl, true);
  assertEquals(resolution.reason, 'no_trusted_configuration');
  // Absent configuration is the normal dormant state, not a failure.
  assertEquals(resolution.fellBackToControl, false);
});

Deno.test('explicit trusted configuration selects the candidate', () => {
  const resolution = resolveScannerVersion(
    envOf({ [SCANNER_VERSION_ENV_KEY]: PHASE2A_CANDIDATE_VERSION }),
  );
  assertEquals(resolution.resolvedVersion, PHASE2A_CANDIDATE_VERSION);
  assertEquals(resolution.isControl, false);
  assertEquals(resolution.reason, 'explicit_candidate');
  assertEquals(resolution.fellBackToControl, false);
});

Deno.test('explicitly naming the control is distinguishable from naming nothing', () => {
  const explicit = resolveScannerVersion(
    envOf({ [SCANNER_VERSION_ENV_KEY]: CERTIFIED_CONTROL_VERSION }),
  );
  assertEquals(explicit.resolvedVersion, CERTIFIED_CONTROL_VERSION);
  assertEquals(explicit.reason, 'explicit_control');
});

Deno.test('an unknown version fails closed to the control', () => {
  for (
    const unknown of [
      'phase2a',
      'phase2a-v1.0.1',
      'phase2b-v1.0.0',
      'certified-v141',
      'true',
      'enabled',
    ]
  ) {
    const resolution = resolveScannerVersion(envOf({ [SCANNER_VERSION_ENV_KEY]: unknown }));
    assertEquals(resolution.resolvedVersion, CERTIFIED_CONTROL_VERSION, unknown);
    assertEquals(resolution.reason, 'unknown_version');
    assertEquals(resolution.fellBackToControl, true);
  }
});

Deno.test('a near miss is still a miss: no case folding or alias repair', () => {
  for (const value of ['PHASE2A-V1.0.0', 'Phase2a-v1.0.0', 'phase2a_v1.0.0']) {
    const resolution = resolveScannerVersion(envOf({ [SCANNER_VERSION_ENV_KEY]: value }));
    assertEquals(resolution.resolvedVersion, CERTIFIED_CONTROL_VERSION, value);
    assertEquals(resolution.reason, 'unknown_version');
  }
});

Deno.test('surrounding whitespace is tolerated, because an env var picks it up by accident', () => {
  const resolution = resolveScannerVersion(
    envOf({ [SCANNER_VERSION_ENV_KEY]: `  ${PHASE2A_CANDIDATE_VERSION}  ` }),
  );
  assertEquals(resolution.resolvedVersion, PHASE2A_CANDIDATE_VERSION);
  assertEquals(resolution.reason, 'explicit_candidate');
});

Deno.test('an empty or whitespace-only value is the dormant default', () => {
  for (const value of ['', '   ', '\t']) {
    const resolution = resolveScannerVersion(envOf({ [SCANNER_VERSION_ENV_KEY]: value }));
    assertEquals(resolution.resolvedVersion, CERTIFIED_CONTROL_VERSION);
    assertEquals(resolution.reason, 'no_trusted_configuration');
  }
});

Deno.test('an environment reader that throws cannot fail the request', () => {
  const hostile = (): string | undefined => {
    throw new Error('env access denied');
  };
  // The reader genuinely throws, so this proves something.
  assertThrows(() => hostile());

  const resolution = resolveScannerVersion(hostile);
  assertEquals(resolution.resolvedVersion, CERTIFIED_CONTROL_VERSION);
  assertEquals(resolution.reason, 'configuration_unavailable');
  assertEquals(resolution.fellBackToControl, true);
});

Deno.test('a non-string configuration value fails closed', () => {
  const weird = (() => 42 as unknown) as (key: string) => string | undefined;
  const resolution = resolveScannerVersion(weird);
  assertEquals(resolution.resolvedVersion, CERTIFIED_CONTROL_VERSION);
  assertEquals(resolution.reason, 'malformed_value');
  assertEquals(resolution.observedValue, '<number>');
});

Deno.test('the resolver reads exactly one key, and only that key', () => {
  const seen: string[] = [];
  resolveScannerVersion((key) => {
    seen.push(key);
    return undefined;
  });
  assertEquals(seen, [SCANNER_VERSION_ENV_KEY]);
});

Deno.test('the resolved version is frozen for one request', () => {
  const env: Record<string, string> = { [SCANNER_VERSION_ENV_KEY]: PHASE2A_CANDIDATE_VERSION };
  const sealed = createScannerVersionResolution(envOf(env));
  assertEquals(sealed.version, PHASE2A_CANDIDATE_VERSION);

  // Configuration changes mid-request must not move this request.
  delete env[SCANNER_VERSION_ENV_KEY];
  assertEquals(sealed.resolve().resolvedVersion, PHASE2A_CANDIDATE_VERSION);
  assertEquals(sealed.resolve(), sealed.resolve());
  assertEquals(Object.isFrozen(sealed), true);
  assertEquals(Object.isFrozen(sealed.resolution), true);
});

Deno.test('two requests are independent', () => {
  const a = createScannerVersionResolution(
    envOf({ [SCANNER_VERSION_ENV_KEY]: PHASE2A_CANDIDATE_VERSION }),
  );
  const b = createScannerVersionResolution(envOf({}));
  const c = createScannerVersionResolution(
    envOf({ [SCANNER_VERSION_ENV_KEY]: PHASE2A_CANDIDATE_VERSION }),
  );
  assertEquals(a.version, PHASE2A_CANDIDATE_VERSION);
  assertEquals(b.version, CERTIFIED_CONTROL_VERSION, 'one request must not leak into the next');
  assertEquals(c.version, PHASE2A_CANDIDATE_VERSION);
});

Deno.test('an operator-supplied value cannot reach logs unbounded', () => {
  const long = 'x'.repeat(500);
  const resolution = resolveScannerVersion(envOf({ [SCANNER_VERSION_ENV_KEY]: long }));
  assertEquals(resolution.resolvedVersion, CERTIFIED_CONTROL_VERSION);
  assertEquals((resolution.observedValue ?? '').length <= 66, true);
});

Deno.test('telemetry carries ids, an enum reason and booleans only', () => {
  const resolution = resolveScannerVersion(
    envOf({ [SCANNER_VERSION_ENV_KEY]: PHASE2A_CANDIDATE_VERSION }),
  );
  const telemetry = scannerVersionTelemetry(resolution);
  assertEquals(Object.keys(telemetry).sort(), [
    'scannerVersion',
    'scannerVersionFellBack',
    'scannerVersionIsControl',
    'scannerVersionReason',
  ]);
  assertEquals(telemetry.scannerVersion, PHASE2A_CANDIDATE_VERSION);

  const serialized = JSON.stringify(telemetry);
  assertEquals(/instruction|prompt|apikey|token|base64|BACKEND_/i.test(serialized), false);
});
