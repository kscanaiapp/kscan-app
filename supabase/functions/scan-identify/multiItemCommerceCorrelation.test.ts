/**
 * Build 32 — MODE B per-item correlation id (candidateId).
 *
 * Source-wiring tests, matching the convention `commerceFunnel.v127.test.ts`
 * already uses for `index.ts` internals that cannot be imported directly
 * (the file is a Deno serve() entrypoint, not an importable module).
 *
 * What this pins:
 *   - candidateId is a pure passthrough: parsed via the same bounded
 *     `safeString` sanitizer as every other MODE B string field;
 *   - it is echoed on BOTH MODE B response paths (provider-error and
 *     success), never only one;
 *   - it never reaches ranking, filtering, or provider query construction —
 *     grepping the request-building call for it must find nothing.
 */
import assert from 'node:assert/strict';

async function readIndexSource(): Promise<string> {
  return await Deno.readTextFile(new URL('./index.ts', import.meta.url));
}

Deno.test('readCommerceOnlyCandidateId exists and reuses the bounded string sanitizer', async () => {
  const src = await readIndexSource();
  const fnStart = src.indexOf('function readCommerceOnlyCandidateId(');
  assert.ok(fnStart > 0, 'readCommerceOnlyCandidateId is missing');
  const fnSlice = src.slice(fnStart, fnStart + 300);
  assert.ok(
    fnSlice.includes('return safeString(body.candidateId);'),
    'candidateId must go through the same bounded/trimmed sanitizer as every other MODE B string field, not a raw pass-through',
  );
});

Deno.test('MODE B parses candidateId only after evidence validation, never before', async () => {
  const src = await readIndexSource();
  const modeBStart = src.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body)) {');
  assert.ok(modeBStart > 0, 'MODE B block is missing');

  const evidenceParseIndex = src.indexOf('const evidence = readCommerceOnlyEvidence(body);', modeBStart);
  const candidateIdParseIndex = src.indexOf('const commerceOnlyCandidateId = readCommerceOnlyCandidateId(body);', modeBStart);
  assert.ok(evidenceParseIndex > modeBStart, 'evidence parse not found in MODE B');
  assert.ok(candidateIdParseIndex > evidenceParseIndex, 'candidateId must be read after evidence validation, not before');
});

Deno.test('MODE B echoes candidateId on both the provider-error and success response paths', async () => {
  const src = await readIndexSource();
  const modeBStart = src.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body)) {');
  const modeBEnd = src.indexOf('\n  if (useMultiItemProvider && requestMode ===', modeBStart);
  assert.ok(modeBStart > 0 && modeBEnd > modeBStart, 'could not bound the MODE B block');
  const modeB = src.slice(modeBStart, modeBEnd);

  const echoCount = modeB.split('...(commerceOnlyCandidateId ? { candidateId: commerceOnlyCandidateId } : {}),').length - 1;
  assert.equal(echoCount, 2, `expected candidateId echoed on exactly 2 response paths (provider-error + success), found ${echoCount}`);
});

Deno.test('candidateId never reaches provider query construction (getFastCommerceResults input)', async () => {
  const src = await readIndexSource();
  const modeBStart = src.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body)) {');
  const fastCallStart = src.indexOf('const fast = await getFastCommerceResults({', modeBStart);
  const fastCallEnd = src.indexOf('}).catch(', fastCallStart);
  assert.ok(fastCallStart > modeBStart && fastCallEnd > fastCallStart, 'could not bound the getFastCommerceResults call');
  const fastCallArgs = src.slice(fastCallStart, fastCallEnd);
  assert.ok(
    !fastCallArgs.includes('candidateId') && !fastCallArgs.includes('commerceOnlyCandidateId'),
    'candidateId must be pure correlation metadata — it must never be passed into commerce retrieval, ranking, or query construction',
  );
});
