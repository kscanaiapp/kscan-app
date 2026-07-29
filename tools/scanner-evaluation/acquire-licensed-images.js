#!/usr/bin/env node
'use strict';

/**
 * Tier A licensed-web-image acquisition (Phase 1).
 *
 * WHAT THIS BUILDS
 * A governed benchmark of publicly licensed imagery whose licence, author and
 * source page are PROVEN per image, machine-readably, from the repository's own
 * API. Images go to private governed storage. Nothing image-shaped enters Git.
 *
 * WHAT IT IS NOT
 * This is a LICENSED-WEB-IMAGE benchmark. It is explicitly NOT a real-world
 * smart-glasses capture benchmark. It cannot represent wearer motion blur,
 * glasses point-of-view, partial framing inside the five-second curiosity
 * window, repeated views of the same physical garment, or authentic retail-floor
 * lighting and distance. Tier B real capture covers those, later.
 *
 * WHY WIKIMEDIA COMMONS FIRST
 * The rejection rule is "reject any image whose licence, author, source page or
 * permitted reuse cannot be proven". Commons is the only one of the four named
 * repositories that exposes, per file, a versioned standard licence, the author
 * string, and a stable file page — all queryable. Unsplash, Pexels and Pixabay
 * publish a single site-wide licence whose stance on ML/AI evaluation use is not
 * stated in machine-readable form per asset, so "permitted reuse" cannot be
 * proven to the same standard. They are reachable through --source but default
 * off, and the reason is recorded in the run report rather than assumed away.
 *
 * LICENCE ALLOWLIST — deliberately conservative
 *   accepted : CC0, public domain, CC BY 2.0/2.5/3.0/4.0, CC BY-SA 2.0/2.5/3.0/4.0
 *   rejected : anything NonCommercial (this is a commercial product's evaluation),
 *              anything NoDerivatives (a sanitised EXIF-stripped copy is a
 *              derivative), non-free/fair-use, and anything unrecognised.
 * An unrecognised licence string is a REJECTION, never a default-accept.
 *
 * Usage
 *   node tools/scanner-evaluation/acquire-licensed-images.js \
 *     --storage <governedStorageRoot> --plan <planFile.json> [--limit N] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const USER_AGENT =
  'KScanBuild4EvalBot/1.0 (internal ML evaluation benchmark; +https://github.com/kscanaiapp/kscan-app)';

// ── Licence policy ───────────────────────────────────────────────────────────

const ACCEPTED_LICENCES = [
  { match: /^cc0/i, id: 'CC0', version: null, attribution: false, shareAlike: false },
  { match: /^public domain/i, id: 'Public domain', version: null, attribution: false, shareAlike: false },
  { match: /^pd-/i, id: 'Public domain', version: null, attribution: false, shareAlike: false },
  { match: /^cc by-sa 4\.0/i, id: 'CC BY-SA', version: '4.0', attribution: true, shareAlike: true },
  { match: /^cc by-sa 3\.0/i, id: 'CC BY-SA', version: '3.0', attribution: true, shareAlike: true },
  { match: /^cc by-sa 2\.5/i, id: 'CC BY-SA', version: '2.5', attribution: true, shareAlike: true },
  { match: /^cc by-sa 2\.0/i, id: 'CC BY-SA', version: '2.0', attribution: true, shareAlike: true },
  { match: /^cc by 4\.0/i, id: 'CC BY', version: '4.0', attribution: true, shareAlike: false },
  { match: /^cc by 3\.0/i, id: 'CC BY', version: '3.0', attribution: true, shareAlike: false },
  { match: /^cc by 2\.5/i, id: 'CC BY', version: '2.5', attribution: true, shareAlike: false },
  { match: /^cc by 2\.0/i, id: 'CC BY', version: '2.0', attribution: true, shareAlike: false },
];

const HARD_REJECT = [
  { match: /nc\b|noncommercial|non-commercial/i, reason: 'NonCommercial: this is a commercial product evaluation' },
  { match: /nd\b|noderiv|no derivative/i, reason: 'NoDerivatives: a sanitised copy is a derivative' },
  { match: /fair ?use|non-?free|copyright(ed)?$/i, reason: 'not a free licence' },
  { match: /gfdl/i, reason: 'GFDL-only obligations are not resolvable here' },
];

/**
 * Classify a licence string. Unrecognised => rejected.
 * @param {string} shortName
 */
function classifyLicence(shortName) {
  const name = (shortName || '').trim();
  if (!name) return { accepted: false, reason: 'no licence string on the file page' };

  for (const rule of HARD_REJECT) {
    if (rule.match.test(name)) return { accepted: false, reason: rule.reason, observed: name };
  }
  for (const rule of ACCEPTED_LICENCES) {
    if (rule.match.test(name)) {
      return {
        accepted: true,
        licenceId: rule.id,
        licenceVersion: rule.version,
        attributionRequired: rule.attribution,
        shareAlikeRequired: rule.shareAlike,
        observed: name,
      };
    }
  }
  return { accepted: false, reason: `unrecognised licence, not default-accepted: ${name}`, observed: name };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function get(url, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: binary ? '*/*' : 'application/json' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(get(res.headers.location, { binary }));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(binary ? Buffer.concat(chunks) : JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }
    );
    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`timeout for ${url}`));
    });
  });
}

