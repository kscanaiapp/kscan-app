const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const canonical = '214cf19efffce9b4f410b58075d4fc3c36c58bf1';
const reviewed = 'a1cf4b1535f92097189d51fb4573627eb943a8d7';
const handler = 'supabase/functions/purchase-import-extract/handler.ts';
const files = [handler, '__tests__/helpers/purchaseImportQuotaWorld.js', '__tests__/purchaseImportDefaultQuotaAdapter.test.js'];
const gitBlob = (file, sha = canonical) => execFileSync('git', ['show', sha + ':' + file], { cwd: root });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function approvedRow() {
  return {
    file: handler,
    sha256: sha256(gitBlob(handler)),
    source: canonical,
    reason: 'Exact merged canonical PR679/C023 opaque-session quota UUID repair; preserve client request/response, session fingerprint and all activation/deployment gates. F024/F025 remain separate repairs.',
  };
}
// Older promotion controls still compare every historical grant. Only this
// reviewed row advances; it is never inferred from mutable policy metadata.
const expectedReceiptAdvance = rows => rows.map(row => row.file === handler ? approvedRow() : row);
module.exports = { root, canonical, reviewed, handler, files, gitBlob, sha256, approvedRow, expectedReceiptAdvance };
