import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runWinSafe } from './lib/win-safe-exec.mjs';

export function credentialConfiguration(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'kscanaiapp/kscan-app'
      || env.GITHUB_REF !== 'refs/heads/rebuild/backend-authority-v2'
      || env.FUNCTION_NAME !== 'kplus-revenuecat-webhook'
      || env.VERIFY_JWT !== 'false'
      || env.SUPABASE_PRODUCTION_PROJECT_REF !== 'wyyuqfdxucjksghsmhry'
      || env.ROTATION_CONFIRMATION !== 'COORDINATED RC CREDENTIAL REPLACEMENT') {
    throw new Error('RevenueCat credential replacement scope or coordination confirmation invalid');
  }
  const values = {
    KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION: env.RC_PRODUCTION_AUTHORIZATION,
    KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET: env.RC_PRODUCTION_SIGNING_SECRET,
  };
  for (const value of Object.values(values)) {
    if (typeof value !== 'string' || value.trim().length < 32 || value !== value.trim()
        || /[\r\n\0]/.test(value)) throw new Error('RevenueCat credentials missing or invalid; values withheld');
  }
  if (values.KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION === values.KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET) {
    throw new Error('Independent RevenueCat credentials required');
  }
  return values;
}

export function configure(env, run = runWinSafe) {
  const values = credentialConfiguration(env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-rc-config-'));
  const file = path.join(dir, 'secrets.env');
  // JSON quoting preserves spaces, quotes and dotenv metacharacters exactly.
  const serialized = Object.entries(values).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n');
  try {
    fs.writeFileSync(file, serialized, { mode: 0o600 });
    const opts = { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], env };
    run('supabase', ['secrets','set','--project-ref',env.SUPABASE_PRODUCTION_PROJECT_REF,'--env-file',file], opts);
    const rows = JSON.parse(run('supabase', ['secrets','list','--project-ref',env.SUPABASE_PRODUCTION_PROJECT_REF,'--output','json'], opts));
    if (!Array.isArray(rows) || Object.entries(values).some(([name,value]) =>
      rows.find(r => r.name === name)?.value !== crypto.createHash('sha256').update(value).digest('hex'))) {
      throw new Error('Unverified replacement');
    }
    return { configured: true, verified: true, credentials: Object.keys(values) };
  } catch {
    throw new Error('Production RevenueCat credential replacement failed or unverified; stop and coordinate recovery; output withheld');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(configure(process.env))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
