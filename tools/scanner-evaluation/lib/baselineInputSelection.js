'use strict';

/**
 * Baseline input selection — Multi-Image Path B.
 *
 * WHY A SELECTION RULE IS NEEDED AT ALL
 * Certified v140 accepts exactly ONE evidence entry per request and rejects more
 * with `too_many_evidence_entries`. It has no case-level multi-image
 * reconciliation. Ten governed cases carry 2-3 images of one physical item, so
 * something must decide which single image represents the case.
 *
 * WHY NOT RECONCILE
 * Calling every image and combining the outputs — averaging, best-of, worst-of,
 * or any post-hoc merge — would be an evaluation-only reconciliation that
 * certified v140 does not perform. The measured number would then describe the
 * harness, not the production scanner. It is forbidden.
 *
 * WHY ONE IMAGE PER CASE IS THE RIGHT SHAPE
 * It is the production shape. A user scanning a garment sends one photo, and the
 * certified backend accepts one. Evaluating one image per case is therefore
 * representative of production; evaluating the best of three would not be.
 *
 * THE RULE
 * Take the FIRST image reference in the already-frozen manifest order.
 *
 * HONEST LIMITATION
 * No governed primary-image designation exists anywhere in the dataset. The only
 * "primary" in the manifest is `primaryColor` (a colour label) and a storage
 * filename that is identical for every image in a set. There is no `angleHint`,
 * no ordering role, and no rule in the labeling guide or review artifacts. So
 * position 0 is deterministic and output-independent, but it is ARBITRARY: it is
 * not a semantic judgment that this view best represents the item. That
 * limitation is recorded in the artifact rather than papered over.
 *
 * WHAT THE RULE MAY NOT DO
 * It may not inspect provider output, candidate output, filenames carrying
 * product or brand clues, retailer provenance, hidden labels, or holdout
 * answers. It reads position only.
 */

const crypto = require('crypto');

const SELECTION_CONTRACT_VERSION = '1.0.0';
const RULE_ID = 'first_image_reference_in_frozen_manifest_order';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Select the single governed provider input for one case.
 *
 * Position only. The case record's labels are never consulted.
 */
function selectForCase(caseRecord) {
  const refs = caseRecord.imageReferences;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error(`case ${caseRecord.caseId} has no image references`);
  }
  if (refs.length !== caseRecord.imageCount) {
    throw new Error(`case ${caseRecord.caseId} imageCount disagrees with imageReferences`);
  }
  return {
    caseId: caseRecord.caseId,
    imageCount: caseRecord.imageCount,
    multiImage: caseRecord.imageCount > 1,
    selectedIndex: 0,
    selectedRef: refs[0].refValue,
    selectedHash: caseRecord.imageHashes[0],
    // Retained as provenance. NOT executed, NOT scored, NOT discarded.
    nonExecutedRefs: refs.slice(1).map((r, i) => ({
      index: i + 1,
      refValue: r.refValue,
      sha256: caseRecord.imageHashes[i + 1],
    })),
  };
}

/** Build the full selection set for a governed manifest. */
function buildSelection(manifest) {
  const selections = manifest.cases.map(selectForCase);
  const canonical = JSON.stringify(
    selections
      .map((s) => ({ caseId: s.caseId, selectedIndex: s.selectedIndex, selectedHash: s.selectedHash }))
      .sort((a, b) => a.caseId.localeCompare(b.caseId))
  );
  return { selections, selectionSetSha256: sha256Hex(canonical) };
}

/**
 * Build the immutable artifact that must be frozen BEFORE any provider call,
 * including the one-request smoke. The smoke and the full baseline must use the
 * identical rule, which this artifact pins.
 */
function buildArtifact(manifest, { manifestSha256 }) {
  const { selections, selectionSetSha256 } = buildSelection(manifest);
  const multiImage = selections.filter((s) => s.multiImage);

  const body = {
    selectionContractVersion: SELECTION_CONTRACT_VERSION,
    datasetVersion: manifest.datasetVersion,
    manifestSha256,
    rule: RULE_ID,
    ruleDescription:
      'Take the first image reference in the already-frozen manifest order. Position only; no label, output, filename, provenance or holdout answer is consulted.',
    outputIndependent: true,
    frozenBeforeSmoke: true,
    multiImagePath: 'B',
    selectedInputCount: selections.length,
    multiImageCaseCount: multiImage.length,
    nonExecutedProvenanceImageCount: selections.reduce((a, s) => a + s.nonExecutedRefs.length, 0),
    certifiedConstraint:
      'Certified v140 accepts exactly one evidence entry per request and performs no case-level multi-image reconciliation.',
    limitation:
      'No governed primary-image designation exists in the dataset, so position 0 is deterministic but ARBITRARY. It is not a semantic judgment that this view best represents the item.',
    evaluationOnlyReconciliation: false,
    selectionSetSha256,
    selections: selections
      .slice()
      .sort((a, b) => a.caseId.localeCompare(b.caseId))
      .map((s) => ({
        caseId: s.caseId,
        imageCount: s.imageCount,
        selectedIndex: s.selectedIndex,
        selectedRef: s.selectedRef,
        selectedHash: s.selectedHash,
        nonExecutedRefs: s.nonExecutedRefs,
      })),
  };

  // The contract hash covers the rule and the resulting selection set, so a
  // changed rule or a changed manifest produces a different hash.
  body.selectionContractSha256 = sha256Hex(
    JSON.stringify({
      selectionContractVersion: body.selectionContractVersion,
      datasetVersion: body.datasetVersion,
      manifestSha256: body.manifestSha256,
      rule: body.rule,
      selectionSetSha256: body.selectionSetSha256,
    })
  );
  return body;
}

