const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, runModule } = require('./helpers/componentRenderer');

const MIGRATION = 'supabase/migrations/20261004184118_kplus_offer_code_redemption_authority.sql';
const EDGE = 'supabase/functions/kplus-offer-redeem/index.ts';
const CONTRACT = 'supabase/functions/kplus-offer-redeem/offerCodeContract.ts';
const CLIENT = 'services/kplus/kplusOfferRedemptionClient.ts';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadClient({ session, response, refresh = async () => {} }) {
  const calls = { invoke: [], refresh: 0 };
  const model = runModule('services/kplus/kplusOfferRedemption.ts', {}, { jsx: false });
  const client = runModule(CLIENT, {
    '../authenticatedFunctionSession': {
      resolveAuthenticatedFunctionSession: async () => session,
    },
    '../supabaseClient': {
      supabase: {
        functions: {
          invoke: async (...args) => {
            calls.invoke.push(args);
            return response;
          },
        },
      },
    },
    './kplusEntitlementStore': {
      refreshKPlusEntitlement: async () => {
        calls.refresh += 1;
        await refresh();
      },
    },
    './kplusOfferRedemption': model,
  }, { jsx: false });
  return { client, calls };
}

test('client submits only code with the resolved bearer token', async () => {
  const { client, calls } = loadClient({
    session: { ok: true, accessToken: 'verified-token' },
    response: { data: { result: 'INVALID' }, error: null },
  });
  assert.equal(await client.redeemKPlusOfferCode('CODE-1'), 'INVALID');
  assert.deepEqual(calls.invoke, [[
    'kplus-offer-redeem',
    { body: { code: 'CODE-1' }, headers: { Authorization: 'Bearer verified-token' } },
  ]]);
  assert.equal(calls.refresh, 0);
});

test('anonymous/signed-out client state cannot invoke redemption', async () => {
  const { client, calls } = loadClient({
    session: { ok: false, reason: 'signed_out' },
    response: { data: null, error: null },
  });
  assert.equal(await client.redeemKPlusOfferCode('CODE-1'), 'UNAVAILABLE');
  assert.equal(calls.invoke.length, 0);
});

