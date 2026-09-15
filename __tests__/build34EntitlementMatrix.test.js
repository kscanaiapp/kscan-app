/**
 * BUILD 34 GOVERNING ENTITLEMENT MATRIX.
 *
 * The owner resolved the two outstanding Build 34 entitlement questions:
 *
 *     SIGNATURE_STYLE_ENTITLEMENT = FREE
 *     SMART_WATCHLIST_ENTITLEMENT = KPLUS
 *
 * and those answers are product authority, not an implementation detail. This
 * file is where they live as executable source contract.
 *
 * WHY A TEST AND NOT A NEW MODULE: the repository has no single centralized
 * product-boundary contract to extend -- the client gate-site inventory lives
 * in __tests__/kplusCoreFreeBoundary.test.js, the server gates live in SQL and
 * in each Edge Function, and the presentation rule lives in
 * types/kplusEntitlementContract.ts. Introducing a fourth architecture layer
 * during a release freeze would be a larger change than the repair it governs.
 * So the matrix is pinned here, narrowly, against the real sources.
 *
 * WHAT THIS PROTECTS
 *
 *   1. Signature Style must stay FREE. A future developer cannot re-add a K+
 *      requirement -- in the RPC, in the Edge Function, or as a client
 *      presentation gate -- without breaking a test here.
 *   2. Smart Watchlist must stay K+, enforced on the SERVER and not merely in
 *      client presentation, and must keep the PR #422 invariant that a
 *      RESOLVING entitlement is never rendered as a free-tier lock.
 *   3. The other four K+ features keep their boundaries.
 *
 * Complimentary K+ must keep working: the Watchlist assertions below pin the
 * canonical entitlement predicate (kplus_has_active_entitlement / the resolver
 * it answers from), never a paid-activation or store-receipt check.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

// ── The matrix itself ─────────────────────────────────────────────────────

const BUILD_34_ENTITLEMENT_MATRIX = Object.freeze({
  SIGNATURE_STYLE: 'FREE',
  VOICE_SCAN: 'KPLUS',
  VIRTUAL_TRY_ON: 'KPLUS',
  PACKING_INTELLIGENCE: 'KPLUS',
  WARDROBE_CONCIERGE: 'KPLUS',
  SMART_WATCHLIST: 'KPLUS',
});

test('the governing Build 34 matrix states the owner-resolved answers', () => {
  assert.equal(BUILD_34_ENTITLEMENT_MATRIX.SIGNATURE_STYLE, 'FREE');
  assert.equal(BUILD_34_ENTITLEMENT_MATRIX.SMART_WATCHLIST, 'KPLUS');
  assert.deepEqual(BUILD_34_ENTITLEMENT_MATRIX, {
    SIGNATURE_STYLE: 'FREE',
    VOICE_SCAN: 'KPLUS',
    VIRTUAL_TRY_ON: 'KPLUS',
    PACKING_INTELLIGENCE: 'KPLUS',
    WARDROBE_CONCIERGE: 'KPLUS',
    SMART_WATCHLIST: 'KPLUS',
  });
});

// ── SIGNATURE_STYLE = FREE ────────────────────────────────────────────────
//
// The authoritative definition of recompute_signature_style() is whichever
// migration defines it LAST. Resolving it dynamically is deliberate: pinning
// a filename would let a future migration re-add the K+ gate while this file
// kept asserting against a superseded historical definition.

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

function migrationsDefining(functionName) {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) =>
      new RegExp(`create or replace function public\\.${functionName}\\s*\\(`, 'i').test(
        fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
      ),
    );
}

/**
 * The body of the LAST `create or replace function public.<name>` in the tree.
 *
 * `executable` is the same text with `--` line comments removed. The forbidden
 * patterns below are checked against THAT, so a migration is free to explain
 * in prose which gate it removed (this one does) without the explanation
 * reading as the gate itself. A real gate is executable SQL and survives the
 * strip.
 */
function authoritativeFunctionSql(functionName) {
  const defining = migrationsDefining(functionName);
  assert.ok(
    defining.length > 0,
    `no migration defines public.${functionName} -- the resolver below found nothing to govern`,
  );
  const last = defining[defining.length - 1];
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, last), 'utf8');
  const start = sql.search(
    new RegExp(`create or replace function public\\.${functionName}\\s*\\(`, 'i'),
  );
  const definition = sql.slice(start);
  const executable = definition
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return { file: last, sql, definition, executable };
}

