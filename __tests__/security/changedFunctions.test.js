#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  splitChangedPaths,
  listActualFunctionDirs,
  findImportersOfSharedFiles,
  extractImportedPaths,
  FUNCTIONS_DIR,
  SHARED_DIR_NAME,
} = require('../../security/scripts/select-changed-functions');

function tmpFunctionsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-fn-'));
}

function writeFunction(functionsDir, name, indexTsContent) {
  const dir = path.join(functionsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.ts'), indexTsContent, 'utf8');
  return dir;
}

// 7. One changed function.
test('splitChangedPaths: a single changed function directory is detected', () => {
  const changed = ['supabase/functions/stylechat-generate/index.ts'];
  const { changedFunctionDirs, changedSharedFiles } = splitChangedPaths(changed);
  assert.deepEqual(changedFunctionDirs, ['stylechat-generate']);
  assert.deepEqual(changedSharedFiles, []);
});

test('splitChangedPaths: a bare file directly under supabase/functions/ (e.g. deno.json) is not treated as a function directory', () => {
  const changed = ['supabase/functions/deno.json', 'supabase/functions/stylechat-generate/index.ts'];
  const { changedFunctionDirs } = splitChangedPaths(changed);
  assert.deepEqual(changedFunctionDirs, ['stylechat-generate']);
  assert.equal(changedFunctionDirs.includes('deno.json'), false);
});

// 8. Multiple changed functions.
test('splitChangedPaths: multiple changed function directories are all detected', () => {
  const changed = [
    'supabase/functions/stylechat-generate/index.ts',
    'supabase/functions/product-search-deals/index.ts',
    'supabase/functions/product-search-deals/helpers.ts',
  ];
  const { changedFunctionDirs } = splitChangedPaths(changed);
  assert.deepEqual(changedFunctionDirs, ['product-search-deals', 'stylechat-generate']);
});

test('splitChangedPaths: _shared files are separated out, not treated as a function dir', () => {
  const changed = [
    'supabase/functions/_shared/security/context.ts',
    'supabase/functions/stylechat-generate/index.ts',
  ];
  const { changedFunctionDirs, changedSharedFiles } = splitChangedPaths(changed);
  assert.deepEqual(changedFunctionDirs, ['stylechat-generate']);
  assert.deepEqual(changedSharedFiles, ['supabase/functions/_shared/security/context.ts']);
});

// 9. _shared change affecting one importer.
test('findImportersOfSharedFiles: a changed shared file affecting exactly one function returns only that function', (t) => {
  const functionsDir = tmpFunctionsDir();
  t.after(() => fs.rmSync(functionsDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(functionsDir, SHARED_DIR_NAME, 'security'), { recursive: true });
  fs.writeFileSync(path.join(functionsDir, SHARED_DIR_NAME, 'security', 'context.ts'), '// shared', 'utf8');

  writeFunction(functionsDir, 'stylechat-generate', `import { authenticateRequest } from '../_shared/security/context.ts';\n`);
  writeFunction(functionsDir, 'unrelated-function', `console.log('no shared import here');\n`);

  const changedShared = [`${functionsDir.replace(/\\/g, '/')}/_shared/security/context.ts`];
  const importers = findImportersOfSharedFiles(changedShared, functionsDir);
  assert.deepEqual(importers, ['stylechat-generate']);
});

// 10. _shared change affecting multiple importers.
test('findImportersOfSharedFiles: a changed shared file imported by two functions returns both', (t) => {
  const functionsDir = tmpFunctionsDir();
  t.after(() => fs.rmSync(functionsDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(functionsDir, SHARED_DIR_NAME, 'security'), { recursive: true });
  fs.writeFileSync(path.join(functionsDir, SHARED_DIR_NAME, 'security', 'errors.ts'), '// shared errors', 'utf8');

  writeFunction(functionsDir, 'fn-a', `import { securityErrorResponse } from '../_shared/security/errors.ts';\n`);
  writeFunction(functionsDir, 'fn-b', `import { securityErrorResponse } from '../_shared/security/errors.ts';\n`);
  writeFunction(functionsDir, 'fn-c', `// does not import anything shared\n`);

  const changedShared = [`${functionsDir.replace(/\\/g, '/')}/_shared/security/errors.ts`];
  const importers = findImportersOfSharedFiles(changedShared, functionsDir);
  assert.deepEqual(importers, ['fn-a', 'fn-b']);
});

test('findImportersOfSharedFiles: a changed shared file nobody imports returns no importers', (t) => {
  const functionsDir = tmpFunctionsDir();
  t.after(() => fs.rmSync(functionsDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(functionsDir, SHARED_DIR_NAME, 'security'), { recursive: true });
  fs.writeFileSync(path.join(functionsDir, SHARED_DIR_NAME, 'security', 'unused.ts'), '// unused', 'utf8');
  writeFunction(functionsDir, 'fn-a', `import { x } from '../_shared/security/errors.ts';\n`);

  const changedShared = [`${functionsDir.replace(/\\/g, '/')}/_shared/security/unused.ts`];
  assert.deepEqual(findImportersOfSharedFiles(changedShared, functionsDir), []);
});

// 11. Unrelated function directory excluded.
test('listActualFunctionDirs: excludes _shared and non-directory entries', (t) => {
  const functionsDir = tmpFunctionsDir();
  t.after(() => fs.rmSync(functionsDir, { recursive: true, force: true }));

  writeFunction(functionsDir, 'real-function', `// ok\n`);
  fs.mkdirSync(path.join(functionsDir, SHARED_DIR_NAME), { recursive: true });
  fs.writeFileSync(path.join(functionsDir, 'stray-file.ts'), '// not a function dir', 'utf8');

  const dirs = listActualFunctionDirs(functionsDir);
  assert.deepEqual(dirs, ['real-function']);
  assert.equal(dirs.includes(SHARED_DIR_NAME), false);
});

test('extractImportedPaths: resolves a relative shared import to a project-relative path', (t) => {
  const functionsDir = tmpFunctionsDir();
  t.after(() => fs.rmSync(functionsDir, { recursive: true, force: true }));

  const fnDir = writeFunction(
    functionsDir,
    'stylechat-generate',
    `import { authenticateRequest } from '../_shared/security/context.ts';\nimport { z } from '../_shared/security/validation.ts';\n`,
  );
  const imports = extractImportedPaths(path.join(fnDir, 'index.ts'));
  const posix = imports.map((p) => p.replace(/\\/g, '/'));
  assert.equal(posix.some((p) => p.endsWith('_shared/security/context.ts')), true);
  assert.equal(posix.some((p) => p.endsWith('_shared/security/validation.ts')), true);
});

// 13. Empty deployment manifest.
test('splitChangedPaths + findImportersOfSharedFiles: no function or shared changes yields an empty manifest', () => {
  const { changedFunctionDirs, changedSharedFiles } = splitChangedPaths([]);
  assert.deepEqual(changedFunctionDirs, []);
  assert.deepEqual(changedSharedFiles, []);
  assert.deepEqual(findImportersOfSharedFiles(changedSharedFiles), []);
});

test('splitChangedPaths: a path outside supabase/functions/ entirely is ignored', () => {
  const { changedFunctionDirs, changedSharedFiles } = splitChangedPaths(['app/index.tsx', 'docs/security/foo.md']);
  assert.deepEqual(changedFunctionDirs, []);
  assert.deepEqual(changedSharedFiles, []);
});
