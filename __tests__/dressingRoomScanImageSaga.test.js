/**
 * B33-STO-004 — addScanImageToDressingRoom() can upload a scan image to
 * storage BEFORE inserting the owning row (when imageSource.kind is neither
 * 'storage' nor 'remote' — i.e. a fresh device-local capture with no durable
 * reference yet). If the insert then fails (RLS, a bad dressing_room_id, a
 * dropped connection), the upload already succeeded and nothing removed it:
 * an orphan storage object with no owning row and no compensating delete.
 * Proven on staging: 30 storage objects whose owner no longer resolves to an
 * auth.users row.
 *
 * Required behavior:
 *   UPLOAD -> INSERT -> success
 *   UPLOAD -> INSERT FAIL -> COMPENSATING DELETE
 *
 * Reusing an existing durable storage reference (imageSource.kind ===
 * 'storage', e.g. re-adding a previously uploaded item) must NEVER be
 * deleted on a later failure in the same call — that object is not this
 * call's to own.
 *
 * This does not touch the pre-existing orphan objects on staging/production
 * (that cleanup is separately governed via reconcile-orphan-media) — it only
 * stops this request path from creating new ones.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const service = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'styleObjects.ts'),
  'utf8',
);

function extractFunction(source, name) {
  const marker = new RegExp(`export async function ${name}\\(`);
  const match = marker.exec(source);
  assert.ok(match, `${name} not found in services/styleObjects.ts`);
  const rest = source.slice(match.index);
  const nextExport = rest.slice(1).search(/\nexport /);
  return nextExport === -1 ? rest : rest.slice(0, nextExport + 1);
}

test('B33-STO-004: a fresh upload is tracked separately from a reused storage reference', () => {
  const fn = extractFunction(service, 'addScanImageToDressingRoom');
  assert.match(
    fn,
    /let uploadedThisCall = false;/,
    'the saga must distinguish "this call uploaded a new object" from "this call reused an existing one"',
  );
  const storageReuseBranch = fn.slice(
    fn.indexOf("imageSource.kind === 'storage'"),
    fn.indexOf("} else if (imageSource.kind === 'remote')"),
  );
  assert.ok(
    !/uploadedThisCall = true/.test(storageReuseBranch),
    'reusing a pre-existing storage ref must never be marked as this call\'s own upload',
  );
  const uploadBranch = fn.slice(fn.indexOf('uploadLocalScanImage('));
  assert.match(
    uploadBranch.slice(0, uploadBranch.indexOf('devLog(\'add:upload_succeeded\'')),
    /uploadedThisCall = true;/,
    'a fresh upload this call performed must be marked so a later insert failure can compensate for it',
  );
});

test('B33-STO-004: an insert failure triggers a compensating delete of an object this call uploaded', () => {
  const fn = extractFunction(service, 'addScanImageToDressingRoom');
  const insertIndex = fn.indexOf(".from('dressing_room_items')\n    .insert(");
  assert.ok(insertIndex !== -1, 'insert call not found');
  const errorBranch = fn.slice(insertIndex);

  assert.match(errorBranch, /if \(error\) \{/, 'the insert error must be handled explicitly');
  assert.match(
    errorBranch,
    /if \(uploadedThisCall && storageBucket && storagePath\) \{/,
    'cleanup must be gated on this call having actually uploaded a new object',
  );
  assert.match(
    errorBranch,
    /\.storage\s*\n\s*\.from\(storageBucket\)\s*\n\s*\.remove\(\[storagePath\]\)/,
    'on insert failure the exact object just uploaded must be removed',
  );
});

test('B33-STO-004: the compensating delete is best-effort and never masks the original error', () => {
  const fn = extractFunction(service, 'addScanImageToDressingRoom');
  const insertIndex = fn.indexOf(".from('dressing_room_items')\n    .insert(");
  const errorBranch = fn.slice(insertIndex);
  const deleteCallIndex = errorBranch.indexOf('.remove([storagePath])');
  const afterDelete = errorBranch.slice(deleteCallIndex);

  assert.match(
    afterDelete,
    /\.catch\(\(\) => \{\}\)/,
    'a failed cleanup delete must be swallowed, not thrown -- the caller needs to see the insert error, not a storage error',
  );
  assert.match(
    afterDelete,
    /throw safeError\(error, 'Unable to add scan to Dressing Room\.'\);/,
    'the original insert error must still propagate to the caller after cleanup is attempted',
  );
});

test('B33-STO-004: the delete targets the object actually uploaded, not a recomputed path', () => {
  const fn = extractFunction(service, 'addScanImageToDressingRoom');
  assert.match(fn, /storage_bucket: storageBucket,/);
  assert.match(fn, /storage_path: storagePath,/);
  assert.match(fn, /\.remove\(\[storagePath\]\)/);
});