test('SIGNATURE_STYLE=FREE: the authoritative recompute RPC requires no K+ entitlement', () => {
  const { file, executable } = authoritativeFunctionSql('recompute_signature_style');
  assert.equal(
    file,
    '20260915232402_signature_style_free_closet_evidence.sql',
    'the Signature Style repair must remain the last migration to define this function',
  );
  for (const forbidden of [
    /has_active_k_plus\s*\(/,
    /kplus_has_active_entitlement\s*\(/,
    /get_my_kplus_entitlement_summary\s*\(/,
    /user_entitlements/,
    /kplus_/,
    /active K\+ entitlement required/,
    /errcode\s*=\s*'42501'/,
  ]) {
    assert.doesNotMatch(
      executable,
      forbidden,
      'SIGNATURE_STYLE_ENTITLEMENT=FREE -- Signature Style must not require K+. If this is a ' +
        'deliberate product change, the owner matrix at the top of this file changes first.',
    );
  }
});

test('SIGNATURE_STYLE=FREE: removing the K+ requirement did not remove authorization', () => {
  const { definition } = authoritativeFunctionSql('recompute_signature_style');
  // Identity is still derived server-side from auth.uid(), never an argument.
  assert.match(definition, /create or replace function public\.recompute_signature_style\(\)/);
  assert.match(definition, /v_user_id uuid := auth\.uid\(\)/);
  // A signed-out caller is still refused.
  assert.match(definition, /if v_user_id is null then/);
  assert.match(definition, /raise exception 'not authenticated' using errcode = '28000'/);
  // Still SECURITY DEFINER with a pinned search_path and the column pragma.
  assert.match(definition, /security definer/);
  assert.match(definition, /set search_path = ''/);
  assert.match(definition, /#variable_conflict use_column/);
  // EVERY owned-item source read, and the profile lookup, stay scoped to the
  // caller's own rows. Asserted structurally rather than by a magic count, so
  // adding a legitimate new evidence source cannot silently add an UNSCOPED
  // read: each `from public.<table>` must carry `user_id = v_user_id` before
  // the next one begins.
  const { executable } = authoritativeFunctionSql('recompute_signature_style');
  const reads = [...executable.matchAll(/from public\.(\w+)/g)];
  assert.ok(reads.length >= 3, 'expected at least the two evidence sources plus the profile lookup');
  for (let i = 0; i < reads.length; i += 1) {
    const start = reads[i].index;
    const end = i + 1 < reads.length ? reads[i + 1].index : executable.length;
    assert.match(
      executable.slice(start, end),
      /user_id = v_user_id/,
      `the read of public.${reads[i][1]} is not scoped to auth.uid()'s own rows`,
    );
  }
  assert.match(definition, /on conflict \(user_id\) do update/);
  // anon gains nothing; authenticated keeps exactly the execute grant it had.
  assert.match(
    definition,
    /revoke all on function public\.recompute_signature_style\(\) from public, anon;/,
  );
  assert.match(
    definition,
    /grant execute on function public\.recompute_signature_style\(\) to authenticated;/,
  );
  assert.doesNotMatch(definition, /grant execute on function public\.recompute_signature_style\(\) to (anon|public)/);
});

test('SIGNATURE_STYLE=FREE: the stored profile stays own-row-only under RLS', () => {
  const rls = read('supabase', 'migrations', '20260830060000_user_style_profiles.sql');
  // Cross-user read denial is RLS, and the repair did not touch it.
  assert.match(rls, /alter table public\.user_style_profiles enable row level security;/);
  assert.match(rls, /for select\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)/);
  // There is still no client INSERT/UPDATE/DELETE policy at all, so the RPC
  // remains the single write path.
  assert.doesNotMatch(rls, /for (insert|update|delete)\s+to (authenticated|anon)/);
  assert.match(rls, /revoke all on public\.user_style_profiles from anon, authenticated, public;/);
  assert.match(rls, /grant select on public\.user_style_profiles to authenticated;/);
});

test('SIGNATURE_STYLE=FREE: the Edge Function resolves it without consulting K+', () => {
  const source = read('supabase', 'functions', 'stylechat-generate', 'index.ts');
  const marker = 'let serverSignatureStyleProfile';
  const start = source.indexOf(marker);
  assert.ok(start > 0, 'the server-derived Signature Style block was not found');
  const end = source.indexOf('const serverSignatureStyleBlock', start);
  assert.ok(end > start, 'the Signature Style block terminator was not found');
  const block = source.slice(start, end);

  // The recompute request must not sit behind the K+ answer.
  assert.match(block, /getOrRecomputeSignatureStyleProfile\(\{ supabase: userClient \}\)/);
  const recomputeAt = block.indexOf('getOrRecomputeSignatureStyleProfile({ supabase: userClient })');
  const enclosingGuard = block.lastIndexOf('if (hasActiveKPlusForWardrobeContext)', recomputeAt);
  assert.equal(
    enclosingGuard,
    -1,
    'SIGNATURE_STYLE_ENTITLEMENT=FREE -- the Signature Style recompute must not be nested inside ' +
      'the K+ Wardrobe Concierge entitlement guard.',
  );
  // And it must not grow its own entitlement probe either.
  const afterKPlusProbe = block.slice(block.indexOf('hasActiveKPlusForWardrobeContext = kPlusActive === true;'));
  assert.doesNotMatch(
    afterKPlusProbe.slice(0, afterKPlusProbe.indexOf('getOrRecomputeSignatureStyleProfile')),
    /rpc\('(has_active_k_plus|kplus_has_active_entitlement|get_my_kplus_entitlement_summary)'/,
    'Signature Style must not gain a second entitlement probe of its own',
  );
});

test('SIGNATURE_STYLE=FREE: no client surface renders a K+ boundary for Signature Style', () => {
  const surfaces = [
    ['app', 'style-chat', '[sessionId].tsx'],
    ['components', 'style-chat', 'StyleChatSignatureStyleCard.tsx'],
    ['components', 'style-chat', 'SignatureStyleSettingsSection.tsx'],
    ['components', 'style-chat', 'StyleChatFeedbackControls.tsx'],
    ['components', 'style-chat', 'StyleChatReasonChips.tsx'],
    ['hooks', 'useSignatureStyleFeedback.ts'],
    ['hooks', 'useSignatureStylePreferences.ts'],
    ['services', 'signature-style', 'signatureStyleContext.ts'],
    ['services', 'signature-style', 'localSignatureStyleProfile.ts'],
    ['services', 'signature-style', 'localSignatureStylePreferences.ts'],
    ['services', 'signature-style', 'localSignatureStyleFeedbackStore.ts'],
    ['services', 'signature-style', 'localSignatureStyleReasons.ts'],
  ];
  for (const segments of surfaces) {
    const relPath = segments.join('/');
    const source = read(...segments);
    // app/style-chat/[sessionId].tsx legitimately READS K+ to choose Concierge
    // vs base wait copy (governed and counted by kplusCoreFreeBoundary.test.js).
    // What no Signature Style surface may do is render a lock, a paywall or an
    // upgrade route for Signature Style itself.
    assert.doesNotMatch(
      source,
      /<KPlusGate[\s\S]{0,400}[Ss]ignature\s?Style/,
      `${relPath}: Signature Style must not be wrapped in a K+ gate`,
    );
    assert.doesNotMatch(
      source,
      /[Ss]ignature\s?Style[\s\S]{0,200}(Unlock with K\+|Upgrade to K\+|UNLOCK WITH K\+|openUpgrade)/,
      `${relPath}: Signature Style must not present a K+ acquisition boundary`,
    );
  }
});

// ── SMART_WATCHLIST = KPLUS ───────────────────────────────────────────────

test('SMART_WATCHLIST=KPLUS: the capability boundary is enforced on the server, not only the client', () => {
  const createSql = read(
    'supabase',
    'migrations',
    '20260830190500_watchlist_create_honours_changed_intent.sql',
  );
  const lifecycleSql = read(
    'supabase',
    'migrations',
    '20260830151500_user_commerce_watch_events_and_rpcs.sql',
  );
  const claimSql = read(
    'supabase',
    'migrations',
    '20260831120500_claim_user_commerce_watches_for_refresh.sql',
  );
  const edge = read('supabase', 'functions', 'commerce-watch-refresh', 'index.ts');

  // CREATE: the authoritative definition re-checks K+ inside the database.
  assert.match(createSql, /if not public\.kplus_has_active_entitlement\(p_user_id, 'k_plus'\) then/);
  assert.match(createSql, /raise exception 'K\+ required' using errcode = '42501'/);
  // RESUME (re-activation) does the same.
  assert.match(
    lifecycleSql,
    /create or replace function public\.resume_user_commerce_watch[\s\S]*?if not public\.kplus_has_active_entitlement\(p_user_id, 'k_plus'\) then/,
  );
  // REFRESH: gated in the Edge Function AND re-checked at claim time in SQL.
  assert.match(edge, /rpc\('kplus_has_active_entitlement', \{ p_user_id: authUser\.id, p_entitlement_key: 'k_plus' \}\)/);
  assert.match(edge, /if \(!kplusActive\) \{[\s\S]{0,120}kplus_required/);
  assert.match(claimSql, /public\.kplus_has_active_entitlement\(p_user_id, 'k_plus'\)/);

  // A client can never reach these functions directly: they are service_role
  // only, so client manipulation cannot bypass the server boundary.
  for (const fn of [
    'create_user_commerce_watch',
    'resume_user_commerce_watch',
    'pause_user_commerce_watch',
    'delete_user_commerce_watch',
  ]) {
    const sql = fn === 'create_user_commerce_watch' ? createSql : lifecycleSql;
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`),
      `${fn} must not be directly callable by a client`,
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`),
      `${fn} must never be granted to authenticated`,
    );
  }
  assert.match(
    claimSql,
    /revoke all on function public\.claim_user_commerce_watches_for_refresh/,
  );
});

test('SMART_WATCHLIST=KPLUS: the boundary answers from the canonical entitlement authority, so complimentary K+ works', () => {
  const createSql = read(
    'supabase',
    'migrations',
    '20260830190500_watchlist_create_honours_changed_intent.sql',
  );
  const edge = read('supabase', 'functions', 'commerce-watch-refresh', 'index.ts');
  // kplus_has_active_entitlement answers from the resolver -- the union of
  // every currently valid grant, complimentary included. A Watchlist gate that
  // asked about a purchase, a store receipt or a RevenueCat mirror instead
  // would deny a complimentary K+ member.
  for (const source of [createSql, edge]) {
    assert.doesNotMatch(source, /revenuecat/i, 'the Watchlist K+ boundary must not depend on a store mirror');
    assert.doesNotMatch(source, /paid_(ios|android)/, 'the Watchlist K+ boundary must not require a paid grant reason');
  }
  assert.match(createSql, /kplus_has_active_entitlement/);
});

test('SMART_WATCHLIST=KPLUS: user-owned watch rows stay isolated to their owner', () => {
  const tableSql = read('supabase', 'migrations', '20260830150000_user_commerce_watches.sql');
  assert.match(tableSql, /create policy "select own commerce watches"[\s\S]*?using \(user_id = auth\.uid\(\)\)/);
  // No client write privilege of any kind on the table itself.
  assert.match(tableSql, /revoke all on public\.user_commerce_watches from anon, authenticated, public;/);
  assert.match(tableSql, /grant select on public\.user_commerce_watches to authenticated;/);
  assert.doesNotMatch(
    tableSql,
    /grant (select, )?(insert|update|delete)[^;]*to (authenticated|anon)/,
  );
});

test('SMART_WATCHLIST=KPLUS: RESOLVING is never rendered as a free-tier lock (PR #422)', () => {
  // The predicate itself.
  const entitlements = read('types', 'entitlements.ts');
  assert.match(entitlements, /export function isKPlusEntitlementUnresolved\(state: KPlusResolvedState\): boolean \{\s*return state === 'loading' \|\| state === 'error';/);
  assert.match(
    read('types', 'kplusEntitlementContract.ts'),
    /export function shouldPresentKPlusPaywall\(state: KPlusEntitlementClientState\): boolean \{\s*return state\.status === 'resolved' && state\.summary\.access === 'free';/,
  );
  // KPlusGate hands every consumer the resolved answer rather than letting
  // each surface re-derive it from isActive alone.
  assert.match(read('components', 'kplus', 'KPlusGate.tsx'), /resolving: isKPlusEntitlementUnresolved\(state\)/);
  // And every Watchlist affordance honours it instead of routing an unresolved
  // actor into the upgrade sheet.
  for (const segments of [
    ['components', 'home', 'HomeLuxuryTechV1.tsx'],
    ['components', 'ProductShelf.tsx'],
    ['components', 'scan-results', 'PurchaseOptionsPanel.tsx'],
  ]) {
    const source = read(...segments);
    const gateAt = source.indexOf('<KPlusGate source="watchlist">');
    assert.ok(gateAt > 0, `${segments.join('/')}: the Watchlist K+ gate is missing`);
    const gate = source.slice(gateAt, gateAt + 1400);
    assert.match(gate, /\{\(\{[^}]*resolving[^}]*\}\) =>/, 'the Watchlist gate must consume `resolving`');
    assert.match(gate, /if \(resolving\) return;/, 'an unresolved actor must not be routed anywhere');
    assert.match(gate, /if \(isActive\)/);
    assert.match(gate, /else openUpgrade\(\);/, 'only a resolved free actor sees the acquisition boundary');
  }
});

test('SMART_WATCHLIST=KPLUS: availability and entitlement stay separate authorities', () => {
  const availability = read('services', 'watchlist', 'watchlistAvailability.ts');
  // Availability answers "does this build ship Watchlist", never "may this
  // actor use it" -- collapsing the two would make the K+ boundary a build
  // flag, which a client can never be trusted to hold. Scoped to the resolver
  // body: the module's own prose explains the distinction at length.
  const resolverAt = availability.indexOf('export function resolveWatchlistAvailable(');
  assert.ok(resolverAt > 0, 'resolveWatchlistAvailable is missing');
  const resolverBody = availability.slice(resolverAt);
  assert.match(resolverBody, /smartWatchlistActive === true/);
  assert.doesNotMatch(
    resolverBody,
    /kplus|k_plus|entitle/i,
    'the availability resolver must have no entitlement input at all',
  );
  const client = read('services', 'watchlist', 'watchlistClient.ts');
  // The client never decides entitlement: the refusal it can produce locally
  // is feature_unavailable, and kplus_required only ever arrives FROM the
  // server.
  assert.match(client, /const FEATURE_UNAVAILABLE = \{ ok: false as const, reason: 'feature_unavailable' as const \}/);
  assert.doesNotMatch(client, /reason: 'kplus_required'/);
});

// ── The other four K+ boundaries are unchanged by this repair ─────────────

test('the other K+ boundaries keep their client gate sites', () => {
  const gates = {
    voice_scan: [
      ['components', 'home', 'HomeVoiceScanPill.tsx'],
      ['components', 'text-scan', 'VoiceScanButton.tsx'],
      ['components', 'text-scan', 'TextScanFeatureRow.tsx'],
    ],
    vto: [['components', 'vto', 'TryItOnEntry.tsx']],
    packing: [['app', 'packing', 'index.tsx']],
    watchlist: [
      ['app', 'watchlist', '[watchId].tsx'],
      ['components', 'ProductShelf.tsx'],
      ['components', 'home', 'HomeLuxuryTechV1.tsx'],
      ['components', 'scan-results', 'PurchaseOptionsPanel.tsx'],
    ],
  };
  for (const [source, files] of Object.entries(gates)) {
    for (const segments of files) {
      assert.match(
        read(...segments),
        new RegExp(`<KPlusGate\\s+source="${source}"`),
        `${segments.join('/')} must keep its ${source} K+ gate -- this repair changes only Signature Style`,
      );
    }
  }
});

test('the Wardrobe Concierge Closet sources stay behind the server K+ answer', () => {
  const source = read('supabase', 'functions', 'stylechat-generate', 'index.ts');
  assert.match(source, /\.\.\.\(hasActiveKPlusForWardrobeContext/);
  const spreadAt = source.indexOf('...(hasActiveKPlusForWardrobeContext');
  const gated = source.slice(spreadAt, source.indexOf('let closetCensus: EliseClosetCensus | null = null;', spreadAt));
  assert.ok(gated.includes('async listClosetItems('));
  assert.ok(gated.includes('async listClosetCensusRows('));
  // Closet RLS is the independent second backstop, and this repair did not
  // touch it.
  assert.match(
    read('supabase', 'migrations', '20260829204635_user_closet_items_optimize_rls_initplan.sql'),
    /using \(user_id = \(select auth\.uid\(\)\) and \(select public\.has_active_k_plus\(\)\)\)/,
  );
});
