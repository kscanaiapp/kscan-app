'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kplus-activate/index.ts'), 'utf8');

test('SEC-B35-KPLUS-001 server-side Early Access campaign hold precedes all grants and provider calls', () => {
  const guard = source.indexOf("Deno.env.get('KPLUS_EARLY_ACCESS_ENABLED') !== 'true'");
  const certification = source.indexOf("Deno.env.get('KPLUS_EARLY_ACCESS_CAMPAIGN_ELIGIBILITY_CERTIFIED') !== 'true'");
  const denial = source.indexOf("code: 'CAMPAIGN_CLOSED'");
  const grant = source.indexOf("rpc('grant_kplus_early_access'");
  const mirror = source.indexOf('syncPromotionalEntitlement({');
  assert.ok(guard >= 0 && guard < grant, 'default-closed campaign guard before grant RPC');
  assert.ok(certification > guard && certification < grant, 'independent certification guard before grant RPC');
  assert.ok(denial > certification && denial < grant, '403 denial before any entitlement write');
  assert.ok(mirror > grant, 'no provider mirror reachable before grant authorization');
  assert.match(source.slice(guard, grant), /CAMPAIGN_CLOSED[^]*403/);
});
