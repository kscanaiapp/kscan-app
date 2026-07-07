#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const REPO_ROOT = path.resolve(__dirname, '..');
const QA_DIR = path.join(REPO_ROOT, 'qa');
const OPERATOR_SCRIPT = path.join(REPO_ROOT, 'scripts', 'process-deletion-request.js');
const APPROVED_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const APPROVED_URL_FRAGMENT = APPROVED_PROJECT_REF;
const DRIVER_MARKER = 'kscan-delete-e2e-driver-v1';
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const OWNER_EMAIL_RE = /^kscan-delete-e2e-owner-[a-zA-Z0-9_-]+@example\.com$/;
const PARTICIPANT_EMAIL_RE = /^kscan-delete-e2e-participant-[a-zA-Z0-9_-]+@example\.com$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUIRED_ENV = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'KSCAN_DELETE_E2E_PROJECT_REF',
  'KSCAN_DELETE_E2E_ALLOW_PRODUCTION_DISPOSABLE',
];

const CHECK_TABLES = [
  { table: 'profiles', column: 'id', label: 'owner profile' },
  { table: 'privacy_settings', column: 'user_id', label: 'owner privacy settings' },
  { table: 'legal_acceptances', column: 'user_id', label: 'owner legal acceptances' },
  { table: 'saved_scans', column: 'user_id', label: 'owner saved scans' },
  { table: 'scan_identify_usage_daily', column: 'user_id', label: 'owner scan quota rows' },
  { table: 'dressing_rooms', column: 'user_id', label: 'owner dressing rooms' },
  { table: 'dressing_room_participants', column: 'user_id', label: 'owner dressing room participant rows' },
  { table: 'dressing_room_messages', column: 'sender_id', label: 'owner authored messages' },
  { table: 'room_shares', column: 'owner_id', label: 'owner room shares' },
  { table: 'looks', column: 'user_id', label: 'owner looks' },
  { table: 'inspiration_items', column: 'user_id', label: 'owner inspiration items' },
  { table: 'style_chat_sessions', column: 'user_id', label: 'owner style chat sessions' },
  { table: 'style_chat_messages', column: 'user_id', label: 'owner style chat messages' },
  { table: 'style_memory_events', column: 'user_id', label: 'owner style memory events' },
  { table: 'style_chat_usage', column: 'user_id', label: 'owner style chat usage' },
  { table: 'style_chat_daily_usage', column: 'user_id', label: 'owner style chat daily usage' },
  { table: 'deletion_requests', column: 'user_id', label: 'owner deletion requests' },
  { table: 'wardrobe_utility_items', column: 'user_id', optional: true },
  { table: 'wardrobe_collections', column: 'user_id', optional: true },
  { table: 'wardrobe_collection_items', column: 'user_id', optional: true },
  { table: 'wardrobe_brand_sizing_notes', column: 'user_id', optional: true },
  { table: 'wardrobe_outfit_feedback', column: 'user_id', optional: true },
  { table: 'wardrobe_care_notes', column: 'user_id', optional: true },
  { table: 'wardrobe_wishlist_intents', column: 'user_id', optional: true },
  { table: 'wardrobe_wear_events', column: 'user_id', optional: true },
  { table: 'wardrobe_activity_log', column: 'user_id', optional: true },
];

const OPTIONAL_SEEDS = [
  {
    table: 'wardrobe_utility_items',
    payload: (state) => ({
      user_id: state.owner.id,
      client_id: `delete-e2e-${state.runId}-utility`,
      source_item_id: `delete-e2e-${state.runId}-source`,
      source_type: 'scan',
      title: 'Delete E2E Utility Item',
      metadata: { e2e: true },
    }),
  },
  {
    table: 'wardrobe_brand_sizing_notes',
    payload: (state) => ({
      user_id: state.owner.id,
      client_id: `delete-e2e-${state.runId}-sizing`,
      brand: 'Delete E2E Atelier',
      usual_size: 'M',
      fit_note: 'Disposable delete E2E row.',
      metadata: { e2e: true },
    }),
  },
  {
    table: 'wardrobe_care_notes',
    payload: (state) => ({
      user_id: state.owner.id,
      client_id: `delete-e2e-${state.runId}-care`,
      source_item_id: `delete-e2e-${state.runId}-source`,
      note: 'Disposable delete E2E care note.',
      metadata: { e2e: true },
    }),
  },
  {
    table: 'wardrobe_outfit_feedback',
    payload: (state) => ({
      user_id: state.owner.id,
      client_id: `delete-e2e-${state.runId}-feedback`,
      target_id: `delete-e2e-${state.runId}-outfit`,
      target_type: 'outfit',
      rating: 5,
      note: 'Disposable delete E2E feedback.',
      metadata: { e2e: true },
    }),
  },
  {
    table: 'wardrobe_wishlist_intents',
    payload: (state) => ({
      user_id: state.owner.id,
      client_id: `delete-e2e-${state.runId}-wishlist`,
      source_item_id: `delete-e2e-${state.runId}-source`,
      intent: 'save_for_later',
      title_snapshot: 'Delete E2E wishlist item',
      metadata: { e2e: true },
    }),
  },
];

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

