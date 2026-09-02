/**
 * Build 34 / K+ Wardrobe Concierge -- actor and session isolation (2026-09-02).
 *
 * Sections 16/17/18 ask a specific question: does Concierge route through the
 * project's stale-work protection rather than re-implementing it? It does --
 * `useStyleChat` captures an actor scope before the generate call and
 * re-validates immediately after it, and the Concierge evidence block is built
 * on the far side of that gate.
 *
 * Two things were unguarded, and both are covered here.
 *
 * 1. The TS SEAM. `__tests__/actorScopeAuthority.test.js` exercises the JS
 *    primitive (`services/actorContext.js`). Nothing covered
 *    `services/actorScope.ts`, which is the module every feature hook actually
 *    imports -- the Concierge send path included. Neutralising
 *    `isActorScopeCurrent` to `return true` left the entire suite green.
 *
 *    ENVIRONMENT LIMIT, STATED PLAINLY: that seam cannot be imported under
 *    `node --test`. It uses the bundler-style extensionless specifier
 *    `from './actorContext'`, which Metro resolves and Node's loader does not.
 *    Rewriting a shared module's import specifier to suit a test is not a
 *    trade worth making, so the seam is proven a different way: the primitive
 *    is proven BEHAVIOURALLY below, and the seam is proven to be a TOTAL
 *    DELEGATION to it -- no branch, no fallback, no second comparison. Those
 *    two together are the same claim, and the second half is what a mutation
 *    to the seam now breaks.
 *
 * 2. The ORDERING. A gate that runs after the Concierge block has already been
 *    pushed into `messages` is not a gate. The ordering is what makes the
 *    protection real, so it is asserted rather than assumed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let actorContext;
test.before(async () => {
  actorContext = await import('../services/actorContext.js');
});

// ── the mechanism, behaviourally ─────────────────────────────────────────────

test('WC-007: A -> B, a Concierge turn started as A is stale under B', () => {
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch(A);
  const scope = actorContext.createActorRequest();
  actorContext.advanceActorEpoch(B);
  assert.equal(actorContext.isActorRequestCurrent(scope), false);
});

test('WC-007: A -> B -> A, the FIRST A generation is still stale', () => {
  // The id matches again. Only the epoch separates the generations, which is
  // why a captured id is not an actor identity.
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch(A);
  const firstA = actorContext.createActorRequest();
  actorContext.advanceActorEpoch(B);
  actorContext.advanceActorEpoch(A);
  assert.equal(firstA.actorId, actorContext.getActorContext().actorId);
  assert.equal(actorContext.isActorRequestCurrent(firstA), false);
});

test('WC-007: the mechanism fails closed on anything it cannot recognise', () => {
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch(A);
  for (const bogus of [null, undefined, {}, { actorId: A }, { epoch: 1 }, 'scope']) {
    assert.equal(actorContext.isActorRequestCurrent(bogus), false, String(bogus));
  }
});

// ── and that the seam Concierge imports adds nothing to it ───────────────────

test('WC-007: services/actorScope.ts is a total delegation, not a second answer', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'actorScope.ts'), 'utf8');

  // Exactly one import, and it is the canonical authority.
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./actorContext']);

  /** The body of an exported function, with comments and blank lines removed. */
  const bodyOf = (name) => {
    const at = source.indexOf(`export function ${name}(`);
    assert.ok(at > 0, `${name} is missing`);
    const open = source.indexOf('{', source.indexOf(')', at));
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return source
      .slice(open + 1, end)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
      .join(' ');
  };

  // A one-line delegation cannot disagree with the primitive. A branch here
  // could -- and `return true` is exactly the shape a regression would take.
  assert.equal(bodyOf('isActorScopeCurrent'), 'return isActorRequestCurrent(scope);');
  assert.equal(bodyOf('captureActorScope'), 'return createActorRequest();');
  assert.equal(bodyOf('currentActorId'), 'return getActorContext().actorId;');
});

// ── and that the Concierge send path sits on the right side of the gate ──────

test('WC-008: the Concierge evidence block is built AFTER the staleness gate', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');

  const capture = source.indexOf('const sendActorScope = captureActorScope();');
  assert.ok(capture > 0, 'the send path must capture an actor scope');

  const generate = source.indexOf('const result = await', capture);
  assert.ok(generate > capture, 'the generate call must follow the capture');

  const gate = source.indexOf('if (!isCurrentSend()) return;', generate);
  assert.ok(gate > generate, 'the send path must re-validate immediately after the await');

  const conciergeBlock = source.indexOf('buildConciergeResult(result.adviceMetadata', gate);
  assert.ok(
    conciergeBlock > gate,
    "a stale actor's Closet evidence must never be projected into the live actor's chat",
  );

  const optimistic = source.indexOf('...prev, optimisticAssistant', conciergeBlock);
  assert.ok(optimistic > conciergeBlock, 'the bubble is pushed after the block is built');

  // And the gate is BOTH conditions: the session scope version AND the actor
  // epoch. Either alone misses a transition the other catches.
  const predicateAt = source.indexOf('const isCurrentSend = ()');
  const predicate = source.slice(predicateAt, predicateAt + 240);
  assert.ok(predicate.includes('sendScopeVersionRef.current === sendScopeVersion'));
  assert.ok(predicate.includes('isActorScopeCurrent(sendActorScope)'));
});

test('WC-008: the send scope resets on both actor AND session change', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const at = source.indexOf('sendScopeVersionRef.current = scopeVersion;');
  assert.ok(at > 0);
  // The effect that advances it must depend on the actor and the session, so a
  // session switch invalidates an in-flight answer exactly as an account switch
  // does (section 18).
  const depsAt = source.indexOf('}, [', at);
  const deps = source.slice(depsAt, source.indexOf(']', depsAt) + 1);
  assert.ok(deps.includes('actorId'), 'the send scope must reset on actorId');
  assert.ok(deps.includes('sessionId'), 'the send scope must reset on sessionId');
});

test('WC-008: the Concierge image source is rebuilt per owner, never module-cached', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services', 'concierge', 'conciergeClosetImageSource.ts'),
    'utf8',
  );
  // A module-level mapping cache would survive an account switch and hand one
  // account's Closet photos to another.
  const factory = source.indexOf('export function createConciergeClosetImageSource');
  const mapping = source.indexOf('let mappingPromise');
  assert.ok(
    factory > 0 && mapping > factory,
    'the sidecar mapping cache must live INSIDE the per-owner factory',
  );

  const block = fs.readFileSync(
    path.join(ROOT, 'components', 'concierge', 'ConciergeEvidenceBlock.tsx'),
    'utf8',
  );
  // Images are cleared BEFORE the new resolution starts, so the previous
  // account's photos stop being displayed immediately rather than whenever the
  // new resolution happens to finish.
  const effect = block.indexOf('useEffect(() => {');
  const clear = block.indexOf('setImages({});', effect);
  const create = block.indexOf('createConciergeClosetImageSource({', effect);
  assert.ok(clear > effect && clear < create, 'stale images must be cleared before re-resolving');
  assert.ok(block.includes('}, [ownerId, clientIdKey'), 'resolution must re-run on owner change');
});
