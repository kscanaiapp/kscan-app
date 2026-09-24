const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const read = () => fs.readFileSync(APP, 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, 'missing start marker: ' + startMarker);
  assert.ok(end > start, 'missing end marker: ' + endMarker);
  return source.slice(start, end);
}

function assertSavedIdRaceContract(source) {
  assert.match(source, /const scanPersistenceGenerationRef = useRef\(0\)/);
  assert.match(
    source,
    /if \(status === 'processing'\) \{[\s\S]*?scanPersistenceGenerationRef\.current \+= 1;/,
    'a genuinely new scan must invalidate saves from the previous generation',
  );
  assert.match(
    source,
    /useEffect\(\(\) => \(\) => \{\s*scanPersistenceGenerationRef\.current \+= 1;\s*\}, \[\]\);/,
    'unmount must invalidate an outstanding save before it can set component state',
  );

  const single = sliceBetween(
    source,
    '// Save each successful scan once to the local Style Library.',
    '// v127: attach commerce that arrived after the scan row was already written.',
  );
  assert.match(single, /const saveGeneration = scanPersistenceGenerationRef\.current;/);
  assert.match(single, /saveGeneration === scanPersistenceGenerationRef\.current/);
  assert.match(single, /isActorRequestCurrent\(actorRequest\)/);
  assert.doesNotMatch(single, /let live = true/);
  assert.doesNotMatch(single, /return \(\) => \{ live = false; \}/);

  const multi = sliceBetween(
    source,
    '// Build 32: save a multi-item detection result once',
    '// Build 32: attach multi-item commerce once hydration completes.',
  );
  assert.match(multi, /const saveGeneration = scanPersistenceGenerationRef\.current;/);
  assert.match(multi, /saveGeneration === scanPersistenceGenerationRef\.current/);
  assert.match(multi, /isActorRequestCurrent\(actorRequest\)/);
  assert.doesNotMatch(multi, /let live = true/);
  assert.doesNotMatch(multi, /return \(\) => \{ live = false; \}/);
}

test('single- and multi-item scanner saves retain their persisted id across enrichment object replacement', () => {
  assertSavedIdRaceContract(read());
});

test('NEGATIVE CONTROL: removing the generation guard is detected', () => {
  const source = read();
  const mutated = source.replace(/\s*saveGeneration === scanPersistenceGenerationRef\.current &&/g, '');
  assert.notEqual(mutated, source, 'mutation must alter the production source');
  assert.throws(() => assertSavedIdRaceContract(mutated));
});

test('NEGATIVE CONTROL: restoring the legacy effect-cleanup cancellation is detected', () => {
  const source = read();
  const marker = '    const saveGeneration = scanPersistenceGenerationRef.current;';
  const index = source.indexOf(marker);
  assert.ok(index >= 0, 'single-save generation marker must exist');
  const mutated = source.slice(0, index) +
    '    let live = true;\n' + source.slice(index);
  assert.throws(() => assertSavedIdRaceContract(mutated));
});
