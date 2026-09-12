'use strict';

/**
 * CANDIDATE UNIVERSE IDENTITY (spec section 8).
 *
 * "The candidate universe must be identical. Produce a deterministic
 *  candidate-set fingerprint... CONTROL_UNIVERSE_HASH / CHALLENGER_UNIVERSE_HASH
 *  ... They must match. If they do not: the comparison is invalid until repaired."
 *
 * The entire experiment rests on one claim: control and challenger saw the
 * SAME candidates and differ only in the ORDER they put them in. That claim is
 * easy to break by accident - a re-ranker that silently drops a candidate with
 * no usable image, or one that de-duplicates, or one that truncates to topK,
 * would produce a flattering comparison against a different, easier universe.
 * A reader cannot detect that from the metrics; the numbers look fine.
 *
 * So the universe is fingerprinted independently on both arms and the two
 * hashes are compared. The fingerprint is deliberately ORDER-INDEPENDENT:
 * candidate entries are canonicalised and sorted by candidateId before
 * hashing. That is the whole point - if ordering changed the hash, the two
 * arms could never match and the check would be useless. What the hash is
 * sensitive to is MEMBERSHIP and CONTENT:
 *
 *   - candidateId              (which products)
 *   - imageIdentity.sha256     (which image bytes were actually embedded)
 *   - the fashion attributes FMQ scores against (category, color, silhouette,
 *     material, pattern) plus the two fields FMQ hard-gates on (purchaseUrl
 *     presence, availability) - so a universe whose attributes were quietly
 *     rewritten between arms is caught too, not just one missing a product.
 *
 * Only `null` is used for absent values, never `undefined`, because
 * JSON.stringify drops undefined keys and would make two materially different
 * candidate sets hash identically.
 */

const crypto = require('node:crypto');

const UNIVERSE_FINGERPRINT_VERSION = 'candidate-universe-fingerprint-v1';

/** Normalise one candidate into exactly the fields the fingerprint covers. */
function canonicaliseCandidate(candidate, imageIdentity) {
  return {
    candidateId: candidate.id ?? null,
    imageSha256: imageIdentity?.sha256 ?? null,
    imageSourceRef: candidate.imageUrl ?? null,
    identitySku: candidate.identitySku ?? null,
    category: candidate.canonical_category ?? candidate.category ?? null,
    color: candidate.color_normalized ?? candidate.color ?? null,
    silhouette: candidate.silhouette ?? null,
    material: candidate.material ?? null,
    pattern: candidate.pattern ?? null,
    // FMQ's substitute axis hard-gates on these two; a universe that differed
    // only here would change scores without changing any visual attribute.
    hasPurchasePath: Boolean(candidate.purchaseUrl),
    availability: candidate.availability ?? null,
  };
}

/**
 * Fingerprint a candidate set.
 *
 * @param {Array<{candidate: object, imageIdentity?: {sha256?: string}}>} entries
 * @returns {{hash:string, version:string, memberCount:number, members:string[]}}
 */
function fingerprintUniverse(entries) {
  const canonical = entries
    .map((e) => canonicaliseCandidate(e.candidate, e.imageIdentity))
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));

  const duplicateIds = canonical
    .map((c) => c.candidateId)
    .filter((id, i, arr) => arr.indexOf(id) !== i);
  if (duplicateIds.length > 0) {
    throw new Error(`CANDIDATE_UNIVERSE_INVALID: duplicate candidateId(s) in one universe: ${[...new Set(duplicateIds)].join(', ')}`);
  }

  const payload = JSON.stringify({ version: UNIVERSE_FINGERPRINT_VERSION, candidates: canonical });
  return {
    hash: crypto.createHash('sha256').update(payload).digest('hex'),
    version: UNIVERSE_FINGERPRINT_VERSION,
    memberCount: canonical.length,
    members: canonical.map((c) => c.candidateId),
  };
}

/**
 * Prove two ranked orderings are permutations of the same universe.
 *
 * This is the check that makes the paired experiment valid. It is separate
 * from the hash on purpose: the hash proves both arms were HANDED the same
 * set, this proves each arm RETURNED that same set rather than dropping,
 * adding, or duplicating members along the way.
 *
 * @returns {{identical:boolean, reasons:string[]}}
 */
function assertSameUniverse(controlFingerprint, challengerFingerprint, controlOrder, challengerOrder) {
  const reasons = [];

  if (controlFingerprint.hash !== challengerFingerprint.hash) {
    reasons.push(
      `UNIVERSE_HASH_MISMATCH: control=${controlFingerprint.hash.slice(0, 16)}… challenger=${challengerFingerprint.hash.slice(0, 16)}…`,
    );
  }

  const sortedControl = [...controlOrder].sort();
  const sortedChallenger = [...challengerOrder].sort();

  if (controlOrder.length !== challengerOrder.length) {
    reasons.push(`ORDER_LENGTH_MISMATCH: control returned ${controlOrder.length}, challenger returned ${challengerOrder.length}`);
  }
  if (JSON.stringify(sortedControl) !== JSON.stringify(sortedChallenger)) {
    const controlSet = new Set(sortedControl);
    const challengerSet = new Set(sortedChallenger);
    const onlyControl = sortedControl.filter((id) => !challengerSet.has(id));
    const onlyChallenger = sortedChallenger.filter((id) => !controlSet.has(id));
    if (onlyControl.length) reasons.push(`DROPPED_BY_CHALLENGER: ${onlyControl.join(', ')}`);
    if (onlyChallenger.length) reasons.push(`ADDED_BY_CHALLENGER: ${onlyChallenger.join(', ')}`);
  }

  return { identical: reasons.length === 0, reasons };
}

module.exports = {
  UNIVERSE_FINGERPRINT_VERSION,
  canonicaliseCandidate,
  fingerprintUniverse,
  assertSameUniverse,
};
