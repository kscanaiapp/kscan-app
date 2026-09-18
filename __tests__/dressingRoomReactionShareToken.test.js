// B34-FE-DR-001 — anonymous share-link viewers must actually get reaction counts.
//
// WHY THIS FILE EXISTS. The governed backend signature is
//
//     get_item_reaction_counts(p_item_ids uuid[], p_share_token text DEFAULT NULL)
//
// and its authorization predicate has three arms: the room's owner (decided
// from auth.uid()), an authenticated member of a live share (decided from
// shared_room_memberships), and an ANONYMOUS viewer -- who is authorized ONLY
// when p_share_token is non-null and matches an active, non-revoked,
// non-expired share on that item's room.
//
// The client sent one argument. On the one surface where the caller is
// anonymous -- app/(public)/rooms/[token].tsx, the public share-link screen --
// the predicate therefore matched nothing and the RPC returned ZERO ROWS. The
// screen does not treat that as an error: buildReactionCountsByItem fills every
// item from an empty row set, so a room full of reactions rendered as a
// confident "0" on every item. Silently wrong numbers, not a missing section,
// which is why no error state and no test caught it.
//
// The pre-existing suite was green over all of it: styleObjectsContract asserts
// that the public screen references `getItemReactionCounts` and never that the
// call carries what the backend needs to authorize it.
//
// So this file tests the CALL SHAPE at both kinds of call site, plus the pure
// argument-building rule, because the wiring is exactly what was wrong.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SERVICE = 'services/styleObjects.ts';
const PUBLIC_SCREEN = 'app/(public)/rooms/[token].tsx';
const OWNER_SCREEN = 'app/dressing-rooms/[id].tsx';

const service = read(SERVICE);
const serviceCode = stripComments(service);
const publicScreenCode = stripComments(read(PUBLIC_SCREEN));
const ownerScreenCode = stripComments(read(OWNER_SCREEN));

/** Every `getItemReactionCounts(...)` CALL in a file, with its argument text. */
function reactionCountCalls(code) {
  const calls = [];
  const re = /getItemReactionCounts\(/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    let depth = 1;
    let index = re.lastIndex;
    while (index < code.length && depth > 0) {
      const ch = code[index];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      index += 1;
    }
    calls.push(code.slice(re.lastIndex, index - 1));
  }
  return calls;
}

// ── The service accepts and forwards the token ──────────────────────────────

test('getItemReactionCounts accepts a shareToken and forwards it as p_share_token', () => {
  assert.match(
    serviceCode,
    /export async function getItemReactionCounts\(\s*itemIds: string\[\],\s*options: \{ shareToken\?: string \| null \} = \{\},/,
    'the service must expose a shareToken option',
  );
  assert.match(
    serviceCode,
    /args\.p_share_token = shareToken/,
    'the token must be sent under the exact backend parameter name',
  );
});

test('the owner/member call shape is unchanged: no token key is sent without a token', () => {
  // The backend ignores p_share_token entirely for an authenticated caller, so
  // sending it there would be noise; more importantly, an unconditional key
  // would break any environment still carrying the single-argument function.
  assert.match(
    serviceCode,
    /if \(withToken && shareToken\) args\.p_share_token = shareToken;/,
    'the token key must be conditional on a token actually being present',
  );
  assert.match(
    serviceCode,
    /const args: \{ p_item_ids: string\[\]; p_share_token\?: string \} = \{ p_item_ids: batch \};/,
    'p_item_ids must always be sent and p_share_token must be optional',
  );
});

test('a missing overload falls back to the token-less shape, and nothing else does', () => {
  assert.match(
    serviceCode,
    /if \(!isMissingRpcOverloadError\(error\)\) throw error;/,
    'only a missing-overload error may trigger the compatibility fallback',
  );
  assert.match(
    serviceCode,
    /candidate\.code === 'PGRST202'/,
    'the fallback must key on the PostgREST missing-function code',
  );
});

// ── The anonymous surface supplies the token ────────────────────────────────

test('EVERY reaction-count call on the public share-link screen carries the share token', () => {
  const calls = reactionCountCalls(publicScreenCode);
  assert.ok(calls.length >= 2, `expected the public screen to load and refresh counts, found ${calls.length} call(s)`);
  for (const args of calls) {
    assert.match(
      args,
      /shareToken:\s*(normalizedRouteToken|routeTokenRef\.current)/,
      `a public-screen reaction call omits the share token: getItemReactionCounts(${args.trim()})`,
    );
  }
});

test('the token the public screen sends is the VALIDATED route token, never the raw param', () => {
  // normalizeRoomShareToken rejects anything outside [A-Za-z0-9_-]{1,160}; the
  // raw `token` search param is untrusted input and must not reach the RPC.
  assert.match(publicScreenCode, /const normalizedRouteToken = normalizeRoomShareToken\(rawToken\)/);
  assert.match(publicScreenCode, /routeTokenRef\.current = normalizedRouteToken/);
  for (const args of reactionCountCalls(publicScreenCode)) {
    assert.doesNotMatch(
      args,
      /shareToken:\s*(rawToken|token)\b/,
      'the unvalidated route param must never be sent as the share token',
    );
  }
});

// ── The authenticated surface does NOT ─────────────────────────────────────

test('the owner/member Dressing Room screen sends no share token', () => {
  const calls = reactionCountCalls(ownerScreenCode);
  assert.ok(calls.length > 0, 'the owner screen must still read reaction counts');
  for (const args of calls) {
    assert.doesNotMatch(
      args,
      /shareToken/,
      'the authenticated surface is authorized by its session; a token there would be misleading',
    );
  }
});

// ── Negative controls ──────────────────────────────────────────────────────

test('NEGATIVE CONTROL: the call extractor actually finds and reads arguments', () => {
  const sample = 'const a = await getItemReactionCounts(ids);\nconst b = getItemReactionCounts(x, { shareToken: routeTokenRef.current });';
  const found = reactionCountCalls(sample);
  assert.equal(found.length, 2);
  assert.equal(found[0], 'ids');
  assert.match(found[1], /shareToken: routeTokenRef\.current/);
  // And the assertion above would reject the first of those.
  assert.throws(() => assert.match(found[0], /shareToken:/));
});

test('NEGATIVE CONTROL: the backend parameter name is spelled the way the function declares it', () => {
  // A rename to `shareToken` or `p_token` would be accepted by PostgREST as a
  // DIFFERENT argument shape and resolve to the default-null overload again --
  // reproducing the original defect with the fix apparently in place.
  assert.match(serviceCode, /p_share_token/);
  assert.doesNotMatch(serviceCode, /rpc\('get_item_reaction_counts'[\s\S]{0,200}?p_token\b/);
});