function printHelp() {
  console.log(`K Scan disposable delete E2E driver

Usage:
  node qa/e2e-delete-driver.js --help
  node qa/e2e-delete-driver.js --self-test
  node --env-file=.env.e2e qa/e2e-delete-driver.js --dry-run
  node --env-file=.env.e2e qa/e2e-delete-driver.js --confirm-delete [--verify]

Safety:
  --help and --self-test touch nothing.
  --dry-run creates only new disposable @example.com users, seeds disposable rows,
    submits handle-user-deletion as the owner, runs the operator dry-run, and
    writes guarded state under qa/delete-e2e-*.
  --confirm-delete never accepts user IDs or emails. It reloads the guarded state,
    reruns the operator dry-run, revalidates identity gates, and then invokes
    scripts/process-deletion-request.js --confirm-delete.
`);
}

function parseArgs(argv) {
  const options = {
    help: false,
    selfTest: false,
    dryRun: false,
    confirmDelete: false,
    verify: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--self-test':
        options.selfTest = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--confirm-delete':
        options.confirmDelete = true;
        break;
      case '--verify':
        options.verify = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const modes = [options.help, options.selfTest, options.dryRun, options.confirmDelete].filter(Boolean);
  if (modes.length > 1) {
    throw new Error('Choose exactly one mode: --help, --self-test, --dry-run, or --confirm-delete');
  }
  if (options.verify && !options.confirmDelete) {
    throw new Error('--verify is only valid with --confirm-delete');
  }
  return options;
}

function shortId(id) {
  return typeof id === 'string' && id.length > 8 ? `${id.slice(0, 8)}...` : 'unknown';
}

function assertUuid(value, label) {
  if (!UUID_RE.test(String(value))) {
    throw new Error(`${label} is not a UUID`);
  }
}

function isMissingResourceError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    message.includes('does not exist') ||
    message.includes('could not find the table') ||
    message.includes('schema cache') ||
    message.includes('bucket not found')
  );
}

function secretValues() {
  return [
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_DB_URL,
    process.env.DATABASE_URL,
  ].filter((value) => typeof value === 'string' && value.length >= 12);
}

function redactSecrets(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const secret of secretValues()) {
    text = text.split(secret).join('[REDACTED_SECRET]');
  }
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DB_URL]')
    .replace(
      /(SUPABASE_SERVICE_ROLE_KEY|EXPO_PUBLIC_SUPABASE_ANON_KEY|apikey|authorization|password)(\s*[:=]\s*)[^\s"',}]+/gi,
      '$1$2[REDACTED_SECRET]',
    );
}

