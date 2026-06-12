/**
 * K Scan AI — Supabase release gate (env + connectivity + RPC smoke).
 *
 * Run: npm run verify:supabase
 *
 * Design goals:
 * - Do not blame "bad URL" when PostgREST returns 401 for a probe that omits Authorization.
 * - Use Auth `/health` as primary reachability (matches hosted Supabase).
 * - Classify RPC unauthenticated responses as PASS when 401/403 (expected).
 * - Emit a final PASS / WARN / BLOCKER summary for physical-device readiness.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyRestV1RootResponse,
  classifyEnsurePrivacySettingsUnauthenticated,
  classifySchemaObjectProbe,
  classifyEdgeOptionsProbe,
} = require('./verify-supabase-helpers');

const REQUIRED_VARS = [
  ['EXPO_PUBLIC_SUPABASE_URL', 'Supabase project URL (e.g. https://xxx.supabase.co)'],
  ['EXPO_PUBLIC_SUPABASE_ANON_KEY', 'Supabase anon/public key'],
];

const OPTIONAL_VARS = [
  ['EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN', 'DEV-ONLY token override (not needed for normal auth)'],
];

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function extractProjectRefFromUrl(url) {
  const match = String(url || '').match(/^https:\/\/([a-z0-9-]+)\.supabase\.co$/i);
  return match ? match[1] : null;
}

function readLinkedProjectRef() {
  try {
    const tempDir = path.join(__dirname, '..', 'supabase', '.temp');
    const explicitRefPath = path.join(tempDir, 'project-ref');
    if (fs.existsSync(explicitRefPath)) {
      return fs.readFileSync(explicitRefPath, 'utf8').trim() || null;
    }

    const linkedProjectPath = path.join(tempDir, 'linked-project.json');
    if (fs.existsSync(linkedProjectPath)) {
      const parsed = JSON.parse(fs.readFileSync(linkedProjectPath, 'utf8'));
      return typeof parsed?.ref === 'string' ? parsed.ref.trim() || null : null;
    }
  } catch {
    return null;
  }

  return null;
}

console.log('\n── K Scan AI — Supabase verification ───────────────────────────────────\n');

/** @type {Array<{ code: 'PASS' | 'WARN' | 'BLOCKER' | 'INFO'; msg: string }>} */
const gate = [];

let allPresent = true;

for (const [key, description] of REQUIRED_VARS) {
  const val = process.env[key];
  if (!val) {
    console.error(`  ✗ ${key} — MISSING`);
    console.error(`    ${description}`);
    allPresent = false;
  } else {
    const masked = val.length > 12 ? val.slice(0, 8) + '...' + val.slice(-4) : '***';
    console.log(`  ✓ ${key} = ${masked}`);
  }
}

for (const [key, description] of OPTIONAL_VARS) {
  const val = process.env[key];
  if (val) {
    const masked = val.length > 12 ? val.slice(0, 8) + '...' + val.slice(-4) : '***';
    console.warn(`  ! ${key} = ${masked}  (DEV token override is active)`);
  } else {
    console.log(`  – ${key} = not set  (${description})`);
  }
}

if (!allPresent) {
  console.error('\n✗ BLOCKER: Required Supabase env vars are missing.\n');
  process.exit(1);
}

gate.push({ code: 'PASS', msg: 'Required EXPO_PUBLIC_SUPABASE_* env vars present' });

const url = normalizeBaseUrl(process.env.EXPO_PUBLIC_SUPABASE_URL);
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const envProjectRef = extractProjectRefFromUrl(url);
const linkedProjectRef = readLinkedProjectRef();

console.log('\n── Project targeting ─────────────────────────────────────────────\n');
if (envProjectRef) {
  console.log(`  Runtime Supabase project ref: ${envProjectRef}`);
}
if (linkedProjectRef) {
  console.log(`  Local CLI linked project ref: ${linkedProjectRef}`);
}
if (envProjectRef && linkedProjectRef && envProjectRef !== linkedProjectRef) {
  const mismatchMessage =
    `CLI link mismatch: app runtime uses ${envProjectRef}, but supabase/.temp is linked to ${linkedProjectRef}. ` +
    'Migration list / db push may be targeting the wrong project.';
  console.error(`  ✗ BLOCKER: ${mismatchMessage}`);
  gate.push({ code: 'BLOCKER', msg: mismatchMessage });
} else if (envProjectRef && linkedProjectRef) {
  gate.push({ code: 'PASS', msg: `CLI link matches runtime project ref ${envProjectRef}` });
}

