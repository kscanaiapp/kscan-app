// INT-KPLUS-002 / INT-KPLUS-003 / INT-KPLUS-009 — shared actor-scope authority.
//
// One mechanism, three consumers. These tests prove the PRIMITIVE's contract
// (which is what StyleChat, AI Stylist and Watchlist all now depend on) and
// then prove each consumer actually reaches for it in source.
//
// The behavioural core is the A -> B -> A case: actor id equality alone is NOT
// sufficient, because a request captured during the FIRST A generation must
// still be rejected after the user has been away as B.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let actorContext;
test.before(async () => {
  actorContext = await import('../services/actorContext.js');
});

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function reset() {
  actorContext.__resetActorContextForTests();
}

// ── The primitive ────────────────────────────────────────────────────────────

test('a scope captured for the live actor is current', () => {
  reset();
  actorContext.advanceActorEpoch(A);
  const scope = actorContext.createActorRequest();
  assert.equal(actorContext.isActorRequestCurrent(scope), true);
});

test('A -> B: work started as A is rejected under B', () => {
  reset();
  actorContext.advanceActorEpoch(A);
  const scope = actorContext.createActorRequest();
  actorContext.advanceActorEpoch(B);
  assert.equal(actorContext.isActorRequestCurrent(scope), false);
});

test('A -> B -> A: the FIRST A generation is still rejected (id equality is not enough)', () => {
  reset();
  actorContext.advanceActorEpoch(A);
  const firstA = actorContext.createActorRequest();
  assert.equal(firstA.actorId, A);

  actorContext.advanceActorEpoch(B);
  actorContext.advanceActorEpoch(A);

  // The actor id matches again — only the epoch distinguishes the generations.
  const nowA = actorContext.getActorContext();
  assert.equal(nowA.actorId, firstA.actorId);
  assert.notEqual(nowA.epoch, firstA.epoch);
  assert.equal(
    actorContext.isActorRequestCurrent(firstA),
    false,
    'stale A work must not become current merely because the actor id matches again',
  );
});

test('sign-out invalidates in-flight authenticated work', () => {
  reset();
  actorContext.advanceActorEpoch(A);
  const scope = actorContext.createActorRequest();
  actorContext.advanceActorEpoch(null);
  assert.equal(actorContext.isActorRequestCurrent(scope), false);
});

test('the guard fails closed on malformed scopes', () => {
  reset();
  actorContext.advanceActorEpoch(A);
  for (const bad of [null, undefined, {}, 'scope', 42, { actorId: A }, { epoch: 1 }]) {
    assert.equal(actorContext.isActorRequestCurrent(bad), false, JSON.stringify(bad));
  }
});

test('the epoch advances on EVERY transition, including a repeated actor id', () => {
  reset();
  const first = actorContext.advanceActorEpoch(A);
  const second = actorContext.advanceActorEpoch(A);
  assert.equal(first.actorId, second.actorId);
  assert.ok(second.epoch > first.epoch);
});

// ── The seam ─────────────────────────────────────────────────────────────────

test('actorScope seam re-exports the canonical authority and does not fork it', () => {
  const seam = fs.readFileSync(path.join(ROOT, 'services', 'actorScope.ts'), 'utf8');
  assert.match(seam, /from '\.\/actorContext'/, 'seam must delegate to actorContext');
  // No private epoch/counter of its own: a second mechanism is the defect.
  assert.doesNotMatch(
    seam,
    /let\s+(currentEpoch|currentActorId|epoch)\s*=/,
    'the seam must not keep its own actor state',
  );
});

test('the scope key changes across A -> B -> A even though the id repeats', () => {
  reset();
  const key = () => {
    const { actorId, epoch } = actorContext.getActorContext();
    return `${actorId ?? 'anonymous'}#${epoch}`;
  };
  actorContext.advanceActorEpoch(A);
  const firstAKey = key();
  actorContext.advanceActorEpoch(B);
  const bKey = key();
  actorContext.advanceActorEpoch(A);
  const secondAKey = key();

  assert.notEqual(firstAKey, bKey);
  assert.notEqual(firstAKey, secondAKey, 'a re-authenticated A must not reuse the old scope key');
});

// ── The consumers actually use it ────────────────────────────────────────────

const CONSUMERS = [
  ['hooks/useStyleChat.ts', 'INT-KPLUS-002 StyleChat greeting'],
  ['app/stylist/index.tsx', 'INT-KPLUS-009 AI Stylist completion'],
  ['hooks/useWatchlist.ts', 'INT-KPLUS-003 Watchlist list'],
  ['app/watchlist/[watchId].tsx', 'INT-KPLUS-003 Watchlist detail'],
];

for (const [rel, label] of CONSUMERS) {
  test(`${label} consumes the shared actor scope`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /from '.*services\/actorScope'/, `${rel} must import the shared seam`);
    assert.match(src, /captureActorScope\(\)/, `${rel} must capture a scope before async work`);
    assert.match(
      src,
      /isActorScopeCurrent|currentActorScopeKey/,
      `${rel} must re-validate the scope`,
    );
  });
}

test('Watchlist no longer treats isAuthenticated as actor identity', () => {
  const list = fs.readFileSync(path.join(ROOT, 'hooks', 'useWatchlist.ts'), 'utf8');
  // isAuthenticated may still gate "is there a session at all", but it must not
  // be the ONLY key the state is scoped by.
  assert.match(list, /actorScopeKey/, 'list state must be keyed on the actor scope');
  assert.match(
    list,
    /loadedScopeKey/,
    'the list must track which actor generation its rows belong to',
  );
});

test('Watchlist detail clears actor-bound state on an actor boundary', () => {
  const detail = fs.readFileSync(path.join(ROOT, 'app', 'watchlist', '[watchId].tsx'), 'utf8');
  assert.match(detail, /setWatch\(null\)/, 'watch must be cleared on actor change');
  assert.match(detail, /setEvents\(\[\]\)/, 'events must be cleared on actor change');
  // The rendered value must be the actor-gated one, not raw state.
  assert.match(detail, /const watch = isCurrentActorData \? rawWatch : null/);
  assert.match(detail, /const events = isCurrentActorData \? rawEvents : \[\]/);
});

test('the StyleChat greeting gates its speech-eligibility write behind the scope', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  // The CALL site, not the import line.
  const idx = src.indexOf('noteInsertedGreetingForSpeech(actorId');
  assert.ok(idx > 0, 'greeting speech marker call must exist');
  // The staleness gate must appear between the await and the mutation.
  const before = src.slice(Math.max(0, idx - 800), idx);
  assert.match(
    before,
    /if \(stale\(\)\) return;/,
    'noteInsertedGreetingForSpeech must be preceded by a staleness gate',
  );
});

test('AI Stylist discards a stale generation before setResult and telemetry', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'stylist', 'index.tsx'), 'utf8');
  const setResultIdx = src.indexOf('setResult(response)');
  assert.ok(setResultIdx > 0);
  const before = src.slice(Math.max(0, setResultIdx - 600), setResultIdx);
  assert.match(
    before,
    /if \(!isActorScopeCurrent\(scope\)\) return;/,
    'setResult must be preceded by an actor-scope check',
  );
  // Telemetry sits after setResult inside the same guarded block.
  const recordIdx = src.indexOf('ai_suggestion_viewed');
  assert.ok(recordIdx > setResultIdx, 'telemetry must be inside the guarded region');
});
