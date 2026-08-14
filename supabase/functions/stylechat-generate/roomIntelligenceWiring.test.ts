/**
 * E4.1 wiring: the room manifest must actually reach the model.
 *
 * WHY THIS EXISTS: the shared module can be perfectly correct and still be
 * dead code -- which is exactly what happened to the canonical escaper and to
 * the fallback model earlier in Build 29. These assertions pin that the block
 * is built from the RESOLVED envelope and is appended to the system text on
 * every grounding path, not just one flag branch.
 */

import assert from 'node:assert/strict';

const SOURCE = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

Deno.test('the handler imports the shared room-intelligence module', () => {
  assert.match(
    SOURCE,
    /from '\.\.\/_shared\/dressingRoomIntelligence\/index\.ts'/,
    'room intelligence must come from the shared module, not a local copy',
  );
});

Deno.test('the manifest is built from the resolved envelope, not the raw request', () => {
  // buildRoomManifest admits only server_verified items, but it must still be
  // handed the RESOLVED evidence -- passing body.activeContext would hand it
  // caller-supplied trust labels.
  assert.match(
    SOURCE,
    /buildRoomManifest\(typedVisualContext\.envelope\.evidence\)/,
    'the manifest must be built from the resolved envelope',
  );
  assert.doesNotMatch(SOURCE, /buildRoomManifest\(\s*body\./);
});

Deno.test('room values are escaped with the hardened prompt escaper', () => {
  assert.match(SOURCE, /serializeRoomManifestSection\(roomManifest, escapePromptData\)/);
});

Deno.test('the room block is appended to the system text sent to the model', () => {
  assert.match(
    SOURCE,
    /const systemTextWithRoomIntelligence = roomIntelligenceBlock/,
    'the room block must extend the assembled system text',
  );
  assert.ok(
    SOURCE.includes('${systemTextForModelBase}') &&
      SOURCE.includes('${roomIntelligenceBlock}'),
    'the room block must be interpolated into the system text',
  );
  // The advice block must build ON the room-aware text, not bypass it.
  assert.ok(
    SOURCE.includes('${systemTextWithRoomIntelligence}'),
    'the advice path must extend the room-aware text',
  );
  assert.ok(
    !SOURCE.includes('${systemTextForModelBase}\\n\\n${advicePromptBlock}'),
    'the advice path must not bypass the room block',
  );
});

Deno.test('manifest size and revision are reported in telemetry', () => {
  assert.match(SOURCE, /roomManifestItemCount,/);
  assert.match(SOURCE, /roomManifestRevision,/);
  const telemetry = Deno.readTextFileSync(new URL('./telemetry.ts', import.meta.url));
  assert.match(telemetry, /'roomManifestItemCount'/);
  assert.match(telemetry, /'roomManifestRevision'/);
});

Deno.test('no room item identifiers or content are emitted as telemetry keys', () => {
  const telemetry = Deno.readTextFileSync(new URL('./telemetry.ts', import.meta.url));
  for (const forbidden of ['roomItemIds', 'roomItemTitles', 'roomId', 'itemTitle']) {
    assert.ok(!telemetry.includes(`'${forbidden}'`), `${forbidden} must not be allowlisted`);
  }
});
