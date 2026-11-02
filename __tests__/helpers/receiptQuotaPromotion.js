const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const canonical = '26d5fae291ffcdbb1a56e312524013c6939ab152';
const reviewed = 'f8d7f61cf6d5f75b966d8ea44a27a3ad8d5effe4';
const handler = 'supabase/functions/purchase-import-extract/handler.ts';
const files = [handler, '__tests__/helpers/purchaseImportQuotaWorld.js', '__tests__/purchaseImportDefaultQuotaAdapter.test.js'];
const gitBlob = (file, sha = canonical) => execFileSync('git', ['show', sha + ':' + file], { cwd: root });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function approvedRow() {
  return {
    file: handler,
    sha256: sha256(gitBlob(handler)),
    source: canonical,
    reason: 'Exact merged canonical PR681/F024 duplicate-replay dispatch refusal; preserve C023 private UUID/session fingerprint, wire contracts and all deployment/activation gates. F025 remains a separate repair.',
  };
}
// Older promotion controls still compare every historical grant. Only this
// reviewed row advances; it is never inferred from mutable policy metadata.
const expectedReceiptAdvance = rows => rows.map(row => row.file === handler ? approvedRow() : row);
module.exports = { root, canonical, reviewed, handler, files, gitBlob, sha256, approvedRow, expectedReceiptAdvance };