console.log('\n── Reachability (Auth API) ─────────────────────────────────────────────\n');

async function checkAuthHealth() {
  const res = await fetch(`${url}/auth/v1/health`, {
    headers: { Accept: 'application/json', apikey: anonKey },
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 120) };
}

async function checkRestRoot(apikeyOnly) {
  const headers = apikeyOnly
    ? { apikey: anonKey, Accept: 'application/json' }
    : {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: 'application/json',
      };
  const res = await fetch(`${url}/rest/v1/`, { headers });
  return { status: res.status, hadAuthorizationBearer: !apikeyOnly };
}

async function checkRpcEnsurePrivacySettingsNoUserJwt() {
  const res = await fetch(`${url}/rest/v1/rpc/ensure_privacy_settings`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Intentionally no Authorization — proves RPC is not callable without a session
    },
    body: '{}',
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 200) };
}

async function checkRestObject(path) {
  const res = await fetch(`${url}${path}`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 200) };
}

async function checkEdgeOptions(functionName) {
  const res = await fetch(`${url}/functions/v1/${functionName}`, {
    method: 'OPTIONS',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
  });
  return { status: res.status };
}

function pushGateFromLevel(level, msg, { elevateInfoToPass = false } = {}) {
  if (level === 'PASS' || (level === 'INFO' && elevateInfoToPass)) {
    gate.push({ code: 'PASS', msg });
  } else if (level === 'INFO') {
    console.log(`  ℹ ${msg}`);
  } else if (level === 'WARN') {
    gate.push({ code: 'WARN', msg });
    console.warn(`  ⚠ ${msg}`);
  } else if (level === 'BLOCKER') {
    gate.push({ code: 'BLOCKER', msg });
    console.error(`  ✗ BLOCKER: ${msg}`);
  }
}

