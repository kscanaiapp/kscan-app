#!/usr/bin/env node
/**
 * Central shared-Supabase migration authority validator.
 *
 * Checks config/migration-authority-manifest.json against the actual
 * supabase/migrations/ tree on disk:
 *   1. every entry's canonicalFilename exists
 *   2. every entry's canonicalSqlHash matches the SHA-256 of that file's
 *      body (everything after the first blank line, i.e. after the
 *      provenance header)
 *   3. no duplicate ledgerVersion values
 *   4. sourceRepo is one of manifest.knownSourceRepos
 *   5. canonicalFilename's leading version number equals ledgerVersion
 *      (this is the actual thing `supabase db push` reconciles on)
 *   6. no two entries claim the same canonicalFilename
 *
 * Read-only. Never touches the database or the Supabase CLI. Exits 1 and
 * prints every violation found (does not stop at the first one) if any
 * check fails; exits 0 silently on success.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalBody(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const blankIndex = lines.findIndex((line) => line === '');
  if (blankIndex === -1) {
    throw new Error(`${filePath}: no blank line found separating provenance header from SQL body`);
  }
  return lines.slice(blankIndex + 1).join('\n');
}

/**
 * @param {{knownSourceRepos: string[], entries: object[]}} manifest
 * @param {string} repoRoot directory that canonicalFilename paths are relative to
 * @returns {string[]} violation messages, empty array means clean
 */
function verifyMigrationAuthority(manifest, repoRoot) {
  const violations = [];
  const seenVersions = new Map();
  const seenCanonicalFiles = new Map();

  for (const entry of manifest.entries) {
    const label = `${entry.ledgerVersion} (${entry.logicalName})`;

    if (seenVersions.has(entry.ledgerVersion)) {
      violations.push(`Duplicate ledgerVersion: ${entry.ledgerVersion} appears in both "${seenVersions.get(entry.ledgerVersion)}" and "${entry.logicalName}"`);
    } else {
      seenVersions.set(entry.ledgerVersion, entry.logicalName);
    }

    if (seenCanonicalFiles.has(entry.canonicalFilename)) {
      violations.push(`Duplicate canonicalFilename: "${entry.canonicalFilename}" claimed by both ${seenCanonicalFiles.get(entry.canonicalFilename)} and ${label}`);
    } else {
      seenCanonicalFiles.set(entry.canonicalFilename, label);
    }

    if (!manifest.knownSourceRepos.includes(entry.sourceRepo)) {
      violations.push(`${label}: unknown sourceRepo "${entry.sourceRepo}" (expected one of ${manifest.knownSourceRepos.join(', ')})`);
    }

    const canonicalBaseName = path.basename(entry.canonicalFilename);
    const filenameVersion = canonicalBaseName.match(/^(\d+)_/)?.[1];
    if (filenameVersion !== entry.ledgerVersion) {
      violations.push(`${label}: canonicalFilename version prefix "${filenameVersion}" does not equal ledgerVersion "${entry.ledgerVersion}" -- supabase db push reconciles by this prefix`);
    }

    const absPath = path.join(repoRoot, entry.canonicalFilename);
    if (!fs.existsSync(absPath)) {
      violations.push(`${label}: canonicalFilename "${entry.canonicalFilename}" does not exist on disk`);
      continue;
    }

    let actualHash;
    try {
      actualHash = sha256(canonicalBody(absPath));
    } catch (err) {
      violations.push(`${label}: ${err.message}`);
      continue;
    }
    if (actualHash !== entry.canonicalSqlHash) {
      violations.push(`${label}: canonicalSqlHash mismatch -- manifest says ${entry.canonicalSqlHash}, file body actually hashes to ${actualHash}`);
    }
  }

  return violations;
}

module.exports = { verifyMigrationAuthority, canonicalBody, sha256 };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'config', 'migration-authority-manifest.json'), 'utf8'),
  );
  const violations = verifyMigrationAuthority(manifest, repoRoot);
  if (violations.length > 0) {
    console.error(`MIGRATION AUTHORITY: FAIL (${violations.length} violation(s))`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`MIGRATION AUTHORITY: PASS (${manifest.entries.length} entries verified)`);
}
