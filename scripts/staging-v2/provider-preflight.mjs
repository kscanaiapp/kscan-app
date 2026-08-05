#!/usr/bin/env node
/**
 * Provider / model runtime preflight for K Scan AI Staging.
 *
 * WHY THIS EXISTS. An Edge Function deploys successfully regardless of whether
 * its configured model id is still served. A retired Gemini model fails at
 * *invocation* time with a provider 404, which no deployment check catches. So
 * deployment success alone is not evidence, and this script supplies the missing
 * evidence by actually calling each model-dependent function.
 *
 * WHAT IT DOES
 *   1. Confirms the required secret NAMES exist per function. Names only — the
 *      Supabase CLI returns SHA-256 digests, so no value is ever read or printed.
 *   2. Signs in as a synthetic staging user (created through the real signup
 *      flow, never inserted into auth.users).
 *   3. Invokes each model-dependent function with a synthetic request and
 *      classifies the outcome per function, so one broken provider does not mask
 *      the others.
 *
 * Read-mostly: it creates a synthetic user, one chat session, and four synthetic
 * closet rows, all clearly labelled. It never touches the Waitlist and never
 * runs against production — the guard rejects that.
 *
 * Usage:
 *   SUPABASE_STAGING_ANON_KEY=... \
 *   node scripts/staging-v2/provider-preflight.mjs --project-ref yzqjvdfgefveprobvvyw
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveCliTarget, runGuarded } from '../lib/staging-v2-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPERATION = 'staging-provider-preflight';

/** Secret names each model-dependent function needs, per its own source. */
const REQUIRED_SECRETS = {
  'scan-identify': ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  'stylechat-generate': ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'],
  'style-outfit-generate': ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'],
};

/** A provider that answered vs a provider that is misconfigured. */
const PROVIDER_FAILURE = /not found|404|unsupported model|model.*(retired|deprecated)|API key not valid|permission denied/i;

function secretNames(ref) {
  const out = spawnSync('supabase', ['secrets', 'list', '--project-ref', ref], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (out.status !== 0) throw new Error(`supabase secrets list failed: ${out.stderr}`);
  return new Set((JSON.parse(out.stdout).secrets || []).map((s) => s.name));
}

/** An 8x8 solid PNG generated in-process. No real-world image is used. */
function syntheticPng() {
  const z = zlib;
  const w = 8;
  const h = 8;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 40;
      raw[o + 1] = 60;
      raw[o + 2] = 90;
    }
  }
  const table = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', z.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

await runGuarded(
  OPERATION,
  async () => {
    const args = parseArgs(process.argv.slice(2));
    const target = resolveCliTarget(OPERATION, args);
    const base = target.url;
    const anon = process.env.SUPABASE_STAGING_ANON_KEY || '';
    if (!anon) throw new Error('SUPABASE_STAGING_ANON_KEY is required');

    // ---- 1. secret NAME presence -------------------------------------------
    const present = secretNames(target.projectRef);
    let secretGaps = 0;
    console.log('Secret-name preflight (names only; no value is read or printed)');
    for (const [fn, names] of Object.entries(REQUIRED_SECRETS)) {
      const missing = names.filter((n) => !present.has(n));
      secretGaps += missing.length;
      console.log(`  ${fn.padEnd(24)} ${missing.length === 0 ? 'all present' : `MISSING: ${missing.join(', ')}`}`);
    }

    // ---- 2. synthetic user via the real signup flow -------------------------
    const email = args.email || `kscan.staging.preflight+${Date.now()}@example.com`;
    const password = 'Preflight-Synthetic-2026!';
    const h = { apikey: anon, 'Content-Type': 'application/json' };

    await fetch(`${base}/auth/v1/signup`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ email, password }),
    });
    const tokRes = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ email, password }),
    });
    const tok = (await tokRes.json()).access_token;
    if (!tok) throw new Error('could not obtain a staging session for the synthetic user');
    const userId = JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()).sub;
    const auth = { ...h, Authorization: `Bearer ${tok}` };
    console.log(`\nSynthetic user created through the real signup flow (id ${userId.slice(0, 8)}…)`);

    // ---- 3. per-function synthetic invocation -------------------------------
    const results = [];
    const record = (fn, status, verdict, detail) => {
      results.push({ fn, status, verdict, detail });
      console.log(`  ${fn.padEnd(24)} HTTP ${status}  ${verdict}${detail ? ` — ${detail}` : ''}`);
    };
    const classify = (fn, status, text) => {
      if (PROVIDER_FAILURE.test(text)) return record(fn, status, 'PROVIDER FAIL', text.slice(0, 120));
      if (status >= 500) return record(fn, status, 'FAIL', text.slice(0, 120));
      if (status === 200) return record(fn, status, 'PASS', 'provider answered');
      return record(fn, status, 'REACHED', text.slice(0, 100));
    };

    console.log('\nSynthetic model invocations');

    // scan-identify
    {
      const r = await fetch(`${base}/functions/v1/scan-identify`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ imageBase64: syntheticPng(), mode: 'scan' }),
      });
      classify('scan-identify', r.status, await r.text());
    }

    // stylechat-generate — needs a session row it owns
    {
      const s = await fetch(`${base}/rest/v1/style_chat_sessions`, {
        method: 'POST',
        headers: { ...auth, Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: userId, title: 'preflight synthetic' }),
      });
      const sessionId = (await s.json())?.[0]?.id;
      const r = await fetch(`${base}/functions/v1/stylechat-generate`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ sessionId, message: 'preflight synthetic probe', requestId: `preflight-${Date.now()}` }),
      });
      classify('stylechat-generate', r.status, await r.text());
    }

    // style-outfit-generate — short-circuits before the provider on an empty
    // Closet, so a minimal synthetic Closet is seeded first. Category must sit
    // at analysis_result.metadata.category or the candidate builder skips the row.
    {
      const items = [
        ['Preflight Overcoat', 'outerwear', 'overcoat'],
        ['Preflight Oxford', 'tops', 'shirt'],
        ['Preflight Jean', 'bottoms', 'jeans'],
        ['Preflight Sneaker', 'footwear', 'sneaker'],
      ];
      for (const [title, category, subcategory] of items) {
        await fetch(`${base}/rest/v1/saved_scans`, {
          method: 'POST',
          headers: { ...auth, Prefer: 'return=minimal' },
          body: JSON.stringify({
            user_id: userId,
            title,
            analysis_result: { metadata: { category, subcategory }, itemName: title },
          }),
        });
      }
      const r = await fetch(`${base}/functions/v1/style-outfit-generate`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          mode: 'style_event',
          contractVersion: '1',
          occasion: 'casual coffee',
          dressCode: 'casual',
          setting: 'outdoor',
        }),
      });
      const text = await r.text();
      if (/insufficient_closet/.test(text)) {
        record('style-outfit-generate', r.status, 'NOT EXERCISED', 'short-circuited before the provider');
      } else {
        classify('style-outfit-generate', r.status, text);
      }
    }

    const bad = results.filter((r) => r.verdict === 'PROVIDER FAIL' || r.verdict === 'FAIL');
    const unexercised = results.filter((r) => r.verdict === 'NOT EXERCISED');
    console.log(
      `\n${results.filter((r) => r.verdict === 'PASS').length}/${results.length} model paths answered; ` +
        `${bad.length} failing; ${unexercised.length} not exercised; ${secretGaps} secret-name gap(s).`,
    );
    if (bad.length > 0) process.exitCode = 1;
  },
  { root: ROOT },
);
