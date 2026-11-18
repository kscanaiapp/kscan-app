#!/usr/bin/env node
// Build manifest/cases.v1.json from manifest/candidates.v1.json + manifest/curation.v1.json.
//
//   node build-manifest.mjs <asset-root>
//
// The asset root must hold the fetched thumbnails named <candidateId>.jpg (or already-renamed
// <caseId>.jpg); their SHA-256 is recorded so fetch-assets.mjs can verify a reproduction.
// Splits are deterministic: exact_known holds out whole product families listed in
// curation.holdoutFamilies; every other source case is held out when the first byte of
// sha256(caseId) mod 5 == 0. Derived cases inherit their parent's split and labels.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateManifest, summarizeManifest } from '../lib/manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'manifest');
const assetRoot = process.argv[2];
if (!assetRoot) { console.error('usage: build-manifest.mjs <asset-root>'); process.exit(64); }
const candidates = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.v1.json'), 'utf8')).candidates;
const curation = JSON.parse(fs.readFileSync(path.join(dir, 'curation.v1.json'), 'utf8'));
const byCand = new Map(candidates.map((c) => [c.candidateId, c]));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHORT = { exact_known: 'ex', unknown_generic: 'gen', logo_visible: 'logo', texture_pattern: 'tex', multi_item: 'multi', non_fashion: 'nf', difficult: 'dif' };

function fetchUrlFor(c) {
  const m = c.originalUrl.match(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/(.)\/(..)\/(.+)$/);
  const width = c.originalWidth >= 960 ? 960 : 500;
  return { url: `${m[1]}/thumb/${m[2]}/${m[3]}/${m[4]}/${width}px-${m[4]}`, width };
}

const cases = [];
const sourceById = new Map();
for (const d of curation.decisions) {
  if (!d.keep) continue;
  const c = byCand.get(d.candidateId);
  if (!c) throw new Error(`unknown candidate ${d.candidateId}`);
  const file = path.join(assetRoot, `${d.candidateId}.jpg`);
  const bytes = fs.readFileSync(file);
  const digest = sha(bytes);
  const stratum = d.stratum;
  const family = d.family ?? null;
  const caseId = `b42-${SHORT[stratum]}-${digest.slice(0, 10)}`;
  const holdout = stratum === 'exact_known'
    ? (curation.holdoutFamilies ?? []).includes(family)
    : crypto.createHash('sha256').update(caseId).digest()[0] % 5 === 0;
  const fam = family ? curation.families[family] : null;
  const labels = {
    nonFashion: d.category === 'non_fashion',
    category: d.category,
    subtypeTerms: d.subtypeTerms ?? [],
    colorTerms: d.colorTerms ?? [],
    rejectTerms: d.rejectTerms ?? [],
    pattern: d.pattern ?? null,
    brand: d.brand ?? (fam ? { visible: d.brandVisible === true, name: fam.brand, aliases: fam.brandAliases ?? [] } : { visible: false, name: null }),
    exactProduct: stratum === 'exact_known' && fam
      ? { knowable: true, brand: fam.brand, brandAliases: fam.brandAliases ?? [], model: fam.model, modelAliases: fam.modelAliases, family }
      : { knowable: false },
    ...(d.garments ? { garments: d.garments } : {}),
  };
  const kase = {
    caseId, stratum, split: holdout ? 'holdout' : 'development',
    labels,
    labelSources: d.labelSources ?? ['commons_category', 'agent_visual_review'],
    difficulty: d.difficulty ?? [],
    visiblePerson: d.visiblePerson ?? 'none',
    notes: d.notes ?? null,
    source: {
      kind: 'commons', commonsCategory: c.commonsCategory, title: c.title, filePage: c.filePage,
      author: c.author, licence: c.licence, licenceUrl: c.licenceUrl, originalSha1: c.originalSha1,
      fetchUrl: fetchUrlFor(c).url, fetchWidth: fetchUrlFor(c).width, sha256: digest,
    },
  };
  cases.push(kase);
  sourceById.set(d.candidateId, kase);
}

for (const v of curation.derived ?? []) {
  const parent = sourceById.get(v.fromCandidate);
  if (!parent) throw new Error(`derived parent ${v.fromCandidate} not kept`);
  cases.push({
    caseId: `b42-dif-${v.transform.replace(/_/g, '')}-${parent.caseId.split('-').pop()}`,
    stratum: 'difficult', split: parent.split,
    // Item identity is inherited; brand legibility is a property of the image, so it is unknown here.
    labels: { ...parent.labels, brand: { ...parent.labels.brand, visible: null } },
    labelSources: ['inherited_from_parent'], difficulty: [v.transform],
    visiblePerson: parent.visiblePerson, notes: `derived from ${parent.caseId}`,
    source: { kind: 'derived', derivedFrom: parent.caseId, transform: v.transform },
  });
}

const manifest = {
  version: 'cases.v1',
  generatedAt: new Date().toISOString().slice(0, 10),
  description: 'Build 42 Scanner benchmark. Images are not committed; see README for fetch and derive.',
  labelPolicy: curation.labelPolicy,
  cases,
};
const errors = validateManifest(manifest);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
fs.writeFileSync(path.join(dir, 'cases.v1.json'), JSON.stringify(manifest, null, 1) + '\n');
// Rename fetched files to case ids so fetch-assets/derive-variants find them.
for (const [candId, k] of sourceById) fs.copyFileSync(path.join(assetRoot, `${candId}.jpg`), path.join(assetRoot, `${k.caseId}.jpg`));
console.log(JSON.stringify(summarizeManifest(manifest), null, 1));