function assertNoSecretLeak(text, label) {
  const raw = String(text ?? '');
  for (const secret of secretValues()) {
    if (raw.includes(secret)) {
      throw new Error(`${label} contained a configured secret value`);
    }
  }
  if (/postgres(?:ql)?:\/\/[^\s"']+/i.test(raw)) {
    throw new Error(`${label} contained a database connection string`);
  }
}

function log(message) {
  console.log(redactSecrets(message));
}

function requireLocalEnvFile() {
  const envPath = path.join(REPO_ROOT, '.env.e2e');
  if (!fs.existsSync(envPath)) {
    throw new Error('Missing .env.e2e; create it locally from .env.e2e.example before running live E2E');
  }
}

function validateLiveEnvValues(source) {
  const missing = REQUIRED_ENV.filter((name) => !source[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  if (source.KSCAN_DELETE_E2E_PROJECT_REF !== APPROVED_PROJECT_REF) {
    throw new Error(`Project ref must be ${APPROVED_PROJECT_REF}`);
  }
  if (!source.EXPO_PUBLIC_SUPABASE_URL.includes(APPROVED_URL_FRAGMENT)) {
    throw new Error(`Supabase URL must include ${APPROVED_URL_FRAGMENT}`);
  }
  if (source.KSCAN_DELETE_E2E_ALLOW_PRODUCTION_DISPOSABLE !== 'true') {
    throw new Error('KSCAN_DELETE_E2E_ALLOW_PRODUCTION_DISPOSABLE must equal true');
  }

  return {
    url: source.EXPO_PUBLIC_SUPABASE_URL,
    anonKey: source.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: source.SUPABASE_SERVICE_ROLE_KEY,
    projectRef: source.KSCAN_DELETE_E2E_PROJECT_REF,
  };
}

function loadLiveEnv() {
  requireLocalEnvFile();
  return validateLiveEnvValues(process.env);
}

function createClients(env) {
  const auth = { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false };
  return {
    admin: createClient(env.url, env.serviceRoleKey, { auth }),
    anon: createClient(env.url, env.anonKey, { auth }),
  };
}

function runToken() {
  return `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomUUID()}`;
}

function makeRunDir(runId) {
  const runDir = path.join(QA_DIR, `delete-e2e-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function statePathFor(runDir) {
  return path.join(runDir, 'state.json');
}

function latestPath() {
  return path.join(QA_DIR, 'delete-e2e-latest.json');
}

function writeJson(file, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  assertNoSecretLeak(serialized, path.basename(file));
  fs.writeFileSync(file, serialized, 'utf8');
}

function writeText(file, content) {
  const safe = redactSecrets(content);
  assertNoSecretLeak(safe, path.basename(file));
  fs.writeFileSync(file, safe, 'utf8');
}

function persistState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(statePathFor(state.runDirAbs), state);
  writeJson(latestPath(), {
    marker: DRIVER_MARKER,
    runId: state.runId,
    stateFile: path.relative(REPO_ROOT, statePathFor(state.runDirAbs)).replace(/\\/g, '/'),
    updatedAt: state.updatedAt,
  });
}

function loadLatestState() {
  const pointerFile = latestPath();
  if (!fs.existsSync(pointerFile)) {
    throw new Error('No verified delete E2E dry-run state found; run --dry-run first');
  }

  const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  if (pointer.marker !== DRIVER_MARKER || !pointer.stateFile) {
    throw new Error('Latest delete E2E pointer is not a guarded driver state file');
  }

  const resolved = path.resolve(REPO_ROOT, pointer.stateFile);
  const relative = path.relative(QA_DIR, resolved).replace(/\\/g, '/');
  if (relative.startsWith('..') || !relative.startsWith('delete-e2e-')) {
    throw new Error('Delete E2E state file is outside qa/delete-e2e-*');
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('Latest delete E2E state file is missing');
  }

  const state = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  validateStateEnvelope(state);
  state.runDirAbs = path.dirname(resolved);
  return state;
}

function validateStateEnvelope(state) {
  if (state.marker !== DRIVER_MARKER) throw new Error('State marker mismatch');
  if (state.projectRef !== APPROVED_PROJECT_REF) throw new Error('State project ref mismatch');
  if (!state.createdAt || Date.now() - Date.parse(state.createdAt) > STATE_TTL_MS) {
    throw new Error('Dry-run state is stale; run --dry-run again');
  }
  if (!state.dryRunGate?.passed) {
    throw new Error('Confirm-delete requires a passed dry-run gate');
  }
  if (!OWNER_EMAIL_RE.test(state.owner?.email ?? '')) {
    throw new Error('State owner email failed disposable pattern');
  }
  if (!PARTICIPANT_EMAIL_RE.test(state.participant?.email ?? '')) {
    throw new Error('State participant email failed disposable pattern');
  }
  assertUuid(state.owner?.id, 'state owner id');
  assertUuid(state.participant?.id, 'state participant id');
  assertUuid(state.requestId, 'state request id');
  if (state.owner.id === state.participant.id) {
    throw new Error('Owner and participant cannot be the same user');
  }
}

async function requireOk(result, label) {
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  return result.data;
}

async function maybeGetAuthUser(admin, userId) {
  const result = await admin.auth.admin.getUserById(userId);
  if (result.error) return null;
  return result.data?.user ?? null;
}

async function countRows(admin, table, column, value, optional = false) {
  const result = await admin.from(table).select('*', { count: 'exact', head: true }).eq(column, value);
  if (result.error) {
    if (optional && isMissingResourceError(result.error)) {
      return { table, column, count: null, skipped: true };
    }
    throw new Error(`count ${table}: ${result.error.message}`);
  }
  return { table, column, count: result.count ?? 0, skipped: false };
}

async function insertOptional(admin, table, payload) {
  const result = await admin.from(table).insert(payload);
  if (result.error) {
    if (isMissingResourceError(result.error)) {
      return { table, seeded: false, skipped: true };
    }
    throw new Error(`seed ${table}: ${result.error.message}`);
  }
  return { table, seeded: true, skipped: false };
}

async function upsertRequired(admin, table, payload, onConflict) {
  const result = await admin.from(table).upsert(payload, { onConflict });
  await requireOk(result, `upsert ${table}`);
}

async function insertRequired(admin, table, payload, label = table) {
  const result = await admin.from(table).insert(payload).select('id').single();
  return await requireOk(result, `insert ${label}`);
}

async function createDisposableUsers(admin, anon, state) {
  const ownerPassword = crypto.randomBytes(32).toString('base64url');
  const participantPassword = crypto.randomBytes(32).toString('base64url');

  const owner = await admin.auth.admin.createUser({
    email: state.owner.email,
    password: ownerPassword,
    email_confirm: true,
    user_metadata: { kscan_delete_e2e: true, disposable: true, role: 'owner', run_id: state.runId },
  });
  if (owner.error || !owner.data?.user?.id) {
    throw new Error(`create disposable owner: ${owner.error?.message ?? 'missing user id'}`);
  }
  state.owner.id = owner.data.user.id;
  state.owner.partialId = shortId(state.owner.id);
  log(`Created disposable owner ${state.owner.email} (${state.owner.partialId})`);

  const participant = await admin.auth.admin.createUser({
    email: state.participant.email,
    password: participantPassword,
    email_confirm: true,
    user_metadata: {
      kscan_delete_e2e: true,
      disposable: true,
      role: 'participant',
      run_id: state.runId,
    },
  });
  if (participant.error || !participant.data?.user?.id) {
    throw new Error(`create disposable participant: ${participant.error?.message ?? 'missing user id'}`);
  }
  state.participant.id = participant.data.user.id;
  state.participant.partialId = shortId(state.participant.id);
  log(`Created disposable participant ${state.participant.email} (${state.participant.partialId})`);

  const session = await anon.auth.signInWithPassword({
    email: state.owner.email,
    password: ownerPassword,
  });
  if (session.error || !session.data?.session?.access_token) {
    throw new Error(`sign in disposable owner: ${session.error?.message ?? 'missing access token'}`);
  }

  return { ownerAccessToken: session.data.session.access_token };
}

async function seedDisposableData(admin, state) {
  await upsertRequired(
    admin,
    'profiles',
    { id: state.owner.id, email: state.owner.email, account_status: 'active' },
    'id',
  );
  await upsertRequired(
    admin,
    'profiles',
    { id: state.participant.id, email: state.participant.email, account_status: 'active' },
    'id',
  );
  await upsertRequired(admin, 'privacy_settings', { user_id: state.owner.id }, 'user_id');
  await insertRequired(admin, 'saved_scans', {
    user_id: state.owner.id,
    local_id: `delete-e2e-${state.runId}`,
    title: 'Delete E2E Saved Scan',
    scan_type: 'camera',
    analysis_result: { e2e: true },
    products: [],
    metadata: { e2e: true },
  });
  await upsertRequired(
    admin,
    'scan_identify_usage_daily',
    { user_id: state.owner.id, mode: 'image', count: 1 },
    'user_id,usage_date,mode',
  );

  const room = await insertRequired(
    admin,
    'dressing_rooms',
    { user_id: state.owner.id, title: `Delete E2E Room ${state.runId}` },
    'dressing_rooms',
  );
  state.roomId = room.id;
  state.roomPartialId = shortId(room.id);

  await insertOptional(admin, 'dressing_room_participants', {
    dressing_room_id: state.roomId,
    user_id: state.owner.id,
  });
  await insertOptional(admin, 'dressing_room_participants', {
    dressing_room_id: state.roomId,
    user_id: state.participant.id,
  });
  await insertOptional(admin, 'dressing_room_messages', {
    room_id: state.roomId,
    sender_id: state.owner.id,
    body: 'Delete E2E disposable owner message.',
  });

  const optionalSeedResults = [];
  for (const entry of OPTIONAL_SEEDS) {
    optionalSeedResults.push(await insertOptional(admin, entry.table, entry.payload(state)));
  }
  state.optionalSeedResults = optionalSeedResults;

  const storagePath = `${state.owner.id}/scans/delete-e2e-${state.runId}.jpg`;
  const upload = await admin.storage
    .from('style-library-images')
    .upload(storagePath, TINY_JPEG, { contentType: 'image/jpeg', upsert: false });
  if (upload.error) {
    throw new Error(`seed storage style-library-images: ${upload.error.message}`);
  }
  state.storage = {
    bucket: 'style-library-images',
    paths: [storagePath],
    ownerPrefixes: [`${state.owner.id}/scans`, `${state.owner.id}/inspirations`],
  };
  log(`Seeded disposable rows and owner-scoped storage (${state.owner.partialId})`);
}

async function submitDeletionRequest(env, state, ownerAccessToken) {
  const post = async () => {
    const response = await fetch(`${env.url}/functions/v1/handle-user-deletion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerAccessToken}`,
        apikey: env.anonKey,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const text = await response.text();
    assertNoSecretLeak(text, 'handle-user-deletion response');
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparseable: true };
      }
    }
    return { status: response.status, body };
  };

  const first = await post();
  if (first.status !== 200 || first.body?.status !== 'pending' || !first.body?.request_id) {
    throw new Error(`handle-user-deletion did not create a pending request (http ${first.status})`);
  }
  state.requestId = first.body.request_id;
  state.requestedAt = first.body.requested_at;

  const second = await post();
  if (second.status !== 200 || second.body?.status !== 'already_requested') {
    throw new Error(`handle-user-deletion idempotency check failed (http ${second.status})`);
  }
  log(`Submitted deletion request ${state.requestId} for owner ${state.owner.partialId}`);
}

function detectOperatorSupport() {
  if (!fs.existsSync(OPERATOR_SCRIPT)) {
    throw new Error('operator script not found: scripts/process-deletion-request.js');
  }
  const result = spawnSync(process.execPath, [OPERATOR_SCRIPT, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assertNoSecretLeak(output, 'operator help');
  if (result.status !== 0) {
    throw new Error('operator help failed');
  }
  return {
    dryRun: /--dry-run/.test(output) || /\[--dry-run\]/.test(output),
    defaultDryRun: /dry-run by default/i.test(output),
    confirmDelete: /--confirm-delete/.test(output),
    verify: /--verify/.test(output),
    requestId: /--request-id/.test(output),
    outputDir: /--output-dir/.test(output),
    help: output,
  };
}

function requireOperatorCapabilities(support) {
  const missing = [];
  if (!support.requestId) missing.push('--request-id');
  if (!support.confirmDelete) missing.push('--confirm-delete');
  if (!support.outputDir) missing.push('--output-dir');
  if (!support.dryRun && !support.defaultDryRun) missing.push('dry-run/default dry-run');
  if (missing.length > 0) {
    throw new Error(`operator missing required support: ${missing.join(', ')}`);
  }
}

function runOperator(args, env, state, label) {
  const result = spawnSync(process.execPath, [OPERATOR_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      SUPABASE_URL: env.url,
      SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey,
    },
  });

  const output = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  assertNoSecretLeak(output, label);
  const file = path.join(state.runDirAbs, `${label}.txt`);
  writeText(file, output);
  if (result.status !== 0) {
    throw new Error(`${label} failed; redacted output written under ${path.relative(REPO_ROOT, file)}`);
  }

  return { output, file, json: parseJsonFromOutput(output, label) };
}

function parseJsonFromOutput(output, label) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`${label} did not contain parseable JSON`);
  }
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    throw new Error(`${label} JSON parse failed: ${error.message}`);
  }
}

async function fetchDeletionRequest(admin, requestId) {
  const result = await admin
    .from('deletion_requests')
    .select('id,user_id,status,requested_at,request_source')
    .eq('id', requestId)
    .maybeSingle();
  if (result.error) throw new Error(`fetch deletion request: ${result.error.message}`);
  if (!result.data) throw new Error('deletion request not found');
  return result.data;
}

async function validateIdentityGates(admin, state, operatorDryRun) {
  validateStateEnvelope(state);

  const request = await fetchDeletionRequest(admin, state.requestId);
  if (request.user_id !== state.owner.id) {
    throw new Error('Deletion request user ID does not equal disposable owner ID');
  }
  if (request.user_id === state.participant.id) {
    throw new Error('Participant would be deleted');
  }
  if (!['pending', 'processing'].includes(request.status)) {
    throw new Error(`Deletion request is not open (status=${request.status})`);
  }

  const ownerAuth = await maybeGetAuthUser(admin, state.owner.id);
  const participantAuth = await maybeGetAuthUser(admin, state.participant.id);
  if (!ownerAuth) throw new Error('Disposable owner auth user is missing before confirm');
  if (!participantAuth) throw new Error('Disposable participant auth user is missing before confirm');
  if (ownerAuth.email !== state.owner.email || !OWNER_EMAIL_RE.test(ownerAuth.email ?? '')) {
    throw new Error('Owner email failed exact disposable gate');
  }
  if (
    participantAuth.email !== state.participant.email ||
    !PARTICIPANT_EMAIL_RE.test(participantAuth.email ?? '')
  ) {
    throw new Error('Participant email failed exact disposable gate');
  }

  for (const storagePath of state.storage?.paths ?? []) {
    if (!storagePath.startsWith(`${state.owner.id}/`)) {
      throw new Error('Storage path is broader than the disposable owner ID');
    }
  }
  const coverage = operatorDryRun.storageCoverage ?? [];
  if (!Array.isArray(coverage) || coverage.length === 0) {
    throw new Error('Operator dry-run storage coverage is ambiguous');
  }
  for (const entry of coverage) {
    const prefix = String(entry.prefix ?? '');
    if (!prefix.startsWith(`${state.owner.partialId}/`)) {
      throw new Error('Operator dry-run storage prefix is not scoped to owner');
    }
    if (prefix.includes(state.participant.partialId)) {
      throw new Error('Operator dry-run storage prefix references participant');
    }
  }

  const serialized = JSON.stringify(operatorDryRun);
  const domains = [...serialized.matchAll(/@([A-Za-z0-9.-]+)/g)].map((match) => match[1].toLowerCase());
  const nonExampleDomains = domains.filter((domain) => domain !== 'example.com');
  if (nonExampleDomains.length > 0) {
    throw new Error('Operator dry-run output included a non-example.com email domain');
  }
  if (serialized.includes(state.participant.id) || serialized.includes(state.owner.id)) {
    throw new Error('Operator dry-run output contained full user IDs');
  }
  if (operatorDryRun.request?.partialUserId !== state.owner.partialId) {
    throw new Error('Operator dry-run target partial ID did not match owner');
  }
  if (!operatorDryRun.user?.authUserExists) {
    throw new Error('Operator dry-run did not see the owner auth user');
  }

  const selectedRecipients = JSON.stringify(operatorDryRun.sharedRoomCheck ?? {});
  if (!selectedRecipients.includes(state.participant.partialId)) {
    throw new Error('Operator dry-run did not identify the disposable participant for room transfer');
  }

  state.dryRunGate = {
    passed: true,
    checkedAt: new Date().toISOString(),
    requestId: state.requestId,
    targetPartialUserId: state.owner.partialId,
  };
  return state.dryRunGate;
}

function validateConfirmResult(state, result) {
  if (result.status !== 'completed') {
    throw new Error(`operator confirm returned unexpected status: ${result.status}`);
  }
  if (result.deletionRequestId !== state.requestId) {
    throw new Error('operator confirm returned a different deletion request ID');
  }
  if (result.userId !== state.owner.partialId) {
    throw new Error('operator confirm returned a non-owner target');
  }
  if (result.authUserDeleted !== true) {
    throw new Error('operator confirm did not report auth user deletion');
  }
  if (result.verification && result.verification.passed !== true) {
    throw new Error('operator verification reported residuals');
  }
}

async function verifyPostDelete(admin, state) {
  const residuals = [];

  const ownerAuth = await maybeGetAuthUser(admin, state.owner.id);
  if (ownerAuth) residuals.push({ check: 'owner auth user deleted', count: 1 });

  for (const entry of CHECK_TABLES) {
    const count = await countRows(admin, entry.table, entry.column, state.owner.id, Boolean(entry.optional));
    if (!count.skipped && count.count > 0) {
      residuals.push({ check: entry.label ?? entry.table, table: entry.table, count: count.count });
    }
  }

  const storageBucket = admin.storage.from(state.storage.bucket);
  for (const prefix of state.storage.ownerPrefixes) {
    const listing = await storageBucket.list(prefix, { limit: 1000 });
    if (listing.error) {
      if (!isMissingResourceError(listing.error)) {
        throw new Error(`verify storage ${prefix}: ${listing.error.message}`);
      }
      continue;
    }
    const count = Array.isArray(listing.data) ? listing.data.length : 0;
    if (count > 0) {
      residuals.push({ check: 'owner storage objects removed', prefix: prefix.replace(state.owner.id, state.owner.partialId), count });
    }
  }

  const participantAuth = await maybeGetAuthUser(admin, state.participant.id);
  if (!participantAuth) residuals.push({ check: 'participant auth preserved', count: 0 });

  const participantProfile = await admin
    .from('profiles')
    .select('id,account_status')
    .eq('id', state.participant.id)
    .maybeSingle();
  if (participantProfile.error) {
    throw new Error(`verify participant profile: ${participantProfile.error.message}`);
  }
  if (!participantProfile.data) {
    residuals.push({ check: 'participant profile preserved', count: 0 });
  }

  const room = await admin.from('dressing_rooms').select('id,user_id').eq('id', state.roomId).maybeSingle();
  if (room.error) throw new Error(`verify shared room: ${room.error.message}`);
  if (!room.data) {
    residuals.push({ check: 'shared room transferred or safely handled', status: 'missing' });
  } else if (room.data.user_id !== state.participant.id) {
    residuals.push({ check: 'shared room transferred to participant', owner: shortId(room.data.user_id) });
  }

  const participantRow = await admin
    .from('dressing_room_participants')
    .select('*', { count: 'exact', head: true })
    .eq('dressing_room_id', state.roomId)
    .eq('user_id', state.participant.id);
  if (participantRow.error) throw new Error(`verify participant row: ${participantRow.error.message}`);
  if ((participantRow.count ?? 0) < 1) {
    residuals.push({ check: 'participant dressing room participant row preserved', count: participantRow.count ?? 0 });
  }

  const result = {
    passed: residuals.length === 0,
    checkedAt: new Date().toISOString(),
    ownerPartialId: state.owner.partialId,
    participantPartialId: state.participant.partialId,
    residuals,
  };
  writeJson(path.join(state.runDirAbs, 'driver-post-delete-verification.json'), result);
  if (!result.passed) {
    throw new Error(`post-delete verification failed: ${JSON.stringify(residuals)}`);
  }
  return result;
}

function buildInitialState(env) {
  const id = runToken();
  const runDirAbs = makeRunDir(id);
  const suffix = id.replace(/[^A-Za-z0-9_-]/g, '-');
  return {
    marker: DRIVER_MARKER,
    version: 1,
    runId: id,
    runDir: path.relative(REPO_ROOT, runDirAbs).replace(/\\/g, '/'),
    runDirAbs,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    projectRef: env.projectRef,
    supabaseUrlHost: new URL(env.url).host,
    owner: {
      id: null,
      partialId: null,
      email: `kscan-delete-e2e-owner-${suffix}@example.com`,
    },
    participant: {
      id: null,
      partialId: null,
      email: `kscan-delete-e2e-participant-${suffix}@example.com`,
    },
    requestId: null,
    requestedAt: null,
    roomId: null,
    roomPartialId: null,
    storage: null,
    dryRunGate: { passed: false },
    realUsersTouched: false,
  };
}

async function runDryRun() {
  const env = loadLiveEnv();
  const support = detectOperatorSupport();
  requireOperatorCapabilities(support);
  const { admin, anon } = createClients(env);
  const state = buildInitialState(env);
  persistState(state);

  try {
    if (!OWNER_EMAIL_RE.test(state.owner.email) || !PARTICIPANT_EMAIL_RE.test(state.participant.email)) {
      throw new Error('Generated disposable emails failed regex gates');
    }
    const { ownerAccessToken } = await createDisposableUsers(admin, anon, state);
    persistState(state);
    await seedDisposableData(admin, state);
    persistState(state);
    await submitDeletionRequest(env, state, ownerAccessToken);
    persistState(state);

    const dryRunArgs = ['--request-id', state.requestId, '--dry-run', '--output-dir', state.runDirAbs];
    const operator = runOperator(dryRunArgs, env, state, 'operator-dry-run');
    state.operatorDryRunFile = path.relative(REPO_ROOT, operator.file).replace(/\\/g, '/');
    await validateIdentityGates(admin, state, operator.json);
    persistState(state);
    log(`Dry-run gate passed for owner ${state.owner.partialId}; state written under ${state.runDir}`);
  } catch (error) {
    persistState(state);
    logFailureCleanupContext(state);
    throw error;
  }
}

async function runConfirmDelete(wantVerify) {
  const env = loadLiveEnv();
  const support = detectOperatorSupport();
  requireOperatorCapabilities(support);
  const state = loadLatestState();
  if (state.projectRef !== env.projectRef || state.supabaseUrlHost !== new URL(env.url).host) {
    throw new Error('Loaded dry-run state does not match the current Supabase project');
  }
  const { admin } = createClients(env);

  const dryRunArgs = ['--request-id', state.requestId, '--dry-run', '--output-dir', state.runDirAbs];
  const dryRun = runOperator(dryRunArgs, env, state, 'operator-dry-run-before-confirm');
  await validateIdentityGates(admin, state, dryRun.json);
  persistState(state);

  const confirmArgs = ['--request-id', state.requestId, '--confirm-delete'];
  if (wantVerify && support.verify) confirmArgs.push('--verify');
  confirmArgs.push('--output-dir', state.runDirAbs);
  const confirm = runOperator(confirmArgs, env, state, 'operator-confirm-delete');
  validateConfirmResult(state, confirm.json);

  state.confirmDelete = {
    completedAt: new Date().toISOString(),
    operatorOutputFile: path.relative(REPO_ROOT, confirm.file).replace(/\\/g, '/'),
    usedOperatorVerify: Boolean(wantVerify && support.verify),
  };
  persistState(state);

  const verification = await verifyPostDelete(admin, state);
  state.driverVerification = verification;
  persistState(state);
  log(`Confirm-delete E2E passed for owner ${state.owner.partialId}; participant ${state.participant.partialId} preserved`);
}

function logFailureCleanupContext(state) {
  if (!state?.owner?.email && !state?.participant?.email) return;
  log('Disposable cleanup context for manual review:');
  if (state.owner?.email) log(`  owner=${state.owner.email} id=${state.owner.partialId ?? 'unknown'}`);
  if (state.participant?.email) {
    log(`  participant=${state.participant.email} id=${state.participant.partialId ?? 'unknown'}`);
  }
  if (state.requestId) log(`  request=${state.requestId}`);
  if (state.runDir) log(`  artifacts=${state.runDir}`);
}

function selfTest() {
  const validOwner = 'kscan-delete-e2e-owner-20260707_abc-XYZ@example.com';
  const validParticipant = 'kscan-delete-e2e-participant-20260707_abc-XYZ@example.com';
  const assertions = [
    ['owner regex accepts valid disposable owner emails', OWNER_EMAIL_RE.test(validOwner)],
    ['participant regex accepts valid disposable participant emails', PARTICIPANT_EMAIL_RE.test(validParticipant)],
    ['owner regex rejects real domains', !OWNER_EMAIL_RE.test('kscan-delete-e2e-owner-test@gmail.com')],
    ['participant regex rejects real domains', !PARTICIPANT_EMAIL_RE.test('kscan-delete-e2e-participant-test@k-scan.ai')],
    [
      'project ref must equal approved project',
      (() => {
        try {
          validateLiveEnvValues({
            KSCAN_DELETE_E2E_PROJECT_REF: 'wrong-project',
            EXPO_PUBLIC_SUPABASE_URL: `https://${APPROVED_PROJECT_REF}.supabase.co`,
            EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-placeholder-for-self-test',
            SUPABASE_SERVICE_ROLE_KEY: 'service-placeholder-for-self-test',
            KSCAN_DELETE_E2E_ALLOW_PRODUCTION_DISPOSABLE: 'true',
          });
          return false;
        } catch {
          return true;
        }
      })(),
    ],
    [
      'Supabase URL must include approved project',
      (() => {
        try {
          validateLiveEnvValues({
            KSCAN_DELETE_E2E_PROJECT_REF: APPROVED_PROJECT_REF,
            EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
            EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-placeholder-for-self-test',
            SUPABASE_SERVICE_ROLE_KEY: 'service-placeholder-for-self-test',
            KSCAN_DELETE_E2E_ALLOW_PRODUCTION_DISPOSABLE: 'true',
          });
          return false;
        } catch {
          return true;
        }
      })(),
    ],
    [
      'secret redaction masks likely secret values',
      !redactSecrets('password=super-secret-value eyJabc.def.ghi postgres://u:p@host/db').includes('super-secret-value') &&
        !redactSecrets('password=super-secret-value eyJabc.def.ghi postgres://u:p@host/db').includes('postgres://'),
    ],
    [
      'destructive mode cannot run without explicit --confirm-delete',
      (() => {
        const parsed = parseArgs(['--dry-run']);
        return parsed.dryRun === true && parsed.confirmDelete === false;
      })(),
    ],
    [
      'confirm-delete requires dry-run gate logic',
      (() => {
        try {
          validateStateEnvelope({
            marker: DRIVER_MARKER,
            projectRef: APPROVED_PROJECT_REF,
            createdAt: new Date().toISOString(),
            owner: { id: '00000000-0000-0000-0000-000000000001', email: validOwner },
            participant: { id: '00000000-0000-0000-0000-000000000002', email: validParticipant },
            requestId: '00000000-0000-0000-0000-000000000003',
            dryRunGate: { passed: false },
          });
          return false;
        } catch {
          return true;
        }
      })(),
    ],
  ];

  const failed = assertions.filter(([, ok]) => !ok);
  for (const [name, ok] of assertions) {
    log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} self-test assertion(s) failed`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.selfTest && !options.dryRun && !options.confirmDelete)) {
    printHelp();
    return;
  }
  if (options.selfTest) {
    selfTest();
    return;
  }
  if (options.dryRun) {
    await runDryRun();
    return;
  }
  if (options.confirmDelete) {
    await runConfirmDelete(options.verify);
  }
}

main().catch((error) => {
  console.error(redactSecrets(`FATAL: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
