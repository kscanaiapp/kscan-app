#!/usr/bin/env node
'use strict';

/**
 * Writes a standardized scanner summary to GITHUB_STEP_SUMMARY and an optional file.
 * Node built-ins only.
 *
 * Env:
 *   SCANNER_NAME (required)
 *   SCANNER_VERSION
 *   START_TIME
 *   END_TIME
 *   FINDING_COUNTS (JSON object string, e.g. {"critical":0,"high":1})
 *   REPORT_ONLY_VERDICT (e.g. FINDINGS_REPORTED | NO_FINDINGS | OPERATIONAL_FAILURE | SKIPPED)
 *   SUMMARY_FILE (optional path to also write markdown)
 *   EXTRA_NOTES (optional free text)
 */

const fs = require('node:fs');

function env(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function main() {
  const scannerName = env('SCANNER_NAME');
  if (!scannerName) {
    console.error('SCANNER_NAME is required');
    process.exit(1);
  }

  let findingCounts = {};
  const rawCounts = env('FINDING_COUNTS', '{}');
  try {
    findingCounts = JSON.parse(rawCounts);
  } catch {
    console.error('FINDING_COUNTS must be valid JSON');
    process.exit(1);
  }

  const prNumber = env('GITHUB_EVENT_NAME') === 'pull_request'
    ? (process.env.GITHUB_REF || '').replace('refs/pull/', '').replace('/merge', '')
    : '';

  const lines = [
    `## ${scannerName}`,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Repository | ${env('GITHUB_REPOSITORY', 'unknown')} |`,
    `| Branch | ${env('GITHUB_REF_NAME', env('GITHUB_HEAD_REF', 'unknown'))} |`,
    `| Commit SHA | ${env('GITHUB_SHA', 'unknown')} |`,
    `| Pull request | ${prNumber || 'n/a'} |`,
    `| Event type | ${env('GITHUB_EVENT_NAME', 'unknown')} |`,
    `| Workflow run ID | ${env('GITHUB_RUN_ID', 'unknown')} |`,
    `| Scanner name | ${scannerName} |`,
    `| Scanner version | ${env('SCANNER_VERSION', 'unknown')} |`,
    `| Start time | ${env('START_TIME', 'unknown')} |`,
    `| Completion time | ${env('END_TIME', 'unknown')} |`,
    `| Report-only verdict | ${env('REPORT_ONLY_VERDICT', 'unknown')} |`,
    '',
    '### Finding counts',
    '',
  ];

  const keys = Object.keys(findingCounts);
  if (keys.length === 0) {
    lines.push('_No finding-count breakdown available._', '');
  } else {
    lines.push('| Severity / category | Count |', '| --- | ---: |');
    for (const key of keys.sort()) {
      lines.push(`| ${key} | ${findingCounts[key]} |`);
    }
    lines.push('');
  }

  const notes = env('EXTRA_NOTES');
  if (notes) {
    lines.push('### Notes', '', notes, '');
  }

  const markdown = `${lines.join('\n')}\n`;

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, markdown, 'utf8');
  } else {
    process.stdout.write(markdown);
  }

  const outFile = env('SUMMARY_FILE');
  if (outFile) {
    fs.writeFileSync(outFile, markdown, 'utf8');
  }
}

main();
