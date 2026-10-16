/**
 * Prepare-only live Staging probe for #592. Import and call from an authorized
 * caller holding fresh purpose-created fixture credentials IN MEMORY. This
 * module reads no credential files/env and never prints or persists inputs.
 *
 * Run only after the governed greeting migration is verified on Staging.
 * Does not invoke Speech/providers or alter any provider/entitlement control.
 * Cleanup is opt-in: confirm the EXACT purpose-created session ID separately.
 * The caller owns fixture-account creation/deletion and evidence persistence.
 */
import { createClient } from '@supabase/supabase-js';

const STAGING_HOST = 'yzqjvdfgefveprobvvyw.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const check = (condition, stage) => { if (!condition) throw new Error(`Greeting probe: ${stage}`); };
const isGreeting = (row) => row?.sender === 'assistant' && Array.isArray(row.ui_blocks)
  && row.ui_blocks.some((block) => block?.type === 'greeting');

async function request(query, stage) {
  try { return await query; } catch { throw new Error(`Greeting probe: ${stage} request failed`); }
}

export async function verifyGreetingConcurrency({
  stagingUrl,
  publishableKey,
  serviceRoleKey,
  accessTokens,
  expectedActorId,
  expectedSessionId,
  confirmPurposeCreatedEmptySession = false,
  cleanupPurposeCreatedSessionId,
}) {
  let url;
  try { url = new URL(stagingUrl); } catch { throw new Error('Greeting probe: Staging URL required'); }
  check(url.protocol === 'https:' && url.hostname === STAGING_HOST
    && !url.port && !url.search && !url.hash && !url.username && !url.password
    && (url.pathname === '/' || url.pathname === ''), 'Staging URL required');
  check(typeof publishableKey === 'string' && publishableKey.length > 0, 'public credential required');
  check(typeof serviceRoleKey === 'string' && serviceRoleKey.length > 0, 'metadata/cleanup service credential required');
  check(UUID.test(expectedActorId) && UUID.test(expectedSessionId), 'exact fixture scope required');
  check(confirmPurposeCreatedEmptySession === true, 'caller must confirm purpose-created empty session');
  check(Array.isArray(accessTokens) && accessTokens.length === 2
    && accessTokens.every((token) => typeof token === 'string' && token.length > 0)
    && accessTokens[0] !== accessTokens[1], 'two independent access tokens required');
  const cleanup = cleanupPurposeCreatedSessionId !== undefined;
  check(!cleanup || cleanupPurposeCreatedSessionId === expectedSessionId, 'cleanup confirmation must match exact fixture session');
  const authOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  const admin = createClient(url.origin, serviceRoleKey, { auth: authOptions });
  const clients = accessTokens.map((token) => createClient(url.origin, publishableKey, {
    auth: authOptions, global: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const day = new Date().toISOString().slice(0, 10);
  const readCost = async () => {
    const control = await request(admin.from('speech_provider_control')
      .select('enabled,daily_character_limit').eq('singleton', true).single(), 'control metadata');
    const cost = await request(admin.from('speech_daily_cost')
      .select('characters_consumed').eq('day', day).maybeSingle(), 'fleet metadata');
    const reservations = await request(admin.from('speech_request_reservations')
      .select('id', { count: 'exact', head: true }), 'reservation count');
    check(!control.error && !cost.error && !reservations.error
      && typeof reservations.count === 'number', 'cost metadata unavailable');
    check(control.data?.enabled === false && control.data?.daily_character_limit === 0, 'Staging must remain OFF/0');
    return { charactersConsumed: Number(cost.data?.characters_consumed ?? 0), reservationCount: reservations.count };
  };
  let verifiedEmptyFixture = false;
  let cleaned = false;
  try {
    const users = await Promise.all(clients.map((client, index) =>
      request(client.auth.getUser(accessTokens[index]), 'authenticated identity')));
    check(users.every((result) => !result.error && result.data.user?.id === expectedActorId
      && result.data.user?.is_anonymous !== true), 'both authenticated actors must own the fixture');
    let sessionClaims;
    try {
      // getUser above verified the tokens; these signed claims are used only
      // to certify independent login sessions, not to authorize row ownership.
      sessionClaims = accessTokens.map((token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).session_id);
    } catch { throw new Error('Greeting probe: independent session metadata unavailable'); }
    check(sessionClaims.every((id) => typeof id === 'string' && id.length > 0)
      && sessionClaims[0] !== sessionClaims[1], 'two independent authenticated sessions required');
    const owners = await Promise.all(clients.map((client) => request(client.from('style_chat_sessions')
      .select('id,user_id').eq('id', expectedSessionId).eq('user_id', expectedActorId).maybeSingle(), 'owned session')));
    check(owners.every((result) => !result.error && result.data?.id === expectedSessionId
      && result.data?.user_id === expectedActorId), 'fixture session ownership unavailable');
    const empty = await request(admin.from('style_chat_messages')
      .select('id', { count: 'exact', head: true }).eq('session_id', expectedSessionId), 'empty fixture');
    check(!empty.error && empty.count === 0, 'fixture session must contain no existing history');
    verifiedEmptyFixture = true;
    const before = await readCost();
    const payload = { user_id: expectedActorId, session_id: expectedSessionId,
      sender: 'assistant', content: 'Synthetic concurrency greeting',
      ui_blocks: [{ type: 'greeting' }], provider: 'greeting', token_estimate: 0 };
    const started = performance.now();
    const inserts = await Promise.all(clients.map((client) => request(client.from('style_chat_messages')
      .insert(payload).select('id').single(), 'competing greeting insert')));
    const winners = inserts.filter((result) => !result.error && result.data?.id);
    const conflicts = inserts.filter((result) => result.error?.code === '23505');
    check(winners.length === 1 && conflicts.length === 1, 'expected one success and one SQLSTATE23505 conflict');
    const reads = await Promise.all(clients.map((client) => request(client.from('style_chat_messages')
      .select('id,sender,ui_blocks').eq('user_id', expectedActorId).eq('session_id', expectedSessionId), 'winner reload')));
    const greetingRows = reads.map((result) => {
      check(!result.error && Array.isArray(result.data), 'owned winner reload failed');
      return result.data.filter(isGreeting);
    });
    check(greetingRows.every((rows) => rows.length === 1 && rows[0].id === winners[0].data.id), 'clients must reload one identical winner');
    const after = await readCost();
    check(day === new Date().toISOString().slice(0, 10), 'UTC accounting day changed; requalify separately');
    check(after.charactersConsumed === before.charactersConsumed
      && after.reservationCount === before.reservationCount, 'Speech accounting changed during provider-free probe');
    const result = { result: 'PASS', environment: 'Staging', migration: '20261015214749',
      concurrentInserts: 2, successfulInserts: 1, uniqueConflicts: 1,
      persistedGreetings: 1, bothWinnerReadsAgree: true,
      durationMs: Math.round(performance.now() - started), providerCallsMade: 0,
      fleetCharacterDelta: 0, reservationDelta: 0, providerEnabled: false, dailyCharacterLimit: 0,
      speechAutoClaimScope: 'No Speech invoked; independent client regression verifies only inserter arms one claim',
      cleanupRequested: cleanup };
    if (cleanup) {
      const removed = await request(admin.from('style_chat_sessions').delete()
        .eq('id', expectedSessionId).eq('user_id', expectedActorId).select('id'), 'exact fixture cleanup');
      check(!removed.error && removed.data?.length === 1, 'exact fixture cleanup failed');
      const absent = await request(admin.from('style_chat_sessions').select('id')
        .eq('id', expectedSessionId).eq('user_id', expectedActorId).maybeSingle(), 'cleanup read-back');
      check(!absent.error && absent.data === null, 'fixture session not absent after cleanup');
      cleaned = true;
      result.cleanupVerified = true;
    }
    return result;
  } finally {
    // A failed assertion can still have inserted synthetic rows. Cleanup is
    // permitted only for the caller-confirmed EXACT session verified empty
    // before this probe, never for actors/sessions discovered by a broad query.
    if (cleanup && verifiedEmptyFixture && !cleaned) {
      const removed = await request(admin.from('style_chat_sessions').delete()
        .eq('id', expectedSessionId).eq('user_id', expectedActorId), 'failure fixture cleanup');
      check(!removed.error, 'failure fixture cleanup failed');
      const absent = await request(admin.from('style_chat_sessions').select('id')
        .eq('id', expectedSessionId).eq('user_id', expectedActorId).maybeSingle(), 'failure cleanup read-back');
      check(!absent.error && absent.data === null, 'fixture session not absent after failure cleanup');
    }
  }
}
