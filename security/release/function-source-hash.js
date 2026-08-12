#!/usr/bin/env node
'use strict';

/**
 * Canonical Edge Function source hash (DEF-REL-017).
 *
 * ONE implementation, used by the release manifest, candidate binding, and the
 * staging deploy core. Before this existed there were three subtly different
 * hashers: the manifest and deploy core hashed paths RELATIVE TO THE FUNCTION
 * DIRECTORY (`index.ts:<sha>`), while candidate binding hashed REPO-RELATIVE
 * paths (`supabase/functions/x/index.ts:<sha>`). The binding hash therefore
 * could never equal the deploy-input hash, so a real EXECUTE would have blocked
 * every governed function with SOURCE_HASH_MISMATCH. The existing "mismatch
 * blocks" test passed only because it supplied a deliberately wrong hash — it
 * never proved the matching case.
 *
 * ─── THE CONTRACT ───────────────────────────────────────────────────────────
 *
 * For a function directory D containing files f1..fn:
 *
 *   entry(f)  = "<path relative to D, POSIX separators>:<sha256 of bytes>"
 *   digest(D) = sha256( entries sorted by relative path, joined with "\n" )
 *
 *   path normalization  relative to D, `/` separators, no leading `./`
 *   sort order          byte-wise ascending on the normalized relative path
 *   file inclusion      every regular file, recursively; no filtering, so a
 *                       test file or a stray artifact still changes the digest
 *   symlinks/dirs       directories recursed; non-regular entries ignored
 *   binary/text         hashed as RAW BYTES. Reading as utf8 would corrupt
 *                       binary content and make the digest platform-dependent
 *                       through newline translation.
 *   shared deps         NOT included. `_shared` is tracked separately as
 *                       `sharedDependencyHash` on the manifest entry, because
 *                       one shared tree backs many functions; see
 *                       hashSharedDependencies below.
 *
 * The relative-path choice is deliberate: the deploy core materializes a
 * candidate into a temp root, so any repo-absolute or repo-relative component
 * would differ between binding and deployment by construction.
 *
 * Node built-ins only.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** sha256 over raw bytes. Accepts Buffer or string. */
function sha256Bytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Recursively lists regular files under `dir`, as normalized relative POSIX paths. */
function listSourceFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Canonical digest of a function's own source directory.
 * @returns {string|null} null when the directory does not exist
 */
function hashFunctionSource(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = listSourceFiles(dir);
  const entries = files.map((rel) => `${rel}:${sha256Bytes(fs.readFileSync(path.join(dir, rel)))}`);
  return sha256Bytes(Buffer.from(entries.join('\n'), 'utf8'));
}

/**
 * Canonical digest of the `_shared` dependency tree. Same algorithm, applied to
 * a different root — kept as a named export so callers cannot accidentally
 * conflate the two digests.
 */
function hashSharedDependencies(sharedDir) {
  return hashFunctionSource(sharedDir);
}

/**
 * Builds the same digest from an in-memory map of relative path -> bytes.
 * Used to hash a candidate read straight out of git objects without writing it
 * to disk first, so binding and deployment provably agree.
 *
 * @param {Map<string, Buffer|string>|object} fileMap
 */
function hashFromFileMap(fileMap) {
  const pairs = fileMap instanceof Map ? [...fileMap.entries()] : Object.entries(fileMap);
  const entries = pairs
    .map(([rel, contents]) => [String(rel).split(path.sep).join('/'), contents])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([rel, contents]) => `${rel}:${sha256Bytes(Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8'))}`);
  return sha256Bytes(Buffer.from(entries.join('\n'), 'utf8'));
}

module.exports = {
  sha256Bytes,
  listSourceFiles,
  hashFunctionSource,
  hashSharedDependencies,
  hashFromFileMap,
};
