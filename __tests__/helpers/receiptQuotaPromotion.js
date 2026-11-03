const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const canonical = '31be5f99341b606a070bbbe0b3062588f320f089';
const reviewed = '184395bc8899904946ce0c86e8c0a64ebef03b76';
const handler = 'supabase/functions/purchase-import-extract/handler.ts';
const files = [handler, '__tests__/helpers/purchaseImportQuotaWorld.js', '__tests__/purchaseImportDefaultQuotaAdapter.test.js'];
const gitBlob = (file, sha = canonical) => execFileSync('git', ['show', sha + ':' + file], { cwd: root });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function approvedRow() {
  return {
    file: handler,
    sha256: sha256(gitBlob(handler)),
    source: canonical,
    reason: 'Exact canonical PR681/F024 runtime repair plus PR684 event-synchronized regression; preserve C023 UUID/session contract and all activation/deployment gates. F025 remains separate.',
  };
}
// Older promotion controls still compare every historical grant. Only this
// reviewed row advances; it is never inferred from mutable policy metadata.
const expectedReceiptAdvance = rows => rows.map(row => row.file === handler ? approvedRow() : row);
module.exports = { root, canonical, reviewed, handler, files, gitBlob, sha256, approvedRow, expectedReceiptAdvance };
