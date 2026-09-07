'use strict';

/**
 * Real asset storage (mission section 18, design DM-01).
 *
 * STORAGE MODEL: metadata + SHA-256 hashes are version controlled; the image
 * bytes live in an owner-mounted external root. Git LFS is installed on the
 * machine but not governed in this repository (`git lfs ls-files` is empty and
 * .gitattributes has no filter=lfs entry), so section 18's LFS carve-out does
 * not apply and adopting it unilaterally would be an unauthorized, hard-to-
 * reverse repository-weight decision on a PUBLIC repo.
 *
 * A missing mount is a legible state (`ASSETS_NOT_MOUNTED`), never a crash:
 * validation, the collection queue, the gap list and the power map all work on
 * a checkout with no assets at all. That matters, because most people reading
 * this corpus will never have the bytes.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PATHS } = require('./paths');
const { inspectImage, sha256Hex } = require('./imageIntegrity');
const { inspectMetadata } = require('./exif');

const MOUNT_ENV_VAR = 'KSCAN_RFC_ASSET_ROOT';

/**
 * Resolve the asset root. Returns { mounted, root, source }.
 * `source` is 'env' | 'default' | 'none' so a report can say WHY it found what
 * it found rather than leaving an operator guessing.
 */
function resolveAssetRoot({ env = process.env } = {}) {
  const configured = env[MOUNT_ENV_VAR];
  if (configured && configured.trim() !== '') {
    const root = path.resolve(configured.trim());
    return { mounted: fs.existsSync(root), root, source: 'env' };
  }
  const root = PATHS.defaultAssetMount;
  // The default mount only counts as mounted if it actually holds something -
  // the directory itself is committed (with a .gitignore), so its mere
  // existence proves nothing.
  const mounted =
    fs.existsSync(root) && fs.readdirSync(root).some((name) => name !== '.gitignore' && !name.startsWith('.'));
  return { mounted, root, source: mounted ? 'default' : 'none' };
}

