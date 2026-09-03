/**
 * Shared helpers for staging deployment scripts (Node ESM, built-ins only).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  STAGING_URL,
  PRODUCTION_URL,
  REQUIRED_STAGING_VARS,
  PROHIBITED_SQL_PATTERNS,
  DESTRUCTIVE_REQUIRES_MANUAL,
  MIGRATION_FILENAME_RE,
} from './staging-constants.mjs';

export function fail(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

export class StagingGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StagingGuardError';
  }
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').toUpperCase();
}

export function decodeJwtClaims(token) {
  if (!token || typeof token !== 'string' || token.split('.').length < 2) {
    return null;
  }
  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function redactKeyFingerprint(key) {
  if (!key || typeof key !== 'string') return 'absent';
  if (key.length < 12) return 'too-short';
  return `${key.slice(0, 6)}…${key.slice(-4)} (len=${key.length})`;
}

export function assertStagingTarget({
  projectRef = process.env.SUPABASE_STAGING_PROJECT_REF,
  url = process.env.SUPABASE_STAGING_URL,
  anonKey = process.env.SUPABASE_STAGING_ANON_KEY,
} = {}) {
  const ref = (projectRef || '').trim();
  const stagingUrl = (url || '').trim();
  const key = (anonKey || '').trim();

  if (!ref) throw new StagingGuardError('SUPABASE_STAGING_PROJECT_REF is absent');
  if (ref === PRODUCTION_PROJECT_REF) {
    throw new StagingGuardError('Staging project ref equals production — refusing');
  }
  if (ref !== STAGING_PROJECT_REF) {
    throw new StagingGuardError(`Staging project ref must be ${STAGING_PROJECT_REF}, got ${ref}`);
  }

  if (!stagingUrl) throw new StagingGuardError('SUPABASE_STAGING_URL is absent');
  if (stagingUrl.includes(PRODUCTION_PROJECT_REF) || stagingUrl === PRODUCTION_URL) {
    throw new StagingGuardError('SUPABASE_STAGING_URL points at production — refusing');
  }
  if (!stagingUrl.includes(STAGING_PROJECT_REF)) {
    throw new StagingGuardError('SUPABASE_STAGING_URL does not contain expected staging project ref');
  }

  if (!key) throw new StagingGuardError('SUPABASE_STAGING_ANON_KEY is absent');
  const claims = decodeJwtClaims(key);
  if (claims) {
    if (claims.ref && claims.ref !== STAGING_PROJECT_REF) {
      throw new StagingGuardError(
        `Anon key JWT ref claim is ${claims.ref}, expected ${STAGING_PROJECT_REF}`,
      );
    }
    if (claims.role === 'service_role') {
      throw new StagingGuardError('Service-role key supplied where anon/publishable expected');
    }
  }

  return {
    projectRef: STAGING_PROJECT_REF,
    url: STAGING_URL,
    anonKeyFingerprint: redactKeyFingerprint(key),
  };
}

export function missingRequiredVars(env = process.env, required = REQUIRED_STAGING_VARS) {
  return required.filter((name) => !env[name] || String(env[name]).trim() === '');
}

export function parseMigrationFilename(filename) {
  const base = path.basename(filename);
  const match = MIGRATION_FILENAME_RE.exec(base);
  if (!match) return null;
  return { version: match[1], name: match[2], filename: base };
}

export function listLocalMigrationVersions(migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')) {
  if (!fs.existsSync(migrationsDir)) return [];
  const versions = [];
  for (const file of fs.readdirSync(migrationsDir)) {
    const parsed = parseMigrationFilename(file);
    if (!parsed) continue;
    versions.push({ ...parsed, path: path.join(migrationsDir, file) });
  }
  versions.sort((a, b) => a.version.localeCompare(b.version));
  return versions;
}

export function scanSqlForProhibited(sql, { allowDestructive = false } = {}) {
  const findings = [];
  for (const pattern of PROHIBITED_SQL_PATTERNS) {
    if (pattern.regex.test(sql)) findings.push({ id: pattern.id, severity: 'BLOCK' });
  }
  for (const pattern of DESTRUCTIVE_REQUIRES_MANUAL) {
    if (pattern.regex.test(sql)) {
      findings.push({
        id: pattern.id,
        severity: allowDestructive ? 'WARN' : 'BLOCK',
      });
    }
  }
  return findings;
}

export function parseDeployFunctionsAllowList(raw = process.env.DEPLOY_FUNCTIONS) {
  if (!raw || String(raw).trim() === '') return [];
  const value = String(raw).trim();
  if (value.toLowerCase() === 'all') {
    throw new StagingGuardError(
      'DEPLOY_FUNCTIONS=all is rejected unless the owner explicitly authorizes a batch outside this script',
    );
  }
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function runSupabase(args, { cwd = process.cwd() } = {}) {
  return execFileSync('supabase', args, {
    encoding: 'utf8',
    cwd,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Normalizes the several JSON shapes the Supabase CLI has used for row output
 * (`{rows: [...]}`, a bare array, `{result: [...]}`) into a plain array.
 * Returns null when the payload cannot be understood at all -- which callers
 * MUST distinguish from "zero rows", because the two mean opposite things.
 */
export function parseSupabaseRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.rows)) return parsed.rows;
  if (Array.isArray(parsed?.result)) return parsed.result;
  if (Array.isArray(parsed?.migrations)) return parsed.migrations;
  return null;
}

/**
 * Reads the applied migration ledger from the linked project.
 *
 * FAILS CLOSED ON AN EMPTY OR UNREADABLE RESULT. A provisioned Supabase project
 * always has rows in supabase_migrations.schema_migrations, so "no rows" means
 * the query shape changed or the read failed -- never that nothing is applied.
 * Treating an unreadable ledger as an empty one inverts every downstream
 * comparison: it makes the entire local migration set look pending, which is
 * how a single-migration gate ends up reporting 154 pending migrations.
 */
export function readRemoteMigrationVersions(run = runSupabase) {
  const attempts = [
    () => run(['db', 'query', 'select version from supabase_migrations.schema_migrations order by version', '--linked', '--output-format', 'json']),
    () => run(['migration', 'list', '--linked', '--output-format', 'json']),
  ];

  const errors = [];
  for (const attempt of attempts) {
    let rows;
    try {
      rows = parseSupabaseRows(attempt());
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (rows === null) {
      errors.push('unrecognized JSON shape');
      continue;
    }
    const versions = [
      ...new Set(
        rows
          .map((row) => (row && typeof row === 'object' ? (row.version ?? row.remote) : row))
          .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
          .map((v) => String(v).trim()),
      ),
    ].sort();
    if (versions.length > 0) return versions;
    errors.push('zero rows');
  }

  throw new Error(
    `Could not read the remote migration ledger (${errors.join('; ')}). ` +
      'Refusing to treat an unreadable ledger as an empty one.',
  );
}

export function ensureArtifactsDir(subdir = 'staging-deployments') {
  const dir = path.join(process.cwd(), 'artifacts', subdir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return filePath;
}

export function gitHeadSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function gitWorkingTreeClean() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return out === '';
  } catch {
    return false;
  }
}

export {
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  STAGING_URL,
  PRODUCTION_URL,
  REQUIRED_STAGING_VARS,
};