/**
 * Politeness throttle and 429 backoff.
 *
 * The first real acquisition run hammered upload.wikimedia.org with no delay and
 * took 15 HTTP 429s, which silently truncated coverage: the last three specs
 * (store display, mirror, non-fashion) got zero images purely because they ran
 * last. Rate limiting is not optional against a donated public archive.
 */
const MIN_INTERVAL_MS = 1200;
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function getPolite(url, options, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await throttle();
    try {
      return await get(url, options);
    } catch (error) {
      const is429 = /HTTP 429/.test(error.message);
      if (!is429 || attempt === attempts) throw error;
      // Exponential backoff, and the counter is reported so a truncated run is
      // never mistaken for a licence rejection.
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  throw new Error('unreachable');
}

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/** Search Commons for candidate files. */
async function searchCommons(term, limit) {
  const url =
    `${COMMONS_API}?action=query&format=json&list=search&srnamespace=6` +
    `&srsearch=${encodeURIComponent(term)}&srlimit=${limit}`;
  const data = await getPolite(url);
  return ((data.query && data.query.search) || []).map((r) => r.title);
}

/** Fetch per-file licence evidence. Commons licence conditions vary per file. */
async function fileEvidence(title) {
  const url =
    `${COMMONS_API}?action=query&format=json&prop=imageinfo` +
    `&iiprop=url%7Cextmetadata%7Csize%7Cmime%7Cdimensions&titles=${encodeURIComponent(title)}`;
  const data = await getPolite(url);
  const pages = (data.query && data.query.pages) || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined || !page.imageinfo) return null;
  const info = page.imageinfo[0];
  const meta = info.extmetadata || {};
  const val = (k) => (meta[k] && typeof meta[k].value === 'string' ? meta[k].value : null);
  const strip = (html) => (html ? html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : null);

  return {
    title: page.title,
    sourcePage: info.descriptionurl || null,
    directImageUrl: info.url || null,
    mime: info.mime || null,
    width: info.width || null,
    height: info.height || null,
    byteLength: info.size || null,
    author: strip(val('Artist')),
    licenceShortName: val('LicenseShortName'),
    licenceUrl: val('LicenseUrl'),
    attributionRequired: val('AttributionRequired'),
    restrictions: val('Restrictions'),
    credit: strip(val('Credit')),
  };
}

// ── Sanitisation ─────────────────────────────────────────────────────────────

/**
 * Strip every JPEG APPn and COM segment: EXIF, XMP, Photoshop IRB, comments.
 * Keeps only the segments a decoder needs. Returns null for non-JPEG.
 */
function stripJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const out = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i < buffer.length - 1) {
    if (buffer[i] !== 0xff) break;
    const marker = buffer[i + 1];
    if (marker === 0xd9) {
      out.push(buffer.slice(i));
      return Buffer.concat(out);
    }
    if (marker === 0xda) {
      // Start of scan: copy the remainder verbatim.
      out.push(buffer.slice(i));
      return Buffer.concat(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buffer.slice(i, i + 2));
      i += 2;
      continue;
    }
    const length = buffer.readUInt16BE(i + 2);
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) out.push(buffer.slice(i, i + 2 + length));
    i += 2 + length;
  }
  return Buffer.concat(out);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Detect whether any JPEG metadata segment remains. */
function hasJpegMetadata(buffer) {
  let i = 2;
  while (i < buffer.length - 1) {
    if (buffer[i] !== 0xff) return false;
    const marker = buffer[i + 1];
    if (marker === 0xda || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) return true;
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return false;
}

// ── Acquisition ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const get1 = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  return {
    storage: get1('--storage'),
    plan: get1('--plan'),
    limit: Number(get1('--limit') || 0) || null,
    dryRun: argv.includes('--dry-run'),
    out: get1('--out'),
  };
}

