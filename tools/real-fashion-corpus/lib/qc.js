'use strict';

/**
 * QC (mission section 27).
 *
 *   "QC verifies corpus integrity, NOT K Scan match quality."
 *
 * Section 27's floor - QC must make it IMPOSSIBLE to SILENTLY accept:
 *   unreadable asset, corrupt asset, missing provenance, hash mismatch, wrong
 *   fixture relationship, accidental duplicate, privacy violation,
 *   real/synthetic tier confusion, holdout leakage.
 *
 * "Silently" is the operative word. Every check below either passes, or emits
 * an auditable rejection carrying a stable machine-readable code, the affected
 * record, and a human-readable reason. There is no path that drops a finding.
 */

const { QC_POLICY_VERSION, ASSET_TIER_REAL, ASSET_TIER_PIPELINE_TEST } = require('./constants');
const { validateGarment, validateCase } = require('./recordSchema');
const { deriveGrade, checkProvenanceSelfContained, evaluateIdentityEligibility } = require('./groundTruth');
const { verifyAssets, findDuplicateAssets, validatePairs } = require('./assetStore');
const { assignPartition } = require('./holdout');

const QC_CODES = Object.freeze({
  SCHEMA_INVALID: 'QC_SCHEMA_INVALID',
  ORPHAN_CASE: 'QC_ORPHAN_CASE',
  TIER_CONTAMINATION: 'QC_TIER_CONTAMINATION',
  ASSET_MISSING: 'QC_ASSET_MISSING',
  ASSET_UNREADABLE: 'QC_ASSET_UNREADABLE',
  ASSET_CORRUPT: 'QC_ASSET_CORRUPT',
  ASSET_HASH_MISMATCH: 'QC_ASSET_HASH_MISMATCH',
  ASSET_NOT_VERIFIABLE: 'QC_ASSET_NOT_VERIFIABLE',
  LOCATION_EXIF_PRESENT: 'QC_LOCATION_EXIF_PRESENT',
  FORMAT_MISMATCH: 'QC_FORMAT_MISMATCH',
  DIMENSIONS_MISMATCH: 'QC_DIMENSIONS_MISMATCH',
  ACCIDENTAL_DUPLICATE: 'QC_ACCIDENTAL_DUPLICATE',
  INVALID_PAIR: 'QC_INVALID_PAIR',
  PROVENANCE_NOT_SELF_CONTAINED: 'QC_PROVENANCE_NOT_SELF_CONTAINED',
  MODEL_DERIVED_GROUND_TRUTH: 'QC_MODEL_DERIVED_GROUND_TRUTH',
  HOLDOUT_LEAKAGE: 'QC_HOLDOUT_LEAKAGE',
  PARTITION_DRIFT: 'QC_PARTITION_DRIFT',
  PRIVACY_VIOLATION: 'QC_PRIVACY_VIOLATION',
});

function finding(code, subject, message, severity = 'REJECT') {
  return { code, severity, ...subject, message };
}

/**
 * Run QC over a loaded corpus.
 *
 * @param {object} input  { config, garments, cases, garmentsById }
 * @param {object} options { env, assetRoot, requireAssets }
 *
 * `requireAssets` decides whether an unmountable asset store is a rejection
 * (true - a case cannot become VALID with unverified bytes) or a recorded
 * blocker (false - the default for metadata-only work such as reporting the
 * queue on a checkout with no mount).
 */
