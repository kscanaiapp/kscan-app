/**
 * VRI-03 failure-set manifest gate (Phase A condition (a)).
 *
 * Validates an owner-supplied manifest against docs/vri-03/failure-set-spec.md
 * and the collection kit. It never invents ground truth: an item with no
 * human-recorded Google evidence or fewer than two reviewers is rejected.
 *
 * Privacy: any identifier-shaped key or value anywhere in the manifest fails
 * the gate, so a manifest that passes is safe to commit as a PR artifact.
 *
 * Offline and pure.
 */

export const VRI03_MIN_ITEMS = 15;
export const VRI03_MAX_ITEMS = 30;
export const VRI03_TARGET_PER_STRATUM = 8;

export const SCENES = ['single_object', 'multi_object'] as const;
export const TYPES = ['garment', 'accessory'] as const;
export const MATCH_LABELS = ['exact_match', 'visually_similar_acceptable', 'wrong_category', 'no_result'] as const;

const FORBIDDEN_KEY_RE =
  /^(user_?id|actor_?id|uid|email|e_?mail|phone|name|full_?name|exif|gps|lat|latitude|lon|lng|longitude|location|file_?path|local_?path|path|filename|file_?name|device(_?name|_?id)?|signed_?url|face|faces|ip|ip_?address)$/i;

const FORBIDDEN_VALUE_PATTERNS: readonly [string, RegExp][] = [
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['windows path', /\b[A-Z]:\\/i],
  ['posix home path', /(^|\s)\/(Users|home)\//],
  ['signed URL', /[?&](X-Amz-Signature|token|sig|signature|Expires)=/i],
  ['image bytes', /^data:image\//i],
];

export type GateIssue = { path: string; problem: string };

export type ManifestGateResult = {
  pass: boolean;
  itemCount: number;
  validItemCount: number;
  issues: GateIssue[];
  strata: {
    scene: Record<string, number>;
    type: Record<string, number>;
    underpowered: string[];
  };
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function scanForIdentifiers(value: unknown, path: string, issues: GateIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForIdentifiers(v, `${path}[${i}]`, issues));
    return;
  }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY_RE.test(k)) issues.push({ path: `${path}.${k}`, problem: 'identifier-shaped key is not allowed' });
      scanForIdentifiers(v, `${path}.${k}`, issues);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const [label, re] of FORBIDDEN_VALUE_PATTERNS) {
      if (re.test(value)) issues.push({ path, problem: `value looks like a ${label}` });
    }
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ITEM_ID = /^vri03-\d{4}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