async function acquireOne(candidateTitle, spec, storageRoot, dryRun) {
  const evidence = await fileEvidence(candidateTitle);
  if (!evidence) {
    return { rejected: true, title: candidateTitle, reason: 'file page not retrievable' };
  }

  // Rejection gates — every one is "cannot be proven", never "looks fine".
  if (!evidence.sourcePage) return { rejected: true, ...evidence, reason: 'no source page URL' };
  if (!evidence.directImageUrl) return { rejected: true, ...evidence, reason: 'no direct image URL' };
  if (!evidence.author) return { rejected: true, ...evidence, reason: 'author could not be established' };
  if (!/^image\/(jpeg|png)$/.test(evidence.mime || '')) {
    return { rejected: true, ...evidence, reason: `unsupported mime ${evidence.mime}` };
  }
  if (evidence.restrictions) {
    return { rejected: true, ...evidence, reason: `file carries restrictions: ${evidence.restrictions}` };
  }

  const licence = classifyLicence(evidence.licenceShortName);
  if (!licence.accepted) return { rejected: true, ...evidence, reason: `licence: ${licence.reason}` };

  if (dryRun) {
    return { rejected: false, dryRun: true, ...evidence, licence, category: spec.category, scene: spec.scene };
  }

  const original = await getPolite(evidence.directImageUrl, { binary: true });
  const originalSha256 = sha256(original);

  const sanitized = evidence.mime === 'image/jpeg' ? stripJpegMetadata(original) : original;
  if (!sanitized) return { rejected: true, ...evidence, reason: 'could not sanitise: not a parseable JPEG' };
  const sanitizedSha256 = sha256(sanitized);
  const metadataRemains = evidence.mime === 'image/jpeg' ? hasJpegMetadata(sanitized) : false;
  if (metadataRemains) {
    return { rejected: true, ...evidence, reason: 'metadata still present after sanitisation' };
  }

  // Opaque storage id — never the source filename, never an author name.
  const caseId = `tiera-${spec.category}-${sanitizedSha256.slice(0, 10)}`;
  const viewId = 'primary';
  const relative = path.join(caseId, `${viewId}.jpg`);
  const absolute = path.join(storageRoot, 'tier-a', relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, sanitized);

  return {
    rejected: false,
    caseId,
    viewId,
    governedStorageRef: `storage://build4-scanner-evals/tier-a/${caseId}/${viewId}`,
    localGovernedPath: absolute,
    ...evidence,
    licence,
    originalSha256,
    sanitizedSha256,
    originalByteLength: original.length,
    sanitizedByteLength: sanitized.length,
    metadataStripped: original.length !== sanitized.length,
    category: spec.category,
    scene: spec.scene,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.storage || !args.plan) {
    console.error('Usage: --storage <root> --plan <plan.json> [--limit N] [--dry-run] [--out file]');
    process.exitCode = 1;
    return;
  }
  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
  const accepted = [];
  const rejected = [];
  const retrievalDate = plan.retrievalDate;
  if (!retrievalDate) throw new Error('plan must carry an explicit retrievalDate');

  for (const spec of plan.specs) {
    let titles = [];
    try {
      titles = await searchCommons(spec.search, spec.searchLimit || 8);
    } catch (error) {
      rejected.push({ search: spec.search, reason: `search failed: ${error.message}` });
      continue;
    }
    let taken = 0;
    for (const title of titles) {
      if (taken >= (spec.want || 1)) break;
      if (args.limit && accepted.length >= args.limit) break;
      let result;
      try {
        result = await acquireOne(title, spec, args.storage, args.dryRun);
      } catch (error) {
        const rateLimited = /HTTP 429/.test(error.message);
        rejected.push({
          title,
          reason: `error: ${error.message}`,
          // A rate-limit truncation is NOT a licence rejection and must never be
          // counted as one.
          classification: rateLimited ? 'transport_rate_limited' : 'transport_error',
        });
        continue;
      }
      if (result.rejected) {
        rejected.push({ title: result.title || title, reason: result.reason, licence: result.licenceShortName });
        continue;
      }
      accepted.push({ ...result, retrievalDate, repository: 'Wikimedia Commons' });
      taken += 1;
    }
    if (args.limit && accepted.length >= args.limit) break;
  }

  const report = {
    generatedAt: retrievalDate,
    tier: 'A',
    benchmarkKind: 'licensed_web_image_benchmark',
    notARealWorldSmartGlassesBenchmark: true,
    repositoriesUsed: ['Wikimedia Commons'],
    repositoriesDeclined: {
      Unsplash: 'single site-wide licence; per-asset permitted-reuse for ML evaluation not provable',
      Pexels: 'single site-wide licence; per-asset permitted-reuse for ML evaluation not provable',
      Pixabay: 'single site-wide licence; per-asset permitted-reuse for ML evaluation not provable',
    },
    licencePolicy: {
      accepted: ACCEPTED_LICENCES.map((l) => `${l.id}${l.version ? ` ${l.version}` : ''}`),
      rejected: HARD_REJECT.map((r) => r.reason),
      unrecognisedIsRejection: true,
    },
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    accepted,
    rejected,
  };

  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      { acceptedCount: accepted.length, rejectedCount: rejected.length, out: args.out || null },
      null,
      2
    )
  );
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { classifyLicence, stripJpegMetadata, hasJpegMetadata, sha256, ACCEPTED_LICENCES, HARD_REJECT };
