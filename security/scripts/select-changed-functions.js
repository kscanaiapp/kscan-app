#!/usr/bin/env node
'use strict';

/**
 * Computes the exact set of Edge Functions a PR candidate should deploy —
 * never a loop over every directory under supabase/functions/. A function is
 * included only if:
 *   (a) its own directory changed in the PR diff, or
 *   (b) it actually imports a shared module that changed (real import
 *       tracing over `from '...'` specifiers, not "deploy everything because
 *       _shared changed").
 *
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/select-changed-functions.js <baseSha> <headSha>
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FUNCTIONS_DIR = path.join('supabase', 'functions');
const SHARED_DIR_NAME = '_shared';
const IMPORT_RE = /(?:from|import)\s+['"](\.\.?\/[^'"]+)['"]/g;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function gitDiffFunctionPaths(baseSha, headSha) {
  const out = execSync(`git diff --name-only ${baseSha}...${headSha} -- ${toPosix(FUNCTIONS_DIR)}/`, {
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Splits the raw diff paths into changed function directories (top-level dir
// under supabase/functions/, excluding _shared) and changed shared files.
function splitChangedPaths(changedPaths) {
  const changedFunctionDirs = new Set();
  const changedSharedFiles = [];

  const prefix = `${toPosix(FUNCTIONS_DIR)}/`;
  for (const p of changedPaths) {
    const posixPath = toPosix(p);
    if (!posixPath.startsWith(prefix)) continue; // not under supabase/functions/ at all
    const rel = posixPath.slice(prefix.length);
    if (!rel || !rel.includes('/')) continue; // a bare file directly under supabase/functions/ (e.g. deno.json) is not a function directory
    const [topDir] = rel.split('/');
    if (topDir === SHARED_DIR_NAME) {
      changedSharedFiles.push(posixPath);
    } else if (topDir) {
      changedFunctionDirs.add(topDir);
    }
  }

  return { changedFunctionDirs: [...changedFunctionDirs].sort(), changedSharedFiles };
}

function listActualFunctionDirs(functionsDir = FUNCTIONS_DIR) {
  if (!fs.existsSync(functionsDir)) return [];
  return fs
    .readdirSync(functionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== SHARED_DIR_NAME)
    .map((d) => d.name)
    .sort();
}

function listSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name) && !d.name.endsWith('.test.ts'))
    .map((d) => path.join(dir, d.name));
}

// Resolves every relative import specifier in a source file to a
// project-relative posix path (adding the .ts extension convention this repo
// uses for explicit-extension imports; falls back to the bare resolved path
// if no extension was given).
function extractImportedPaths(sourceFile) {
  const content = fs.readFileSync(sourceFile, 'utf8');
  const importingDir = toPosix(path.dirname(sourceFile));
  const resolved = [];
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    const specifier = match[1];
    const joined = path.posix.normalize(path.posix.join(importingDir, specifier));
    resolved.push(joined);
  }
  return resolved;
}

// For each actual function directory (excluding _shared), determines whether
// any of its source files import any of the given changed shared file paths.
function findImportersOfSharedFiles(changedSharedFiles, functionsDir = FUNCTIONS_DIR) {
  if (changedSharedFiles.length === 0) return [];
  const changedSet = new Set(changedSharedFiles.map(toPosix));
  const importers = [];

  for (const fnName of listActualFunctionDirs(functionsDir)) {
    const fnDir = path.join(functionsDir, fnName);
    const sourceFiles = listSourceFiles(fnDir);
    const imports = sourceFiles.flatMap(extractImportedPaths);
    const importsChangedShared = imports.some((imp) => changedSet.has(imp));
    if (importsChangedShared) importers.push(fnName);
  }

  return importers.sort();
}

// Builds the final deploy manifest: union of directly-changed function dirs
// and functions that import a changed shared module, filtered to only
// directories that actually exist (never propose deploying something not on
// disk), with _shared itself always excluded as a deploy target.
function computeFunctionManifest(baseSha, headSha, functionsDir = FUNCTIONS_DIR) {
  const changedPaths = gitDiffFunctionPaths(baseSha, headSha);
  const { changedFunctionDirs, changedSharedFiles } = splitChangedPaths(changedPaths);
  const sharedImporters = findImportersOfSharedFiles(changedSharedFiles, functionsDir);

  const actualDirs = new Set(listActualFunctionDirs(functionsDir));
  const proposed = new Set([...changedFunctionDirs, ...sharedImporters]);

  const manifest = [];
  const refused = [];
  for (const name of proposed) {
    if (name === SHARED_DIR_NAME) continue; // never a deploy target
    if (actualDirs.has(name)) {
      manifest.push(name);
    } else {
      refused.push(name);
    }
  }
  manifest.sort();

  return {
    baseSha,
    headSha,
    changedFunctionDirs,
    changedSharedFiles,
    sharedImporters,
    manifest,
    refused,
    outcome: manifest.length === 0 ? 'NO_CHANGED_FUNCTIONS' : 'DEPLOYED',
  };
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  if (!baseSha || !headSha) {
    console.error('Usage: select-changed-functions.js <baseSha> <headSha>');
    process.exit(2);
  }
  console.log(JSON.stringify(computeFunctionManifest(baseSha, headSha), null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  toPosix,
  splitChangedPaths,
  listActualFunctionDirs,
  extractImportedPaths,
  findImportersOfSharedFiles,
  computeFunctionManifest,
  FUNCTIONS_DIR,
  SHARED_DIR_NAME,
};
