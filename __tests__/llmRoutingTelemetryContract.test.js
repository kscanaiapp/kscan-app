const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260722030000_create_llm_routing_events.sql'),
  'utf8',
);
const PRIVILEGE_MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260722033000_limit_llm_routing_event_privileges.sql'),
  'utf8',
);
const SCAN = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/scan-identify/index.ts'),
  'utf8',
);
const ELISE = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts'),
  'utf8',
);

const REQUIRED_FIELDS = [
  'request_id',
  'surface',
  'primary_model',
  'served_model',
  'fallback_used',
  'fallback_reason',
  'attempt_count',
  'latency_ms',
  'provider_status',
  'response_valid',
  'quota_status',
  'signature_style_included',
];

test('routing ledger is service-role-only categorical telemetry', () => {
  assert.ok(MIGRATION.includes('create table if not exists public.llm_routing_events'));
  for (const field of REQUIRED_FIELDS) assert.match(MIGRATION, new RegExp(`\\b${field}\\b`));
  assert.ok(MIGRATION.includes('alter table public.llm_routing_events enable row level security'));
  assert.match(
    MIGRATION,
    /revoke all on table public\.llm_routing_events from public, anon, authenticated/,
  );
  assert.match(
    MIGRATION,
    /grant select, insert on table public\.llm_routing_events to service_role/,
  );
  assert.equal(
    /^\s+(user_id|prompt|message|image|audio|provider_response)\s+/m.test(MIGRATION),
    false,
    'The telemetry table must not have identity or content columns',
  );
  assert.match(
    PRIVILEGE_MIGRATION,
    /revoke all on table public\.llm_routing_events from service_role/,
  );
  assert.match(
    PRIVILEGE_MIGRATION,
    /grant select, insert on table public\.llm_routing_events to service_role/,
  );
  assert.equal(
    /grant\s+(update|delete)|grant\s+[^;]*,\s*(update|delete)/i.test(PRIVILEGE_MIGRATION),
    false,
  );
});

test('Scanner and TextScan persist bounded routing metadata only', () => {
  assert.ok(SCAN.includes(".from('llm_routing_events')"));
  assert.ok(SCAN.includes("surface: fields.request_mode === 'text' ? 'textscan' : 'scanner'"));
  assert.ok(SCAN.includes('quota_status: fields.quota_status'));
  assert.ok(SCAN.includes('signature_style_included: null'));
  assert.ok(SCAN.includes('await recordRoutingTelemetry({'));
  assert.ok(SCAN.includes('safeRoutingRequestId'));
  assert.match(SCAN, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{7,159\}\$/);

  const insert = SCAN.match(/\.from\('llm_routing_events'\)[\s\S]*?\.insert\(\{([\s\S]*?)\}\)/)?.[1] || '';
  assert.ok(insert.length > 0);
  assert.equal(/textQuery|imageBase64|userId|message|prompt|providerResult/.test(insert), false);
});

test('Elise persists final routing outcome without message or identity content', () => {
  assert.ok(ELISE.includes(".from('llm_routing_events')"));
  assert.ok(ELISE.includes("surface: 'elise'"));
  assert.ok(ELISE.includes('signature_style_included: Boolean(signatureStyleContext)'));
  assert.ok(ELISE.includes('await recordRoutingTelemetry()'));

  const insert = ELISE.match(/\.from\('llm_routing_events'\)[\s\S]*?\.insert\(\{([\s\S]*?)\}\)/)?.[1] || '';
  assert.ok(insert.length > 0);
  assert.equal(/userId|message|assistantText|historyMessages|prompt|providerBody/.test(insert), false);
  assert.ok(
    ELISE.indexOf('await recordRoutingTelemetry();', ELISE.indexOf('empty_final_text_fallback')) >
      ELISE.indexOf('empty_final_text_fallback'),
    'Final telemetry must be recorded after the empty-response safety net',
  );
});