(async () => {
  try {
    const authHealth = await checkAuthHealth();
    if (authHealth.status >= 200 && authHealth.status < 300) {
      console.log(`  ✓ Auth API reachable (GET /auth/v1/health → HTTP ${authHealth.status})`);
      gate.push({ code: 'PASS', msg: `Auth /health HTTP ${authHealth.status}` });
    } else {
      console.warn(`  ⚠ Auth /health returned HTTP ${authHealth.status}`);
      gate.push({
        code: 'WARN',
        msg: `Auth /health HTTP ${authHealth.status} — confirm URL; fallback relies on PostgREST.`,
      });
    }
  } catch (err) {
    console.error(`  ✗ Cannot reach Auth API: ${err.message}`);
    gate.push({ code: 'BLOCKER', msg: `Auth reachability: ${err.message}` });
    printSummary(gate);
    process.exit(1);
  }

  try {
    const apikeyOnly = await checkRestRoot(true);
    const cApikey = classifyRestV1RootResponse(apikeyOnly.status, {
      hadAuthorizationBearer: apikeyOnly.hadAuthorizationBearer,
    });
    console.log('\n── PostgREST probes ────────────────────────────────────────────────────\n');
    console.log(`  GET /rest/v1/ (apikey only) → HTTP ${apikeyOnly.status}`);
    console.log(`      → ${cApikey.detail}`);
    pushGateFromLevel(cApikey.level, `REST root apikey-only: ${cApikey.detail}`, {
      elevateInfoToPass: true,
    });

    console.log('\n── RPC: ensure_privacy_settings (no user JWT) ─────────────────────────\n');

    let rpcStatus = -1;
    let rpcClass = { level: 'WARN', detail: 'RPC not executed' };
    try {
      const rpc = await checkRpcEnsurePrivacySettingsNoUserJwt();
      rpcStatus = rpc.status;
      rpcClass = classifyEnsurePrivacySettingsUnauthenticated(rpc.status);
      console.log(`  POST /rest/v1/rpc/ensure_privacy_settings (no Authorization) → HTTP ${rpc.status}`);
      if (rpc.body && rpc.status !== 200) console.log(`      body preview: ${rpc.body.replace(/\s+/g, ' ')}`);
      console.log(`      → ${rpcClass.detail}`);
      pushGateFromLevel(rpcClass.level, rpcClass.detail);
    } catch (err) {
      console.error(`  ✗ RPC check failed: ${err.message}`);
      gate.push({ code: 'BLOCKER', msg: `RPC probe: ${err.message}` });
    }

    const withBearer = await checkRestRoot(false);
    let cBear = classifyRestV1RootResponse(withBearer.status, {
      hadAuthorizationBearer: withBearer.hadAuthorizationBearer,
    });

    // Hosted Supabase often returns 401 for anonymous GET /rest/v1/ even when the project is healthy.
    // If Auth /health works and the RPC rejects unauthenticated callers as expected, do not WARN on this probe.
    const rpcProvesRestReachable =
      rpcStatus === 401 || rpcStatus === 403;
    if (rpcProvesRestReachable && withBearer.status === 401) {
      cBear = {
        level: 'INFO',
        detail:
          'HTTP 401 on GET /rest/v1/ with anon JWT — common on hosted Supabase (root browse restricted). PostgREST is reachable (RPC probe succeeded). Signed-in clients use the user access token, not this probe.',
      };
    }

    console.log(`  GET /rest/v1/ (apikey + Authorization Bearer anon) → HTTP ${withBearer.status}`);
    console.log(`      → ${cBear.detail}`);
    if (cBear.level === 'PASS') {
      gate.push({ code: 'PASS', msg: 'PostgREST root reachable with standard anon Bearer headers' });
    } else if (cBear.level === 'WARN') {
      gate.push({ code: 'WARN', msg: cBear.detail });
    } else if (cBear.level === 'INFO') {
      gate.push({
        code: 'PASS',
        msg: 'PostgREST reachable (REST root anon GET may be restricted; RPC auth gate verified)',
      });
    }
  } catch (err) {
    console.error(`  ✗ PostgREST probe failed: ${err.message}`);
    gate.push({ code: 'BLOCKER', msg: `PostgREST: ${err.message}` });
    printSummary(gate);
    process.exit(1);
  }

  console.log('\n── Schema parity ───────────────────────────────────────────────────────\n');
  console.log('  Live PostgREST probes use the anon JWT. RLS may hide rows, but missing tables/columns return 404.');

  const schemaProbes = [
    {
      label: 'public.profiles privacy columns',
      path: '/rest/v1/profiles?select=id,account_status,age_group,deletion_requested_at,account_locked_at&limit=1',
      required: true,
      migration: '202605130000_profiles_privacy_status.sql',
    },
    {
      label: 'public.privacy_settings account-sync columns',
      path: '/rest/v1/privacy_settings?select=user_id,opt_out_of_sale,limit_sensitive_processing,gdpr_consent_given,gdpr_consent_timestamp,gdpr_consent_version,consent_version,last_request_source,last_processed_at,updated_at&limit=1',
      required: true,
      migration: '202605130001_privacy_settings.sql / 202605130002_privacy_settings_schema_parity.sql',
    },
    {
      label: 'public.deletion_requests',
      path: '/rest/v1/deletion_requests?select=id&limit=1',
      required: false,
      migration: '202605130003_deletion_requests.sql',
    },
    {
      label: 'public.privacy_export_requests',
      path: '/rest/v1/privacy_export_requests?select=id&limit=1',
      required: false,
      migration: '202605130004_privacy_requests_extensible.sql',
    },
    {
      label: 'public.privacy_correction_requests',
      path: '/rest/v1/privacy_correction_requests?select=id&limit=1',
      required: false,
      migration: '202605130004_privacy_requests_extensible.sql',
    },
    {
      label: 'public.dressing_room_item_reactions',
      path: '/rest/v1/dressing_room_item_reactions?select=item_id,reaction_type&limit=1',
      required: true,
      migration: '202606050001_dressing_room_item_reactions.sql',
    },
  ];

  for (const probe of schemaProbes) {
    try {
      const res = await checkRestObject(probe.path);
      const classification = classifySchemaObjectProbe(res.status, {
        label: probe.label,
        required: probe.required,
      });
      console.log(`  ${probe.label} (${probe.migration}) → HTTP ${res.status}`);
      console.log(`      → ${classification.detail}`);
      pushGateFromLevel(classification.level, classification.detail);
      if ((res.status === 400 || res.status === 404) && res.body) {
        console.log(`      body preview: ${res.body.replace(/\s+/g, ' ')}`);
      }
    } catch (err) {
      const msg = `${probe.label} probe failed: ${err.message}`;
      if (probe.required) {
        gate.push({ code: 'BLOCKER', msg });
        console.error(`  ✗ BLOCKER: ${msg}`);
      } else {
        gate.push({ code: 'WARN', msg });
        console.warn(`  ⚠ ${msg}`);
      }
    }
  }

  console.log('\n── Reaction RPC parity ───────────────────────────────────────────\n');
  try {
    const res = await fetch(`${url}/rest/v1/rpc/get_item_reaction_counts`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        p_item_ids: ['00000000-0000-0000-0000-000000000000'],
      }),
    });
    const body = await res.text();
    console.log(`  public.get_item_reaction_counts(uuid[]) → HTTP ${res.status}`);
    if (body && res.status !== 200) {
      console.log(`      body preview: ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
    if (res.status >= 200 && res.status < 300) {
      gate.push({ code: 'PASS', msg: 'Reaction count RPC is deployed and callable via PostgREST.' });
    } else if (res.status === 404) {
      gate.push({
        code: 'BLOCKER',
        msg: 'Reaction count RPC is missing from the runtime project. Apply 202606050001 and 202606060001 to the actual app project.',
      });
    } else {
      gate.push({
        code: 'WARN',
        msg: `Reaction count RPC returned HTTP ${res.status}. Inspect response body and runtime project schema.`,
      });
    }
  } catch (err) {
    gate.push({
      code: 'BLOCKER',
      msg: `Reaction count RPC probe failed: ${err.message}`,
    });
    console.error(`  ✗ BLOCKER: Reaction count RPC probe failed: ${err.message}`);
  }

  console.log('\n── Edge Function deployment probes ────────────────────────────────────\n');
  console.log('  OPTIONS probes avoid creating privacy requests. 404 means the function is not deployed at the expected path.');
  for (const functionName of [
    'handle-user-deletion',
    'privacy-data-export',
    'privacy-correction-request',
  ]) {
    try {
      const res = await checkEdgeOptions(functionName);
      const classification = classifyEdgeOptionsProbe(res.status, {
        label: functionName,
        required: false,
      });
      console.log(`  ${functionName} → HTTP ${res.status}`);
      console.log(`      → ${classification.detail}`);
      pushGateFromLevel(classification.level, classification.detail);
    } catch (err) {
      const msg = `${functionName} Edge Function probe failed: ${err.message}`;
      gate.push({ code: 'WARN', msg });
      console.warn(`  ⚠ ${msg}`);
    }
  }

  console.log('\n── Release gate summary ────────────────────────────────────────────────\n');
  printSummary(gate);

  const worst = worstCode(gate);
  if (worst === 'BLOCKER') process.exit(1);

  console.log('\n── Manual QA checklist (auth + privacy) ────────────────────────────────\n');
  console.log('  1. Expo: npm start');
  console.log('  2. Privacy → sign in with a test user');
  console.log('  3. Toggle “Do Not Sell or Share” ON → verify row in privacy_settings');
  console.log('  4. Restart app → preference reloads from Supabase');
  console.log('  5. Edge Functions: confirm deployment before treating export/delete/correction as live\n');

  process.exit(0);
})();

function worstCode(entries) {
  if (entries.some((e) => e.code === 'BLOCKER')) return 'BLOCKER';
  if (entries.some((e) => e.code === 'WARN')) return 'WARN';
  return 'PASS';
}

function printSummary(entries) {
  const worst = worstCode(entries);
  const label =
    worst === 'BLOCKER' ? 'BLOCKER' : worst === 'WARN' ? 'WARN (review items above)' : 'PASS';
  console.log(`  Overall: ${label}`);
  const counts = { PASS: 0, WARN: 0, BLOCKER: 0, INFO: 0 };
  for (const e of entries) counts[e.code] = (counts[e.code] || 0) + 1;
  console.log(`  Counts: PASS=${counts.PASS} WARN=${counts.WARN} BLOCKER=${counts.BLOCKER}`);
}
