#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildAdjudicationPacket } = require('./lib/adjudicationPacket');
const { validateReviewSubmission } = require('./lib/reviewValidation');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath);
  return { raw, value: JSON.parse(raw.toString('utf8')) };
}

const brief = readJson(arg('--brief')).value;
const a = readJson(arg('--review-a'));
const b = readJson(arg('--review-b'));
const lockA = readJson(arg('--lock-a')).value;
const lockB = readJson(arg('--lock-b')).value;
const outputDir = arg('--output-dir');
if (fs.existsSync(outputDir)) throw new Error(`Refusing to overwrite existing adjudication packet: ${outputDir}`);

const validationA = validateReviewSubmission(a.value, brief, { expectedRole: 'A' });
const validationB = validateReviewSubmission(b.value, brief, { expectedRole: 'B' });
if (!validationA.ok || !validationB.ok) {
  throw new Error(`Cannot adjudicate invalid reviews: ${JSON.stringify({ A: validationA.errors, B: validationB.errors })}`);
}

const packet = buildAdjudicationPacket({
  brief,
  reviewA: validationA.normalized,
  reviewB: validationB.normalized,
  lockA,
  lockB,
  rawA: a.raw,
  rawB: b.raw,
});

fs.mkdirSync(path.join(outputDir, 'images'), { recursive: true });
for (const reviewCase of packet.cases) {
  for (const image of reviewCase.images) {
    const extension = path.extname(image.sourcePath).toLowerCase();
    const destination = path.join(outputDir, 'images', `${image.blindImageId}${extension}`);
    fs.copyFileSync(image.sourcePath, destination);
    image.path = destination;
    delete image.sourcePath;
  }
}
const outputPath = path.join(outputDir, 'adjudication-brief.json');
fs.writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${outputPath}\n`);
