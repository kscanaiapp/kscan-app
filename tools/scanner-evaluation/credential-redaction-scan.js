'use strict';

/**
 * Credential redaction gate for Phase 6 provider-evidence commits.
 *
 * WHY THIS EXISTS AS A COMMITTED SCRIPT
 *
 * The gate was previously an ad-hoc shell pipeline, which failed in the way
 * ad-hoc gates do: it reported FAIL on a synthetic credential-shaped string that
 * a Build 4 test deliberately contains to prove the artifact guard REJECTS such
 * text. A gate that cries wolf gets silenced, and the obvious silencing move —
 * excluding __tests__ — would blind it to a real key pasted into a fixture.
 *
 * So findings are separated by what they actually prove:
 *
 *   CRITICAL  the live credential's own bytes, or a header/URL/env snapshot
 *             carrying a value. These are exposure. No allowlist applies.
 *
 *   SHAPE     a token that merely LOOKS like a key. Real keys look like this,
 *             and so do fixtures that exist to be rejected. A shape match is a
 *             failure unless its SHA-256 is a registered synthetic fixture.
 *
 * Registering by hash rather than by path means a fixture that moves still
 * passes, while a fixture whose bytes change — someone pasting a real key over
 * it — fails immediately. The registry stores hashes, never tokens.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SCAN_ROOTS = Object.freeze([
  'docs/scanner-accuracy',
  'tools/scanner-evaluation',
]);

const SKIP_DIRECTORIES = new Set(['node_modules', '.git']);
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.pdf', '.zip', '.jar']);

/**
 * Known synthetic tokens, by SHA-256 of the matched token.
 *
 * Each entry must say what proves it synthetic. "It's in a test" is not a
 * reason — a real key in a test is still a real key.
 */
const SYNTHETIC_TOKEN_SHA256 = Object.freeze({
  // tools/scanner-evaluation/__tests__/phase2bCandidateArtifact.test.js
  // Negative fixture asserting assertArtifactContainsNoForbiddenContent()
  // refuses credential-shaped text. Sits beside equally synthetic samples of
  // prompt text, base64 image data and a benchmark label. Introduced at
  // d7c7160, before any credential existed in this environment.
  // 24 characters — far short of a real Google key's ~39, and never accepted by
  // the provider. Registered on its own bytes so a real key pasted over it fails.
  '02d66f2731fad0c85f611eb6f9b76d6b6a5cd5c0c26711d90fabe4d7baf23497':
    'phase2bCandidateArtifact negative fixture: credential-shaped string the guard must reject',
});

/** Patterns that indicate real exposure regardless of context. */
const CRITICAL_PATTERNS = Object.freeze([
  { id: 'authorization_header_with_value', re: /[Aa]uthorization:\s*[A-Za-z0-9_.-]{8,}/g },
  { id: 'api_key_header_with_value', re: /x-goog-api-key:\s*[A-Za-z0-9_-]{10,}/gi },
  { id: 'bearer_token', re: /[Bb]earer\s+[A-Za-z0-9._-]{16,}/g },
  { id: 'credential_in_url', re: /[?&]key=[A-Za-z0-9_-]{10,}/g },
  { id: 'serialized_environment', re: /JSON\.stringify\(\s*process\.env|Deno\.env\.toObject\(/g },
]);

/** Patterns that match a key's SHAPE and therefore admit synthetic fixtures. */
const SHAPE_PATTERNS = Object.freeze([
  { id: 'google_api_key_shape', re: /AIza[A-Za-z0-9_-]{20,}/g },
  { id: 'jwt_shape', re: /eyJ[A-Za-z0-9_-]{20,}/g },
]);

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && !SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

/**
 * @param {object} [options]
 * @param {string|null} [options.liveCredential] the active key, compared but never emitted
 * @param {string[]} [options.roots] scan roots relative to the repo
 * @returns {{ pass: boolean, findings: Array<object>, criticalCount: number,
 *             shapeCount: number, allowlistedCount: number, filesScanned: number }}
 */
function scan(options = {}) {
  const liveCredential = typeof options.liveCredential === 'string' && options.liveCredential.length >= 8
    ? options.liveCredential
    : null;
  const roots = options.roots || SCAN_ROOTS;

  const findings = [];
  let allowlistedCount = 0;
  let filesScanned = 0;

  for (const root of roots) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      filesScanned += 1;
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');

      // The one check that is never allowlisted: the live key's own bytes.
      if (liveCredential && text.includes(liveCredential)) {
        findings.push({ severity: 'CRITICAL', patternId: 'live_credential_value', file: rel });
      }

      for (const { id, re } of CRITICAL_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(text)) findings.push({ severity: 'CRITICAL', patternId: id, file: rel });
      }

      for (const { id, re } of SHAPE_PATTERNS) {
        re.lastIndex = 0;
        for (const match of text.match(re) || []) {
          const digest = sha256(match);
          if (SYNTHETIC_TOKEN_SHA256[digest]) { allowlistedCount += 1; continue; }
          // Never emit the token — only where it is and what it looked like.
          findings.push({ severity: 'SHAPE', patternId: id, file: rel, tokenSha256: digest });
        }
      }
    }
  }

  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length;
  const shapeCount = findings.filter((f) => f.severity === 'SHAPE').length;
  return {
    pass: findings.length === 0,
    findings,
    criticalCount,
    shapeCount,
    allowlistedCount,
    filesScanned,
  };
}

if (require.main === module) {
  const result = scan({ liveCredential: process.env.GEMINI_API_KEY || null });
  // Findings carry a path and a hash, never a token.
  process.stdout.write(`${JSON.stringify({
    credentialRedactionScan: result.pass ? 'PASS' : 'FAIL',
    findings: result.findings.length,
    criticalCount: result.criticalCount,
    shapeCount: result.shapeCount,
    allowlistedSyntheticFixtures: result.allowlistedCount,
    filesScanned: result.filesScanned,
    detail: result.findings,
  }, null, 2)}\n`);
  process.exit(result.pass ? 0 : 1);
}

module.exports = { scan, SYNTHETIC_TOKEN_SHA256, CRITICAL_PATTERNS, SHAPE_PATTERNS, SCAN_ROOTS };
