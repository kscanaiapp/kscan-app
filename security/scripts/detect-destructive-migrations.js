#!/usr/bin/env node
'use strict';

/**
 * Detects destructive SQL operations in migration files.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/detect-destructive-migrations.js [migrationsDir]
 */

const fs = require('node:fs');
const path = require('node:path');

const DESTRUCTIVE_PATTERNS = [
  { id: 'DROP_TABLE', regex: /\bDROP\s+TABLE\b/i, severity: 'CRITICAL' },
  { id: 'DROP_SCHEMA', regex: /\bDROP\s+SCHEMA\b/i, severity: 'CRITICAL' },
  { id: 'TRUNCATE', regex: /\bTRUNCATE\b/i, severity: 'CRITICAL' },
  { id: 'BROAD_DELETE', regex: /\bDELETE\s+FROM\s+\w+\s*;\s*$/im, severity: 'HIGH' },
  { id: 'RLS_DISABLE', regex: /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, severity: 'CRITICAL' },
  { id: 'OWNERSHIP_PREDICATE_REMOVAL', regex: /\bDROP\s+POLICY\b.*\b(owner|user_id|auth\.uid)/i, severity: 'HIGH' },
  { id: 'PUBLIC_GRANT_PRIVILEGED', regex: /\bGRANT\b.+\b(authenticated|anon|public)\b.+\b(EXECUTE|ALL)\b/i, severity: 'HIGH' },
  { id: 'SERVICE_ROLE_CLIENT', regex: /service[_-]?role[_-]?key/i, severity: 'CRITICAL' },
];

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const findings = [];
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.regex.test(content)) {
      findings.push({
        file: filePath,
        pattern: pattern.id,
        severity: pattern.severity,
      });
    }
  }
  return findings;
}

function main() {
  const dir = process.argv[2] || path.join('supabase', 'migrations');
  if (!fs.existsSync(dir)) {
    console.log(JSON.stringify({ ok: true, findings: [], message: 'no migrations directory' }));
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => path.join(dir, f));
  const findings = files.flatMap(scanFile);

  const output = {
    scannedFiles: files.length,
    findings,
    hasBlocking: findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'),
  };

  console.log(JSON.stringify(output, null, 2));

  const requireApproval = process.env.REQUIRE_DESTRUCTIVE_APPROVAL === 'true';
  if (output.hasBlocking && requireApproval) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scanFile, DESTRUCTIVE_PATTERNS };
