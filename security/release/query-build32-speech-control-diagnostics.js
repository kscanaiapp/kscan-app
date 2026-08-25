#!/usr/bin/env node
'use strict';

const PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const WINDOW_START = '2026-08-25T23:00:20.000Z';
const WINDOW_END = '2026-08-25T23:00:30.000Z';
const MARKER = 'stylist_speech_provider';

function parseDiagnostic(message) {
  if (typeof message !== 'string' || !message.includes(MARKER)) return null;
  const start = message.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(start));
    return parsed?.event === MARKER ? parsed : null;
  } catch { return null; }
}

async function run() {
  if (process.env.SUPABASE_STAGING_PROJECT_REF !== PROJECT_REF) {
    throw new Error('staging authority check failed');
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('missing management token');

  const sql = `select timestamp, event_message from logs where source = 'function_logs' and event_message like '%${MARKER}%' order by timestamp asc limit 20`;
  const url = new URL(`https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs`);
  url.searchParams.set('sql', sql);
  url.searchParams.set('iso_timestamp_start', WINDOW_START);
  url.searchParams.set('iso_timestamp_end', WINDOW_END);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`log query failed with status ${response.status}`);
  const body = await response.json();
  const events = (Array.isArray(body?.result) ? body.result : [])
    .map((row) => ({ timestamp: row.timestamp, diagnostic: parseDiagnostic(row.event_message) }))
    .filter((row) => row.diagnostic)
    .map((row) => ({
      timestamp: row.timestamp,
      failureKind: row.diagnostic.failureKind ?? null,
      providerStatus: row.diagnostic.providerStatus ?? null,
      elapsedMs: row.diagnostic.elapsedMs ?? null,
      outputFormat: row.diagnostic.outputFormat ?? null,
      alignmentSource: row.diagnostic.alignmentSource ?? null,
      alignmentRawStatus: row.diagnostic.alignmentRawStatus ?? null,
      alignmentEntryCount: row.diagnostic.alignmentEntryCount ?? null,
      responseByteLength: row.diagnostic.responseByteLength ?? null,
    }));
  const evidence = {
    targetEnvironment: 'staging',
    projectRef: PROJECT_REF,
    sourceRunId: 32908772890,
    speechRequestsIssued: 0,
    diagnosticEventCount: events.length,
    events,
    pass: events.some((event) => event.failureKind === 'none' && event.providerStatus === 200),
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = evidence.pass ? 0 : 1;
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
