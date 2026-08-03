#!/usr/bin/env node
'use strict';

/**
 * Verifies Supabase CLI commands target the approved staging project only.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/verify-staging-project-ref.js [expectedRef]
 *
 * Env:
 *   SUPABASE_STAGING_PROJECT_REF (preferred)
 *   EXPECTED_STAGING_REF (fallback)
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

function fail(message) {
  console.error(`Staging project guard failed: ${message}`);
  process.exit(1);
}

function readLinkedRef() {
  const tempDir = path.join(process.cwd(), 'supabase', '.temp');
  const candidates = [
    path.join(tempDir, 'project-ref'),
    path.join(tempDir, 'linked-project.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (candidate.endsWith('.json')) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (parsed?.ref) return String(parsed.ref).trim();
      } catch {
        /* ignore */
      }
    } else {
      return fs.readFileSync(candidate, 'utf8').trim();
    }
  }
  return null;
}

function scanConfigForRefs() {
  const refs = new Set();
  const configPath = path.join(process.cwd(), 'supabase', 'config.toml');
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf8');
    const matches = text.match(/project_id\s*=\s*"([^"]+)"/g) || [];
    for (const match of matches) {
      const id = match.match(/"([^"]+)"/);
      if (id) refs.add(id[1]);
    }
  }
  return [...refs];
}

function main() {
  const expected = (
    process.argv[2]
    || process.env.SUPABASE_STAGING_PROJECT_REF
    || process.env.EXPECTED_STAGING_REF
    || DEFAULT_STAGING_REF
  ).trim();

  if (expected === PRODUCTION_REF) {
    fail('expected staging ref must not equal production ref');
  }

  const linked = readLinkedRef();
  const configRefs = scanConfigForRefs();

  if (linked && linked !== expected) {
    fail(`linked project ref ${linked} does not match expected staging ref ${expected}`);
  }

  for (const ref of configRefs) {
    if (ref === PRODUCTION_REF) {
      fail(`supabase config references production ref ${PRODUCTION_REF}`);
    }
    if (ref !== expected) {
      fail(`supabase config project_id ${ref} does not match expected staging ref ${expected}`);
    }
  }

  const envUrl = process.env.SUPABASE_STAGING_URL || '';
  if (envUrl && !envUrl.includes(expected)) {
    fail('SUPABASE_STAGING_URL does not contain expected staging project ref');
  }

  console.log(JSON.stringify({
    ok: true,
    expectedStagingRef: expected,
    productionRefBlocked: PRODUCTION_REF,
    linkedRef: linked || 'not-linked-locally',
    configRefs,
  }));
}

if (require.main === module) {
  main();
}

module.exports = { DEFAULT_STAGING_REF, PRODUCTION_REF, readLinkedRef };
