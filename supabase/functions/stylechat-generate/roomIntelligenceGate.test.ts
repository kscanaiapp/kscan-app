/**
 * E4.1 has its own gate, independent of legacy E-1 normalization.
 *
 * WHY THIS EXISTS: Room Intelligence was originally built inside the
 * `contextNormalizationV1` branch, purely because that is where the resolved
 * evidence envelope happened to be constructed. That made
 * ELISE_CONTEXT_NORMALIZATION_V1_ENABLED the de-facto E4.1 release switch —
 * a flag that predates E4.1, governs an older prompt pipeline, and was never
 * designed as its gate. Enabling E4.1 would have meant enabling that pipeline
 * too, and rolling E4.1 back would have meant disabling it.
 *
 * The seam is now: shared envelope construction, two independently gated
 * behaviours on top of it. These tests pin that independence in both
 * directions, because the failure mode is silent — a coupled gate still
 * "works", it just takes the wrong thing down with it.
 */

import assert from 'node:assert/strict';

import { readEliseBackendConfig } from './eliseConfig.ts';

const SOURCE = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

function configWith(env: Record<string, string>) {
  return readEliseBackendConfig({ get: (key: string) => env[key] });
}

// ── Flag resolution ─────────────────────────────────────────────────────────

Deno.test('E4.1 defaults OFF', () => {
  assert.equal(configWith({}).flags.roomIntelligenceV1, false);
});

Deno.test('E4.1 turns on from its OWN variable', () => {
  const config = configWith({ ELISE_ROOM_INTELLIGENCE_V1_ENABLED: 'true' });
  assert.equal(config.flags.roomIntelligenceV1, true);
});

Deno.test('enabling legacy normalization does not enable E4.1', () => {
  // The exact coupling being removed.
  const config = configWith({ ELISE_CONTEXT_NORMALIZATION_V1_ENABLED: 'true' });
  assert.equal(config.flags.contextNormalizationV1, true);
  assert.equal(config.flags.roomIntelligenceV1, false);
});

Deno.test('enabling E4.1 does not enable legacy normalization', () => {
  // The other direction matters just as much: switching on Room Intelligence
  // must not silently re-activate an older prompt pipeline.
  const config = configWith({ ELISE_ROOM_INTELLIGENCE_V1_ENABLED: 'true' });
  assert.equal(config.flags.roomIntelligenceV1, true);
  assert.equal(config.flags.contextNormalizationV1, false);
});

Deno.test('the two gates are independently settable in all four combinations', () => {
  const cases: Array<[string | undefined, string | undefined, boolean, boolean]> = [
    [undefined, undefined, false, false],
    ['true', undefined, true, false],
    [undefined, 'true', false, true],
    ['true', 'true', true, true],
  ];
  for (const [norm, room, expectNorm, expectRoom] of cases) {
    const env: Record<string, string> = {};
    if (norm) env.ELISE_CONTEXT_NORMALIZATION_V1_ENABLED = norm;
    if (room) env.ELISE_ROOM_INTELLIGENCE_V1_ENABLED = room;
    const flags = configWith(env).flags;
    assert.equal(flags.contextNormalizationV1, expectNorm, `norm for ${JSON.stringify(env)}`);
    assert.equal(flags.roomIntelligenceV1, expectRoom, `room for ${JSON.stringify(env)}`);
  }
});

// ── The decoupled seam ──────────────────────────────────────────────────────

Deno.test('the envelope is built when EITHER consumer needs it', () => {
  // Envelope construction is resolution and authorization only: it emits no
  // prompt text and changes no response by itself, so it is safe to share.
  assert.match(
    SOURCE,
    /\(config\.flags\.contextNormalizationV1 \|\| config\.flags\.roomIntelligenceV1\) &&\s*\n?\s*body\.activeContext != null/,
    'evidence construction must not remain gated on the legacy flag alone',
  );
});

Deno.test('the legacy prompt block stays behind the legacy flag', () => {
  // If the envelope was built purely for E4.1, the old E-1 block must not
  // appear -- otherwise enabling E4.1 would quietly ship the older pipeline.
  assert.match(
    SOURCE,
    /if \(config\.flags\.contextNormalizationV1\) \{\s*\n\s*visualContextPromptBlock = typedVisualContext\.promptBlock;/,
    'the legacy visual-context block must be gated by contextNormalizationV1',
  );
});

Deno.test('the room manifest stays behind the E4.1 flag', () => {
  assert.match(
    SOURCE,
    /if \(config\.flags\.roomIntelligenceV1\) \{\s*\n\s*const roomManifest = buildRoomManifest\(/,
    'the room manifest must be gated by roomIntelligenceV1',
  );
});

Deno.test('a context failure clears the E4.1 block too, not just the legacy one', () => {
  // Optional enrichment fails open. Clearing only visualContextPromptBlock
  // would leave a stale room manifest in the prompt after a resolution error --
  // exactly the stale-room state the grounding invariant forbids.
  const failurePath = SOURCE.slice(SOURCE.indexOf('typedVisualContext = null;'));
  assert.match(failurePath, /visualContextPromptBlock = null;/);
  assert.match(failurePath, /roomIntelligenceBlock = null;/);
  assert.match(failurePath, /roomManifestItemCount = 0;/);
  assert.match(failurePath, /roomManifestRevision = null;/);
});

Deno.test('telemetry attributes the envelope to the gates that actually ran', () => {
  // Reporting 'contextNormalizationV1' unconditionally would misattribute an
  // envelope built solely for E4.1, and make the flag rollout unreadable.
  assert.match(SOURCE, /config\.flags\.roomIntelligenceV1 \? 'roomIntelligenceV1' : null/);
  assert.match(SOURCE, /contextNormalizationV1: config\.flags\.contextNormalizationV1/);
  assert.doesNotMatch(
    SOURCE,
    /flagState: 'contextNormalizationV1',/,
    'the hardcoded single-flag attribution must be gone',
  );
});