function validateItem(item: unknown, i: number, issues: GateIssue[], seenIds: Set<string>, seenDigests: Set<string>): boolean {
  const p = `items[${i}]`;
  const before = issues.length;
  if (!isObj(item)) {
    issues.push({ path: p, problem: 'item must be an object' });
    return false;
  }
  const id = str(item.itemId);
  if (!ITEM_ID.test(id)) issues.push({ path: `${p}.itemId`, problem: 'must match vri03-NNNN' });
  else if (seenIds.has(id)) issues.push({ path: `${p}.itemId`, problem: 'duplicate itemId' });
  else seenIds.add(id);

  const digest = str(item.imageDigest);
  if (!DIGEST.test(digest)) issues.push({ path: `${p}.imageDigest`, problem: 'must be sha256:<64 hex>' });
  else if (seenDigests.has(digest)) issues.push({ path: `${p}.imageDigest`, problem: 'duplicate image' });
  else seenDigests.add(digest);

  const consent = item.consent;
  if (!isObj(consent) || !str(consent.policyId) || !str(consent.evidenceId) || !ISO_DATE.test(str(consent.consentedAt))) {
    issues.push({ path: `${p}.consent`, problem: 'requires policyId, evidenceId and consentedAt (YYYY-MM-DD)' });
  }

  const strata = item.strata;
  if (!isObj(strata)) issues.push({ path: `${p}.strata`, problem: 'missing' });
  else {
    if (!(SCENES as readonly string[]).includes(str(strata.scene))) issues.push({ path: `${p}.strata.scene`, problem: `one of ${SCENES.join('|')}` });
    if (!(TYPES as readonly string[]).includes(str(strata.type))) issues.push({ path: `${p}.strata.type`, problem: `one of ${TYPES.join('|')}` });
    if (typeof strata.brandVisible !== 'boolean') issues.push({ path: `${p}.strata.brandVisible`, problem: 'boolean required' });
    if (!['yes', 'no', 'unknown'].includes(str(strata.blackOwnedRelevance))) {
      issues.push({ path: `${p}.strata.blackOwnedRelevance`, problem: 'yes|no|unknown' });
    }
    if (str(strata.scene) === 'multi_object' && !str(item.targetDescription)) {
      issues.push({ path: `${p}.targetDescription`, problem: 'multi_object items must name the target garment (e.g. "the red bag, lower left")' });
    }
  }

  // Ground truth is human-recorded Google evidence. It is never inferred.
  const g = item.googleEvidence;
  if (!isObj(g)) issues.push({ path: `${p}.googleEvidence`, problem: 'missing — a human must record what Google surfaced' });
  else {
    if (!DOMAIN.test(str(g.retailerDomain))) issues.push({ path: `${p}.googleEvidence.retailerDomain`, problem: 'bare domain required' });
    if (str(g.productTitle).length < 4) issues.push({ path: `${p}.googleEvidence.productTitle`, problem: 'required' });
    if (!ISO_DATE.test(str(g.capturedAt))) issues.push({ path: `${p}.googleEvidence.capturedAt`, problem: 'YYYY-MM-DD' });
    if (!/^[A-Z]{2}$/.test(str(g.market))) issues.push({ path: `${p}.googleEvidence.market`, problem: 'ISO country code' });
    if (g.purchasable !== true) issues.push({ path: `${p}.googleEvidence.purchasable`, problem: 'must be true (in stock, product-level page)' });
  }

  const truth = item.groundTruth;
  if (!isObj(truth)) issues.push({ path: `${p}.groundTruth`, problem: 'missing' });
  else {
    if (!str(truth.category) || !str(truth.subtype)) issues.push({ path: `${p}.groundTruth`, problem: 'category and subtype required' });
    if (typeof truth.reviewers !== 'number' || truth.reviewers < 2) issues.push({ path: `${p}.groundTruth.reviewers`, problem: 'two reviewers required' });
  }

  return issues.length === before;
}

export function evaluateManifestGate(manifest: unknown): ManifestGateResult {
  const issues: GateIssue[] = [];
  const scene: Record<string, number> = Object.fromEntries(SCENES.map((s) => [s, 0]));
  const type: Record<string, number> = Object.fromEntries(TYPES.map((t) => [t, 0]));
  if (!isObj(manifest) || !Array.isArray(manifest.items)) {
    return { pass: false, itemCount: 0, validItemCount: 0, issues: [{ path: '$', problem: 'manifest with items[] required' }], strata: { scene, type, underpowered: [...SCENES, ...TYPES] } };
  }
  scanForIdentifiers(manifest, '$', issues);

  const seenIds = new Set<string>();
  const seenDigests = new Set<string>();
  let valid = 0;
  manifest.items.forEach((item, i) => {
    if (validateItem(item, i, issues, seenIds, seenDigests)) {
      valid++;
      const s = (item as Record<string, Record<string, unknown>>).strata;
      scene[str(s.scene)]++;
      type[str(s.type)]++;
    }
  });

  const n = manifest.items.length;
  if (valid < VRI03_MIN_ITEMS) issues.push({ path: '$.items', problem: `need ≥${VRI03_MIN_ITEMS} valid items, have ${valid}` });
  if (n > VRI03_MAX_ITEMS) issues.push({ path: '$.items', problem: `at most ${VRI03_MAX_ITEMS} items` });
  for (const [dim, counts] of [['scene', scene], ['type', type]] as const) {
    for (const [k, c] of Object.entries(counts)) if (c === 0) issues.push({ path: `$.strata.${dim}`, problem: `no valid ${k} item` });
  }
  const underpowered = [...Object.entries(scene), ...Object.entries(type)].filter(([, c]) => c < VRI03_TARGET_PER_STRATUM).map(([k]) => k);

  return { pass: issues.length === 0, itemCount: n, validItemCount: valid, issues, strata: { scene, type, underpowered } };
}