function assetFilePath(root, assetPath) {
  const resolved = path.resolve(root, assetPath);
  const normalisedRoot = path.resolve(root);
  // Defence in depth: the schema already rejects '..' and absolute paths, but
  // a path that escapes the root must never be read even if a record slipped
  // past validation.
  if (resolved !== normalisedRoot && !resolved.startsWith(normalisedRoot + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * Read and inspect one asset.
 *
 * Returns:
 *   { status: 'OK' | 'NOT_MOUNTED' | 'MISSING' | 'PATH_ESCAPES_ROOT' | 'UNREADABLE',
 *     sha256, byteSize, integrity, metadata, hashMatches }
 */
function inspectAsset(caseRecord, { env = process.env, assetRoot } = {}) {
  const mount = assetRoot ? { mounted: fs.existsSync(assetRoot), root: assetRoot, source: 'explicit' } : resolveAssetRoot({ env });

  if (!mount.mounted) {
    return { status: 'NOT_MOUNTED', root: mount.root, source: mount.source };
  }

  const assetPath = caseRecord?.asset?.assetPath;
  const file = assetPath ? assetFilePath(mount.root, assetPath) : null;
  if (!file) return { status: 'PATH_ESCAPES_ROOT', root: mount.root, assetPath };
  if (!fs.existsSync(file)) return { status: 'MISSING', root: mount.root, file, assetPath };

  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    return { status: 'UNREADABLE', root: mount.root, file, error: err.message };
  }

  const integrity = inspectImage(bytes);
  const metadata = inspectMetadata(bytes);
  const sha256 = sha256Hex(bytes);

  return {
    status: 'OK',
    root: mount.root,
    file,
    sha256,
    byteSize: bytes.length,
    integrity,
    metadata,
    hashMatches: caseRecord?.asset?.sha256 ? caseRecord.asset.sha256 === sha256 : null,
  };
}

/**
 * Verify every case's asset against its recorded hash.
 *
 * Returns { mounted, root, checked, results, summary }. When the mount is
 * absent this reports ASSETS_NOT_MOUNTED for the whole set rather than
 * pretending every asset is fine - an unverifiable asset is not a verified one.
 */
function verifyAssets(cases, options = {}) {
  const mount = options.assetRoot
    ? { mounted: fs.existsSync(options.assetRoot), root: options.assetRoot, source: 'explicit' }
    : resolveAssetRoot(options);

  const results = cases.map((record) => ({
    caseId: record.caseId,
    ...inspectAsset(record, { ...options, assetRoot: mount.mounted ? mount.root : undefined }),
  }));

  const summary = {
    ok: results.filter((r) => r.status === 'OK' && r.hashMatches !== false).length,
    hashMismatch: results.filter((r) => r.status === 'OK' && r.hashMatches === false).length,
    missing: results.filter((r) => r.status === 'MISSING').length,
    unreadable: results.filter((r) => r.status === 'UNREADABLE').length,
    notMounted: results.filter((r) => r.status === 'NOT_MOUNTED').length,
  };

  return {
    mounted: mount.mounted,
    root: mount.root,
    mountSource: mount.source,
    storageStatus: mount.mounted ? 'MOUNTED' : 'ASSETS_NOT_MOUNTED',
    checked: results.length,
    results,
    summary,
  };
}

/**
 * Duplicate detection (mission section 27, invariants 42.8 / 42.9).
 *
 * Two cases sharing one asset hash are either an accidental duplicate - the
 * same photograph filed twice, which would double-count a garment in every
 * metric - or an intentional paired capture. The distinction is NOT guessable
 * from the bytes, so it is decided by declared intent:
 *
 *   - Same hash + the two cases declare each other as a pair -> still an
 *     ACCIDENTAL duplicate. A genuine iOS/Android pair is two photographs from
 *     two cameras; identical bytes mean one file was copied, which is exactly
 *     the fabricated parity mission section 15 forbids.
 *   - Same hash, no pairing -> ACCIDENTAL_DUPLICATE.
 *   - Different hashes + mutual pairing -> INTENTIONAL_PAIR, which is allowed.
 */
function findDuplicateAssets(cases) {
  const byHash = new Map();
  for (const record of cases) {
    const hash = record?.asset?.sha256;
    if (!hash) continue;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(record);
  }

  const duplicates = [];
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    const ids = group.map((r) => r.caseId).sort();
    const mutuallyPaired = group.every((r) =>
      group.some((other) => other.caseId !== r.caseId && r.pairing?.pairedCaseId === other.caseId),
    );
    duplicates.push({
      sha256: hash,
      caseIds: ids,
      classification: 'ACCIDENTAL_DUPLICATE',
      reason: mutuallyPaired
        ? 'these cases declare each other as a paired capture, but two photographs from two cameras cannot be ' +
          'byte-identical - one file was copied, which would fabricate platform parity (mission section 15)'
        : 'two cases share one asset hash, so the same photograph is filed twice and would be counted twice',
    });
  }
  return duplicates;
}

/**
 * Paired captures that are genuinely distinct files.
 * Returns { valid, invalid } pair groups.
 */
function validatePairs(cases) {
  const byId = new Map(cases.map((record) => [record.caseId, record]));
  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (const record of cases) {
    const partnerId = record.pairing?.pairedCaseId;
    if (!partnerId) continue;
    const key = [record.caseId, partnerId].sort().join('::');
    if (seen.has(key)) continue;
    seen.add(key);

    const partner = byId.get(partnerId);
    if (!partner) {
      invalid.push({ caseIds: [record.caseId, partnerId], reason: `paired case ${partnerId} does not exist` });
      continue;
    }
    if (partner.pairing?.pairedCaseId !== record.caseId) {
      invalid.push({
        caseIds: [record.caseId, partnerId],
        reason: `pairing is not mutual: ${partnerId} points at ${partner.pairing?.pairedCaseId ?? 'nothing'}`,
      });
      continue;
    }
    if (partner.garmentId !== record.garmentId) {
      invalid.push({
        caseIds: [record.caseId, partnerId],
        reason:
          `a paired capture must photograph the SAME physical garment, but ${record.caseId} is ${record.garmentId} ` +
          `and ${partnerId} is ${partner.garmentId}`,
      });
      continue;
    }
    if (record.capture?.device?.platform === partner.capture?.device?.platform) {
      invalid.push({
        caseIds: [record.caseId, partnerId],
        reason: `both captures are on ${record.capture?.device?.platform}; a device pair needs one iOS and one Android capture`,
      });
      continue;
    }
    if (record.asset?.sha256 && record.asset.sha256 === partner.asset?.sha256) {
      invalid.push({
        caseIds: [record.caseId, partnerId],
        reason: 'both captures have the same asset hash - one file was copied rather than two photographs taken',
      });
      continue;
    }
    if (record.partition !== partner.partition) {
      invalid.push({
        caseIds: [record.caseId, partnerId],
        reason: `paired captures straddle the development/holdout split (${record.partition} vs ${partner.partition})`,
      });
      continue;
    }
    valid.push({ caseIds: [record.caseId, partnerId].sort(), garmentId: record.garmentId });
  }

  return { valid, invalid };
}

module.exports = {
  MOUNT_ENV_VAR,
  resolveAssetRoot,
  inspectAsset,
  verifyAssets,
  findDuplicateAssets,
  validatePairs,
  assetFilePath,
};