/**
 * Verify a frozen artifact against the governed manifest.
 *
 * Called before every provider call. A drifted artifact must stop execution
 * rather than let the smoke and the baseline diverge.
 */
function verifyArtifact(artifact, manifest, { manifestSha256 } = {}) {
  const errors = [];

  if (artifact.selectionContractVersion !== SELECTION_CONTRACT_VERSION) {
    errors.push({ check: 'contract_version', message: 'selection contract version differs' });
  }
  if (artifact.datasetVersion !== manifest.datasetVersion) {
    errors.push({ check: 'dataset_version', message: 'selection artifact dataset version differs from the manifest' });
  }
  if (manifestSha256 && artifact.manifestSha256 !== manifestSha256) {
    errors.push({ check: 'manifest_hash', message: 'selection artifact was frozen against a different manifest' });
  }
  if (artifact.rule !== RULE_ID) {
    errors.push({ check: 'rule', message: 'selection rule differs' });
  }
  if (artifact.outputIndependent !== true || artifact.evaluationOnlyReconciliation !== false) {
    errors.push({ check: 'rule_properties', message: 'artifact does not assert an output-independent, non-reconciling rule' });
  }

  const rebuilt = buildSelection(manifest);
  if (rebuilt.selectionSetSha256 !== artifact.selectionSetSha256) {
    errors.push({ check: 'selection_set', message: 'recomputed selection set does not match the frozen artifact' });
  }
  const expectedContractSha256 = sha256Hex(
    JSON.stringify({
      selectionContractVersion: artifact.selectionContractVersion,
      datasetVersion: artifact.datasetVersion,
      manifestSha256: artifact.manifestSha256,
      rule: artifact.rule,
      selectionSetSha256: artifact.selectionSetSha256,
    })
  );
  if (artifact.selectionContractSha256 !== expectedContractSha256) {
    errors.push({ check: 'contract_hash', message: 'selection contract hash does not reproduce' });
  }
  if (artifact.selectedInputCount !== manifest.cases.length) {
    errors.push({ check: 'input_count', message: 'selected input count is not one per governed case' });
  }

  // One case, one provider input, one score record.
  const ids = new Set(artifact.selections.map((s) => s.caseId));
  if (ids.size !== artifact.selections.length) {
    errors.push({ check: 'duplicate_case', message: 'a case appears more than once in the selection set' });
  }
  const expectedByCase = new Map(rebuilt.selections.map((s) => [s.caseId, s]));
  for (const s of artifact.selections) {
    const expected = expectedByCase.get(s.caseId);
    if (!expected) {
      errors.push({ check: 'unknown_case', case: s.caseId, message: 'selection contains a case outside the governed manifest' });
      continue;
    }
    if (s.selectedIndex !== 0) {
      errors.push({ check: 'rule_applied', case: s.caseId, message: 'selected index is not the frozen manifest first position' });
    }
    if (s.selectedRef !== expected.selectedRef || s.selectedHash !== expected.selectedHash) {
      errors.push({ check: 'selected_input', case: s.caseId, message: 'selected reference or hash differs from the frozen manifest first position' });
    }
    if (JSON.stringify(s.nonExecutedRefs) !== JSON.stringify(expected.nonExecutedRefs)) {
      errors.push({ check: 'provenance_only_inputs', case: s.caseId, message: 'non-selected provenance inputs differ from the governed manifest' });
    }
  }

  return { ok: errors.length === 0, errors, selectionContractSha256: artifact.selectionContractSha256 };
}

module.exports = {
  SELECTION_CONTRACT_VERSION,
  RULE_ID,
  selectForCase,
  buildSelection,
  buildArtifact,
  verifyArtifact,
  sha256Hex,
};
