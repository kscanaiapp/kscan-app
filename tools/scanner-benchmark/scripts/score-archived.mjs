#!/usr/bin/env node
// Score archived Build 35 scanner-live-certification evidence with the Build 42
// metrics. Usage: node score-archived.mjs <report.json> <corpus.json> [label]
import fs from 'node:fs';
import { adaptArchivedReport } from '../adapters/archivedLiveCertification.mjs';
import { computeMetrics } from '../lib/metrics.mjs';
const [reportPath, corpusPath, label] = process.argv.slice(2);
if (!reportPath || !corpusPath) { console.error('usage: score-archived.mjs <report.json> <corpus.json> [label]'); process.exit(64); }
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const { cases, results } = adaptArchivedReport(report, corpus, { runLabel: label });
const metrics = computeMetrics(cases, results);
console.log(JSON.stringify({ source: { report: reportPath.split(/[\/]/).slice(-1)[0], generatedAt: report.generatedAt, runId: report.source?.runId ?? null, phase: report.phase }, caseCount: cases.length, metrics }, null, 2));