test('SUCCESS waits for canonical refresh and never writes K+ directly', async () => {
  let refreshFinished = false;
  const { client, calls } = loadClient({
    session: { ok: true, accessToken: 'verified-token' },
    response: {
      data: { result: 'SUCCESS', entitlementRefreshRequired: true },
      error: null,
    },
    refresh: async () => { refreshFinished = true; },
  });
  assert.equal(await client.redeemKPlusOfferCode('CODE-1'), 'SUCCESS');
  assert.equal(refreshFinished, true);
  assert.equal(calls.refresh, 1);
  assert.doesNotMatch(read(CLIENT), /setKPlus|grantEntitlement|isKPlus\s*=|\.activate\(/);
});

test('unknown server answers fail closed', async () => {
  const { client } = loadClient({
    session: { ok: true, accessToken: 'verified-token' },
    response: { data: { result: 'VIP_CAMPAIGN' }, error: null },
  });
  assert.equal(await client.redeemKPlusOfferCode('CODE-1'), 'ERROR');
});

test('OC-NC security contract is server-authoritative and race-safe', () => {
  const migration = read(MIGRATION);
  const edge = read(EDGE);
  const contract = read(CONTRACT);

  assert.match(contract, /HMAC/);
  assert.match(contract, /SHA-256/);
  assert.match(edge, /KPLUS_OFFER_CODE_HMAC_SECRET_ENV/);
  assert.match(edge, /p_actor_id:\s*user\.id/);
  assert.doesNotMatch(edge, /console\.(?:log|error).*code/i);
  assert.doesNotMatch(edge, /logEvent\([^\n]*code/i);
  assert.match(edge, /Object\.keys\(input\)\.length !== 1/);

  assert.match(migration, /code_digest\s+text not null unique/i);
  assert.doesNotMatch(migration, /raw_code|plaintext_code/i);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('kplus_offer_actor:/i);
  assert.match(migration, /for update;/i);
  assert.match(migration, /unique \(actor_id, offer_code_id\)/i);
  assert.match(migration, /max_redemptions_per_actor/i);
  assert.match(migration, /max_global_redemptions/i);
  assert.match(migration, /grant_kplus_complimentary/i);
  assert.match(migration, /p_source => 'complimentary_code'/i);
  assert.match(migration, /action_type = 'store_native'/i);
  assert.match(migration, /store_path_unconfigured/i);
  assert.match(migration, /revoke all on function public\.redeem_kplus_offer_code/i);
  assert.match(migration, /grant execute on function public\.redeem_kplus_offer_code\(uuid, text\) to service_role/i);
});

test('OC-NC required offer outcomes are represented by the atomic boundary', () => {
  const source = read(MIGRATION);
  for (const marker of [
    'inactive_offer',
    'offer_expired',
    'idempotent_replay',
    'code_limit_reached',
    'offer_limit_reached',
    'actor_offer_limit_reached',
    'actor_minute_rate_limit',
    'actor_hour_rate_limit',
    'store_path_unconfigured',
  ]) {
    assert.match(source, new RegExp(marker), marker);
  }
});

test('OC-NC-01: the client contains no valid-code allowlist or grant policy', () => {
  const withoutComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const client = withoutComments(read(CLIENT));
  const presentation = withoutComments(read('services/kplus/kplusOfferRedemption.ts'));
  assert.doesNotMatch(client, /validCodes|promoCodes|allowlist|switch\s*\(\s*code/i);
  assert.doesNotMatch(presentation, /validCodes|promoCodes|allowlist|switch\s*\(\s*code/i);
  assert.match(client, /body:\s*\{ code \}/);
});

test('OC-NC-02/12/13: success cannot mutate K+ and must use canonical refresh', () => {
  const source = read(CLIENT);
  assert.match(source, /await refreshKPlusEntitlement\(\)/);
  assert.doesNotMatch(source, /setKPlus|grantEntitlement|isKPlus\s*=|writeEntitlement|AsyncStorage/);
  assert.match(source, /entitlementRefreshRequired === true/);
});

test('OC-NC-03: request-body actor substitution is rejected and ignored', () => {
  const edge = read(EDGE);
  assert.match(edge, /Object\.keys\(input\)\.length !== 1/);
  assert.match(edge, /p_actor_id:\s*user\.id/);
  assert.doesNotMatch(edge, /p_actor_id:\s*(?:body|input|payload)/);
});

test('OC-NC-04/05: expired and inactive offers fail before any grant', () => {
  const migration = read(MIGRATION);
  const inactive = migration.indexOf("'INVALID', 'inactive_offer'");
  const expired = migration.indexOf("'EXPIRED', 'offer_expired'");
  const grant = migration.indexOf('grant_kplus_complimentary');
  assert.ok(inactive > 0 && inactive < grant);
  assert.ok(expired > 0 && expired < grant);
});

test('OC-NC-06/07: single-use and concurrent redemption are serialized', () => {
  const migration = read(MIGRATION);
  assert.match(migration, /code_digest\s+text not null unique/i);
  assert.match(migration, /for update;/i);
  assert.match(migration, /unique \(actor_id, offer_code_id\)/i);
  assert.match(migration, /where r\.offer_code_id = v_code\.id[\s\S]*?v_code\.max_redemptions/i);
});

test('OC-NC-08/09: actor and global limits are checked under transaction locks', () => {
  const migration = read(MIGRATION);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('kplus_offer_actor:/i);
  assert.match(migration, /where o\.id = v_code\.offer_id\s+for update;/i);
  assert.match(migration, /v_offer\.max_redemptions_per_actor/i);
  assert.match(migration, /v_offer\.max_global_redemptions/i);
});

test('OC-NC-10: raw codes cannot enter the ledger or logs', () => {
  const migration = read(MIGRATION);
  const edge = read(EDGE);
  assert.doesNotMatch(migration, /\braw_code\b|\bplaintext_code\b/i);
  assert.doesNotMatch(edge, /logEvent\([\s\S]{0,220}\bcode\b\s*:/i);
  assert.match(migration, /code_digest\s+text not null/i);
});

test('OC-NC-11: missing secret configuration fails closed', () => {
  const edge = read(EDGE);
  const contract = read(CONTRACT);
  assert.match(contract, /if \(!value\) throw/);
  assert.match(edge, /catch \{[\s\S]*?return json\(\{ result: 'UNAVAILABLE' \}\)/);
});

test('OC-NC-14: store-native offers cannot bypass store billing', () => {
  const migration = read(MIGRATION);
  const storeBranch = migration.slice(
    migration.indexOf("if v_offer.action_type = 'store_native'"),
    migration.indexOf('select public.grant_kplus_complimentary'),
  );
  assert.match(storeBranch, /store_path_unconfigured/);
  assert.match(storeBranch, /return jsonb_build_object\('result', 'UNAVAILABLE'\)/);
  assert.doesNotMatch(storeBranch, /grant_kplus_complimentary|apply_kplus_provider_transition/);
});

test('OC-NC-15: anonymous actors are rejected before code lookup', () => {
  const migration = read(MIGRATION);
  const actorCheck = migration.indexOf('coalesce(v_is_anonymous, false)');
  const codeLookup = migration.indexOf('from public.kplus_offer_codes c');
  assert.ok(actorCheck > 0 && actorCheck < codeLookup);
  assert.match(read(EDGE), /isEligibleAccountActor\(user\)/);
});
