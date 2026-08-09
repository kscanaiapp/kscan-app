#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file || !/^supabase[\\/]migrations[\\/][^\\/]+\.sql$/.test(file)) throw new Error('Expected one changed Supabase migration path');
const sql = fs.readFileSync(file, 'utf8');
const prohibited = [
  ['DROP_TABLE', /\bDROP\s+TABLE\b/i],
  ['DROP_SCHEMA', /\bDROP\s+SCHEMA\b/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['RLS_DISABLE', /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i],
  ['PRODUCTION_REF', /wyyuqfdxucjksghsmhry/i],
];
const findings = prohibited.filter(([, pattern]) => pattern.test(sql)).map(([id]) => id);
process.stdout.write(`${JSON.stringify({file, findings})}\n`);
if (findings.length) process.exit(1);
