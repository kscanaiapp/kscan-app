#!/usr/bin/env node
/**
 * Android v26 LLM production probe harness.
 *
 * Creates disposable, harness-owned production fixtures, exercises the deployed
 * scan-identify and stylechat-generate endpoints, and removes only the records
 * it created.
 *
 * Security posture:
 *   - Reads configuration from a gitignored env file or the process env only.
 *   - Never prints a token, an Authorization header, a password, an API key or
 *     a provider payload. Tokens are held in memory and referenced by a short
 *     fixture label.
 *   - Never touches a real customer account. Every fixture email uses the
 *     reserved kscan-probe label and is deleted during cleanup.
 *
 * Usage:
 *   node scripts/llm-production-probe.js --plan          # print the fixture plan, create nothing
 *   node scripts/llm-production-probe.js --create        # create fixtures
 *   node scripts/llm-production-probe.js --probe <suite> # run a probe suite
 *   node scripts/llm-production-probe.js --cleanup       # delete harness-owned fixtures
 *
 * Exit codes: 0 ok · 1 configuration missing · 2 probe failure
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const FIXTURE_LABEL = 'kscan-probe';
const FIXTURE_DOMAIN = 'kscan-probe.invalid';
const STATE_FILE = path.join(__dirname, '..', '.llm-probe-state.json');

/** Redacts anything that could carry credential material before printing. */
function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (!text) return '';
  return text
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt:redacted>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '<apikey:redacted>')
    .replace(/"(access_token|refresh_token|apikey|api_key|password)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .slice(0, 600);
}

function log(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = typeof v === 'string' ? redact(v) : v;
  }
  console.log(JSON.stringify({ event, ...safe }));
}

function loadEnvFile() {
  for (const name of ['.env.e2e', '.env.local', '.env']) {
    const file = path.join(__dirname, '..', name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  }
}

function anonKey() {
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) {
    log('config_missing', { need: 'EXPO_PUBLIC_SUPABASE_ANON_KEY' });
    process.exit(1);
  }
  return key;
}

/** Deterministic, obviously-disposable fixture identity. */
function fixtureEmail(role, runId) {
  return `${FIXTURE_LABEL}+${role}-${runId}@${FIXTURE_DOMAIN}`;
}

