#!/usr/bin/env node
/**
 * Capture and apply K Scan AI Staging Auth configuration via the Management API.
 *
 * WHY THIS EXISTS. There is no other read path. The Supabase MCP server exposes
 * no Auth-configuration tool; the CLI has `supabase config push` but no pull, so
 * remote Auth settings cannot be read through it; and `config push` is unsafe
 * here anyway because it would send this repo's local `[auth]` block, whose
 * site_url is the Docker shadow stack's 127.0.0.1 address, overwriting staging's
 * real site URL and redirect allow-list with values that cannot be read back.
 *
 * This script talks to GET/PATCH /v1/projects/{ref}/config/auth directly, so it
 * changes only the keys named on the command line and leaves every other setting
 * untouched.
 *
 * AUTH. Needs a Supabase personal access token in SUPABASE_ACCESS_TOKEN. The CLI
 * keeps its token in the OS credential store, which is not readable from here.
 * Create one at https://supabase.com/dashboard/account/tokens.
 *
 * Usage:
 *   # record current staging config (redacted) as committed evidence
 *   node scripts/staging-v2/auth-config.mjs --capture --project-ref yzqjvdfgefveprobvvyw
 *
 *   # close the known production-parity gap
 *   node scripts/staging-v2/auth-config.mjs --apply --project-ref yzqjvdfgefveprobvvyw \
 *     --set external_anonymous_users_enabled=true
 *
 * Production is rejected by the guard for --apply, and permitted read-only for
 * --capture so the two can be compared.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runGuarded } from '../lib/staging-v2-cli.mjs';
import { resolveTarget, STAGING_PROJECT_REF } from '../lib/staging-v2-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'staging-rebuild', 'evidence');
const API = 'https://api.supabase.com';
const OPERATION = 'staging-auth-config';

/**
 * Keys worth recording for parity. Anything matching a secret-ish pattern is
 * redacted before it is written, so committed evidence never carries a value.
 */
const REDACT = /(secret|password|key|token|dsn|url_pattern_private)/i;

const PARITY_KEYS = [
  'external_anonymous_users_enabled',
  'external_email_enabled',
  'external_google_enabled',
  'external_apple_enabled',
  'external_phone_enabled',
  'disable_signup',
  'mailer_autoconfirm',
  'mailer_otp_exp',
  'password_min_length',
  'password_required_characters',
  'password_hibp_enabled',
  'jwt_exp',
  'refresh_token_rotation_enabled',
  'security_refresh_token_reuse_interval',
  'security_captcha_enabled',
  'security_captcha_provider',
  'rate_limit_email_sent',
  'rate_limit_sms_sent',
  'rate_limit_token_refresh',
  'rate_limit_verify',
  'rate_limit_anonymous_users',
  'site_url',
  'uri_allow_list',
  'mailer_subjects_confirmation',
  'mailer_subjects_recovery',
];

function token() {
  const t = process.env.SUPABASE_ACCESS_TOKEN || '';
  if (!t) {
    throw new Error(
      'SUPABASE_ACCESS_TOKEN is not set. The Supabase CLI stores its token in the OS ' +
        'credential store, which is not readable from here. Create a personal access token ' +
        'at https://supabase.com/dashboard/account/tokens and export it for this command only.',
    );
  }
  return t;
}

async function getAuthConfig(ref) {
  const res = await fetch(`${API}/v1/projects/${ref}/config/auth`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`GET config/auth -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function patchAuthConfig(ref, body) {
  const res = await fetch(`${API}/v1/projects/${ref}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH config/auth -> ${res.status} ${await res.text()}`);
  return res.json();
}

function redact(cfg) {
  const out = {};
  for (const k of PARITY_KEYS) {
    if (!(k in cfg)) continue;
    out[k] = REDACT.test(k) ? '<redacted>' : cfg[k];
  }
  return out;
}

/** `--set k=v` (repeatable) into a typed patch body. */
function parseSets(args) {
  const raw = args.set === undefined ? [] : Array.isArray(args.set) ? args.set : [args.set];
  const body = {};
  for (const pair of raw) {
    const i = String(pair).indexOf('=');
    if (i === -1) throw new Error(`--set expects key=value, got "${pair}"`);
    const k = String(pair).slice(0, i);
    const v = String(pair).slice(i + 1);
    body[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  if (Object.keys(body).length === 0) throw new Error('--apply requires at least one --set key=value');
  return body;
}

await runGuarded(
  OPERATION,
  async () => {
    const args = parseArgs(process.argv.slice(2));
    const ref = (typeof args['project-ref'] === 'string' && args['project-ref']) || '';
    const capture = Boolean(args.capture);
    const apply = Boolean(args.apply);
    if (capture === apply) throw new Error('choose exactly one of --capture or --apply');

    // --capture is read-only, so production is permitted as a comparison source.
    // --apply is a write and resolves through the staging-only allow-list.
    const target = resolveTarget({ operation: OPERATION, projectRef: ref, readOnly: capture });

    if (capture) {
      const cfg = redact(await getAuthConfig(target.projectRef));
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      const out = path.join(EVIDENCE_DIR, `auth-config-${target.projectRef}.json`);
      fs.writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`);
      console.log(`captured ${Object.keys(cfg).length} settings -> ${path.relative(ROOT, out)}`);
      for (const [k, v] of Object.entries(cfg)) console.log(`  ${k} = ${JSON.stringify(v)}`);
      return;
    }

    const body = parseSets(args);
    console.log(`Target: ${target.projectRef} (${STAGING_PROJECT_REF === target.projectRef ? 'staging' : '??'})`);
    console.log('Patch (only these keys change; every other setting is left alone):');
    for (const [k, v] of Object.entries(body)) console.log(`  ${k} = ${JSON.stringify(v)}`);

    if (args['dry-run']) {
      console.log('Dry run — Auth configuration unchanged.');
      return;
    }

    const before = await getAuthConfig(target.projectRef);
    await patchAuthConfig(target.projectRef, body);
    const after = await getAuthConfig(target.projectRef);

    let changed = 0;
    for (const k of Object.keys(body)) {
      const b = before[k];
      const a = after[k];
      if (JSON.stringify(b) !== JSON.stringify(a)) changed += 1;
      console.log(`  ${k}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    }
    console.log(`${changed} setting(s) changed on ${target.projectRef}.`);
  },
  { root: ROOT },
);
