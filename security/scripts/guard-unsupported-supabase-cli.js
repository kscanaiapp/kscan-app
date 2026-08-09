#!/usr/bin/env node
'use strict';

// Refuse the unsupported Supabase CLI form without searching the workflow that
// invokes this guard. That invocation necessarily contains the search terms and
// was the source of the previous self-match deployment failure.
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.yml', '.yaml', '.sh', '.ps1']);
const SELF = path.resolve(__filename);

function isUnsupportedDbPush(text) {
  return /\bdb\s+push\s+--project-ref\b/.test(text);
}

function walk(target, files = []) {
  if (!fs.existsSync(target)) return files;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry), files);
  } else if (SOURCE_EXTENSIONS.has(path.extname(target))) {
    files.push(target);
  }
  return files;
}

function findUnsupportedUsage(targets) {
  const matches = [];
  for (const file of targets.flatMap((target) => walk(target))) {
    if (path.resolve(file) === SELF) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (isUnsupportedDbPush(line)) matches.push({ file, line: index + 1 });
    });
  }
  return matches;
}

function main() {
  const matches = findUnsupportedUsage(process.argv.slice(2).length ? process.argv.slice(2) : ['.github', 'scripts', 'security/scripts']);
  process.stdout.write(`${JSON.stringify({ ok: matches.length === 0, matches }, null, 2)}\n`);
  process.exit(matches.length === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { findUnsupportedUsage, isUnsupportedDbPush };