function runQc({ config, garments, cases, garmentsById }, options = {}) {
  const { requireAssets = true } = options;
  const findings = [];
  const holdoutFraction = config?.holdout?.fractionTarget ?? 0.25;

  /* ---------------- garment-level ---------------- */

  for (const garment of garments) {
    const schema = validateGarment(garment);
    if (!schema.valid) {
      for (const message of schema.errors) {
        const code = /privacy_violation/.test(message)
          ? QC_CODES.PRIVACY_VIOLATION
          : /model-derived|modelDerived/.test(message)
            ? QC_CODES.MODEL_DERIVED_GROUND_TRUTH
            : QC_CODES.SCHEMA_INVALID;
        findings.push(finding(code, { garmentId: garment.garmentId }, message));
      }
      continue;
    }

    const derived = deriveGrade(garment.groundTruth);
    if (derived.invalid) {
      for (const reason of derived.reasons) {
        findings.push(finding(QC_CODES.MODEL_DERIVED_GROUND_TRUTH, { garmentId: garment.garmentId }, reason));
      }
      continue;
    }

    // Provenance self-containment is only meaningful once there is evidence to
    // be self-contained. A VISUAL_ONLY garment is honestly labelled as having
    // none, and holding it to a link-rot standard would be nonsense.
    if (derived.grade !== 'VISUAL_ONLY') {
      const provenance = checkProvenanceSelfContained(garment);
      if (!provenance.selfContained) {
        for (const reason of provenance.reasons) {
          findings.push(
            finding(
              QC_CODES.PROVENANCE_NOT_SELF_CONTAINED,
              { garmentId: garment.garmentId },
              `${reason} (mission section 19: a retailer URL is supplementary evidence, never the only evidence)`,
            ),
          );
        }
      }
    }
  }

  /* ---------------- case-level ---------------- */

  for (const record of cases) {
    const schema = validateCase(record);
    if (!schema.valid) {
      for (const message of schema.errors) {
        const code = /privacy_violation/.test(message) ? QC_CODES.PRIVACY_VIOLATION : QC_CODES.SCHEMA_INVALID;
        findings.push(finding(code, { caseId: record.caseId }, message));
      }
      continue;
    }

    // Tier contamination: a procedurally generated asset in the real corpus.
    if (record.assetTier === ASSET_TIER_PIPELINE_TEST) {
      findings.push(
        finding(
          QC_CODES.TIER_CONTAMINATION,
          { caseId: record.caseId },
          `case ${record.caseId} is a ${ASSET_TIER_PIPELINE_TEST} but sits in the real corpus. Pipeline-test assets ` +
            'may never enter the real corpus, count toward corpus N, or appear in a real metric (mission section 26).',
        ),
      );
    }

    if (!garmentsById.has(record.garmentId)) {
      findings.push(
        finding(
          QC_CODES.ORPHAN_CASE,
          { caseId: record.caseId },
          `case references garment ${record.garmentId}, which is not in the corpus`,
        ),
      );
      continue;
    }

    // Partition drift: a record whose stored partition disagrees with the
    // deterministic assignment. Left unchecked, a hand-edited partition field
    // is how a holdout case quietly becomes a development case.
    const expected = assignPartition(record.garmentId, holdoutFraction);
    if (record.partition !== expected) {
      findings.push(
        finding(
          QC_CODES.PARTITION_DRIFT,
          { caseId: record.caseId },
          `case is stored as '${record.partition}' but the deterministic split assigns garment ${record.garmentId} ` +
            `to '${expected}'. Partition is derived, not chosen.`,
        ),
      );
    }
  }

  /* ---------------- holdout leakage ---------------- */

  // A holdout case must not also exist in the development partition, by id or
  // by asset hash. Either would mean the holdout answer is readable from
  // development, which defeats the seal without tripping any other check.
  const holdoutIdsSeen = new Set();
  for (const record of cases) {
    if (record.partition === 'holdout') {
      holdoutIdsSeen.add(record.caseId);
      findings.push(
        finding(
          QC_CODES.HOLDOUT_LEAKAGE,
          { caseId: record.caseId },
          `case ${record.caseId} is marked partition 'holdout' but is stored in the development corpus directory`,
        ),
      );
    }
  }

  /* ---------------- duplicates and pairs ---------------- */

  for (const duplicate of findDuplicateAssets(cases)) {
    findings.push(
      finding(
        QC_CODES.ACCIDENTAL_DUPLICATE,
        { caseIds: duplicate.caseIds },
        `${duplicate.caseIds.join(' and ')} share asset hash ${duplicate.sha256.slice(0, 12)}...: ${duplicate.reason}`,
      ),
    );
  }

  const pairs = validatePairs(cases);
  for (const invalid of pairs.invalid) {
    findings.push(finding(QC_CODES.INVALID_PAIR, { caseIds: invalid.caseIds }, invalid.reason));
  }

  /* ---------------- assets ---------------- */

  const realCases = cases.filter((record) => record.assetTier === ASSET_TIER_REAL);
  const assets = verifyAssets(realCases, options);

  if (!assets.mounted) {
    if (realCases.length > 0) {
      findings.push(
        finding(
          QC_CODES.ASSET_NOT_VERIFIABLE,
          { caseIds: realCases.map((r) => r.caseId) },
          `the asset store is not mounted (${assets.storageStatus}, looked in ${assets.root}), so ${realCases.length} ` +
            'real case asset(s) could not be verified. An unverifiable asset is not a verified one.',
          requireAssets ? 'REJECT' : 'BLOCKER',
        ),
      );
    }
  } else {
    const caseById = new Map(realCases.map((record) => [record.caseId, record]));
    for (const result of assets.results) {
      const record = caseById.get(result.caseId);
      const subject = { caseId: result.caseId };

      if (result.status === 'MISSING') {
        findings.push(finding(QC_CODES.ASSET_MISSING, subject, `asset file not found at ${result.assetPath}`));
        continue;
      }
      if (result.status === 'UNREADABLE' || result.status === 'PATH_ESCAPES_ROOT') {
        findings.push(finding(QC_CODES.ASSET_UNREADABLE, subject, `asset could not be read: ${result.status}`));
        continue;
      }

      if (result.hashMatches === false) {
        findings.push(
          finding(
            QC_CODES.ASSET_HASH_MISMATCH,
            subject,
            `recorded sha256 ${record.asset.sha256.slice(0, 12)}... does not match the file's actual ` +
              `${result.sha256.slice(0, 12)}... - the bytes changed after the record was written`,
          ),
        );
      }

      if (!result.integrity.readable) {
        findings.push(
          finding(QC_CODES.ASSET_CORRUPT, subject, `asset is not a structurally valid image: ${result.integrity.findings.join(', ')}`),
        );
      }

      if (result.metadata.locationPresent) {
        findings.push(
          finding(
            QC_CODES.LOCATION_EXIF_PRESENT,
            subject,
            `asset still carries location metadata via ${result.metadata.locationCarriers.join(', ')}. ` +
              'QC must reject an asset retaining location EXIF (mission section 17).',
          ),
        );
      }

      if (result.integrity.format && record.capture?.format && result.integrity.format !== record.capture.format) {
        findings.push(
          finding(
            QC_CODES.FORMAT_MISMATCH,
            subject,
            `record declares format '${record.capture.format}' but the file is '${result.integrity.format}'`,
          ),
        );
      }
    }
  }

  const rejections = findings.filter((f) => f.severity === 'REJECT');
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');

  const rejectedCaseIds = new Set();
  for (const item of rejections) {
    if (item.caseId) rejectedCaseIds.add(item.caseId);
    for (const id of item.caseIds || []) rejectedCaseIds.add(id);
    if (item.garmentId) {
      for (const record of cases) if (record.garmentId === item.garmentId) rejectedCaseIds.add(record.caseId);
    }
  }

  const validCases = cases.filter(
    (record) => record.assetTier === ASSET_TIER_REAL && !rejectedCaseIds.has(record.caseId),
  );

  return {
    qcPolicyVersion: QC_POLICY_VERSION,
    passed: rejections.length === 0,
    findings,
    rejections,
    blockers,
    assets,
    pairs,
    counts: {
      garments: garments.length,
      casesExamined: cases.length,
      realCases: realCases.length,
      pipelineTestAssetsFound: cases.length - realCases.length,
      validCases: validCases.length,
      rejectedCases: rejectedCaseIds.size,
      identityEligibleGarments: garments.filter((g) => evaluateIdentityEligibility(g).eligible).length,
    },
    validCaseIds: validCases.map((record) => record.caseId).sort(),
    rejectedCaseIds: [...rejectedCaseIds].sort(),
    holdoutIdsFoundInDevelopment: [...holdoutIdsSeen],
  };
}

module.exports = { runQc, QC_CODES, QC_POLICY_VERSION };
