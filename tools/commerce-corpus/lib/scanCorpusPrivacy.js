'use strict';

/**
 * Runs the reused privacy guard (spec section 43) over every fixture file
 * and the manifest itself. Fails closed: any single violation anywhere in
 * the corpus makes the whole scan unsafe.
 */

const fs = require('node:fs');
const { scanForPrivacyViolations } = require('./privacyGuard');
const { listFixtureFiles, MANIFEST_PATH } = require('./loadCorpus');

function scanCorpusPrivacy() {
  const violations = [];
  const files = [...listFixtureFiles(), MANIFEST_PATH];

  for (const file of files) {
    let content;
    try {
      content = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      violations.push({ file, path: '$', reason: `unreadable_or_invalid_json:${err.message}` });
      continue;
    }
    const result = scanForPrivacyViolations(content);
    for (const v of result.violations) {
      violations.push({ file, path: v.path, reason: v.reason });
    }
  }

  return { safe: violations.length === 0, violations, filesScanned: files.length };
}

module.exports = { scanCorpusPrivacy };