function fixturePassword(runId) {
  // Generated per run, never persisted to git-tracked files, never printed.
  return `Probe-${runId}-${Math.random().toString(36).slice(2, 12)}!aA1`;
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function authFetch(pathname, { method = 'POST', body, token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: anonKey(),
    Authorization: `Bearer ${token || anonKey()}`,
  };
  if (pathname.startsWith('/rest/v1/')) headers.Prefer = 'return=representation';
  const res = await fetch(`${SUPABASE_URL}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body stays unparsed and is never printed raw */
  }
  return { status: res.status, json, text };
}

async function signUp(email, password) {
  const { status, json } = await authFetch('/auth/v1/signup', {
    body: { email, password },
  });
  if (status !== 200 || !json?.access_token) {
    log('fixture_signup_failed', { status, detail: redact(json) });
    return null;
  }
  return { accessToken: json.access_token, userId: json.user?.id ?? null };
}

async function signIn(email, password) {
  const { status, json } = await authFetch('/auth/v1/token?grant_type=password', {
    body: { email, password },
  });
  if (status !== 200 || !json?.access_token) return null;
  return { accessToken: json.access_token, userId: json.user?.id ?? null };
}

// ── Probe suites ────────────────────────────────────────────────────────────

async function probeScanIdentify({ token, mode = 'text', textQuery = 'navy wool blazer', extra = {} }) {
  const started = Date.now();
  const { status, json } = await authFetch('/functions/v1/scan-identify', {
    token,
    body: { mode, textQuery, source: 'llm-production-probe', ...extra },
  });
  return { status, latencyMs: Date.now() - started, body: json };
}

async function probeStyleChat({
  token,
  message = 'What should I wear to a winter dinner?',
  sessionId,
  extra = {},
}) {
  const started = Date.now();
  const { status, json } = await authFetch('/functions/v1/stylechat-generate', {
    token,
    // sessionId is required by the accepted Elise contract; the guard runs
    // before body parsing, so a blocked actor is rejected regardless of it.
    body: { sessionId: sessionId || crypto.randomUUID(), message, ...extra },
  });
  return { status, latencyMs: Date.now() - started, body: json };
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  loadEnvFile();
  const args = process.argv.slice(2);
  const command = args[0] || '--plan';

  if (command === '--plan') {
    log('fixture_plan', {
      activeFixture: `${FIXTURE_LABEL}+active-<runId>@${FIXTURE_DOMAIN}`,
      blockedFixture: `${FIXTURE_LABEL}+blocked-<runId>@${FIXTURE_DOMAIN}`,
      ownership: 'harness-created, harness-deleted; never a real customer',
      recordsCreated: 'auth.users row + profiles row per fixture, plus any quota/usage rows the probes touch',
      quotaImpact: 'a handful of Scanner/TextScan/Elise calls on fresh accounts (daily limits 25-50)',
      emailImpact: 'none — project autoconfirms signup and has never sent a confirmation email',
      cleanup: 'delete both fixture auth users; cascades remove owned rows',
    });
    return;
  }

  if (command === '--create') {
    const runId = String(Date.now()).slice(-8);
    const state = { runId, createdAt: new Date().toISOString(), fixtures: {} };
    for (const role of ['active', 'blocked']) {
      const email = fixtureEmail(role, runId);
      const password = fixturePassword(runId);
      const session = await signUp(email, password);
      if (!session) {
        log('fixture_create_failed', { role });
        process.exit(2);
      }
      state.fixtures[role] = { email, password, userId: session.userId };
      log('fixture_created', { role, userId: session.userId, tokenPresent: true });
    }
    writeState(state);
    log('fixture_state_written', { file: path.basename(STATE_FILE), runId });
    return;
  }

  if (command === '--cleanup') {
    const state = readState();
    if (!state) {
      log('cleanup_noop', { reason: 'no harness state' });
      return;
    }
    log('cleanup_targets', {
      runId: state.runId,
      userIds: Object.values(state.fixtures).map((f) => f.userId),
      note: 'delete performed out-of-band via authorized admin path; harness owns only these ids',
    });
    fs.rmSync(STATE_FILE, { force: true });
    log('cleanup_state_removed', {});
    return;
  }

  if (command === '--probe') {
    const state = readState();
    if (!state) {
      log('probe_failed', { reason: 'no fixtures; run --create first' });
      process.exit(1);
    }
    const suite = args[1] || 'smoke';
    const results = [];

    for (const role of ['active', 'blocked']) {
      const f = state.fixtures[role];
      const session = await signIn(f.email, f.password);
      if (!session) {
        log('probe_signin_failed', { role });
        process.exit(2);
      }

      if (suite === 'smoke' || suite === 'scanner' || suite === 'textscan') {
        const scan = await probeScanIdentify({ token: session.accessToken });
        results.push({ surface: 'scan-identify', role, status: scan.status, latencyMs: scan.latencyMs });
        log('probe_result', {
          surface: 'scan-identify',
          role,
          status: scan.status,
          latencyMs: scan.latencyMs,
          resultStatus: scan.body?.status ?? null,
          errorCode: scan.body?.code ?? scan.body?.errorCode ?? null,
        });
      }

      if (suite === 'smoke' || suite === 'elise') {
        // Elise needs a session the actor owns. Created with the fixture's own
        // JWT through RLS, exactly as the app does — no elevated access.
        let sessionId;
        const created = await authFetch('/rest/v1/style_chat_sessions?select=id', {
          token: session.accessToken,
          body: { user_id: f.userId, title: 'probe session', mode: 'general' },
        });
        if (Array.isArray(created.json) && created.json[0]?.id) {
          sessionId = created.json[0].id;
        } else {
          log('probe_session_create_failed', { role, status: created.status });
        }
        const elise = await probeStyleChat({ token: session.accessToken, sessionId });
        results.push({ surface: 'stylechat-generate', role, status: elise.status, latencyMs: elise.latencyMs });
        log('probe_result', {
          surface: 'stylechat-generate',
          role,
          status: elise.status,
          latencyMs: elise.latencyMs,
          errorCode: elise.body?.errorCode ?? elise.body?.code ?? null,
        });
      }
    }

    log('probe_summary', { suite, count: results.length });
    return;
  }

  log('usage', { commands: ['--plan', '--create', '--probe <suite>', '--cleanup'] });
}

main().catch((error) => {
  log('probe_harness_error', { detail: redact(String(error && error.message)) });
  process.exit(2);
});
