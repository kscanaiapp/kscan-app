/**
 * Post-run log audit for the `user_supplied_garment` staging probe.
 *
 * The certification sends real image payloads through vto-generate. This
 * module reads back what the Edge runtime actually logged during the run's
 * window and reports, as COUNTS ONLY, whether anything that must never be
 * logged was: an image payload in any form, a credential, or the garment's
 * fingerprint. It mutates nothing and spends nothing, so it can be re-run for
 * the same window as often as needed -- which is exactly why it is its own
 * mode rather than a step inside the one paid run.
 *
 * NOT VACUOUS. "No forbidden content found" proves nothing if no log was
 * read. The audit therefore also requires that the window contains this run's
 * own request id; a query that returned the wrong rows, or none, FAILS.
 *
 * Matching is done here, on the fetched lines, rather than in the query, so
 * the only SQL sent is a plain windowed read of two log sources. A log line is
 * never returned, printed or written: evidence is a count per rule plus the
 * bounded, non-sensitive fields of this run's own structured events.
 */
'use strict';

import { assertNotProductionUrl } from './auth.mjs';

const MANAGEMENT_API = 'https://api.supabase.com';
const PAGE_LIMIT = 1000;
const MAX_PAGES = 40;

export const LOG_SOURCES = Object.freeze(['function_logs', 'function_edge_logs']);

/**
 * What must never appear in a log line. Each rule is deliberately broad: a
 * false positive is a finding someone reads, a false negative is a leak.
 */
export const FORBIDDEN_LOG_RULES = Object.freeze([
  { id: 'data URI', pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,/i },
  { id: 'Base64 image payload (a run of 256+ Base64 characters)', pattern: /[A-Za-z0-9+/]{256,}/ },
  { id: 'JPEG or PNG magic bytes in Base64', pattern: /\/9j\/[A-Za-z0-9+/]{24,}|iVBORw0KGgo[A-Za-z0-9+/]{16,}/ },
  { id: 'JSON Web Token', pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'bearer credential', pattern: /bearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { id: 'provider credential header', pattern: /x-rapidapi-key|rapidapi[-_ ]?key\s*["']?\s*[:=]/i },
  { id: 'Supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]{8,}|service_role\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i },
]);

/** The bounded structured fields vto-generate logs, safe to carry as evidence. */
const EVENT_FIELDS = Object.freeze([
  'event', 'stage', 'failureCode', 'origin', 'provider', 'slot', 'category',
  'inputBucket', 'outputBucket', 'outputBytes', 'billedUnits', 'latencyMs',
]);

function parseStructuredEvent(message) {
  const start = message.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(start));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pure: applies every rule to every line. Returns counts and this run's own
 * events -- never a line.
 */
export function scanLogLines(lines, { contentHash = null, runMarker = null } = {}) {
  const rules = [...FORBIDDEN_LOG_RULES];
  if (contentHash) {
    rules.push({ id: 'the garment content fingerprint', pattern: new RegExp(contentHash.replace(/[^0-9a-f]/gi, ''), 'i') });
  }
  const hits = rules.map((rule) => ({ id: rule.id, matches: 0 }));
  const runEvents = [];
  for (const line of lines) {
    const message = typeof line === 'string' ? line : '';
    rules.forEach((rule, index) => {
      if (rule.pattern.test(message)) hits[index].matches += 1;
    });
    if (runMarker && message.includes(runMarker)) {
      const parsed = parseStructuredEvent(message);
      const picked = {};
      for (const field of EVENT_FIELDS) {
        const value = parsed?.[field];
        if (typeof value === 'string' || typeof value === 'number') picked[field] = value;
      }
      runEvents.push(picked);
    }
  }
  return { linesScanned: lines.length, hits, runEvents };
}

function toIso(timestamp) {
  if (typeof timestamp === 'number') {
    // The analytics store reports microseconds since the epoch.
    return new Date(Math.floor(timestamp / 1000)).toISOString();
  }
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** One windowed read of one log source. `shape` names which of the two query
 *  forms the analytics endpoint accepted, so a report can say what answered. */
async function queryLogPage({ projectRef, managementCredential, source, since, until, fetchImpl }) {
  const attempts = [
    { shape: 'table', path: 'logs.all', sql: `select id, timestamp, event_message from ${source} order by timestamp asc limit ${PAGE_LIMIT}` },
    { shape: 'source-column', path: 'logs', sql: `select timestamp, event_message from logs where source = '${source}' order by timestamp asc limit ${PAGE_LIMIT}` },
  ];
  let lastError = 'no query attempted';
  for (const attempt of attempts) {
    const url = new URL(`${MANAGEMENT_API}/v1/projects/${projectRef}/analytics/endpoints/${attempt.path}`);
    url.searchParams.set('sql', attempt.sql);
    url.searchParams.set('iso_timestamp_start', since);
    url.searchParams.set('iso_timestamp_end', until);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${managementCredential}` } });
    if (!response.ok) {
      lastError = `log query (${attempt.shape}) failed with status ${response.status}`;
      continue;
    }
    const body = await response.json();
    if (body?.error) {
      lastError = `log query (${attempt.shape}) was rejected by the analytics endpoint`;
      continue;
    }
    if (Array.isArray(body?.result)) return { shape: attempt.shape, rows: body.result };
    lastError = `log query (${attempt.shape}) returned no result array`;
  }
  throw new Error(lastError);
}

/**
 * Every line of one source inside the window. Pages forward by timestamp; if
 * the window cannot be read to its end the result says so, and the audit
 * fails rather than claim a complete read.
 */
export async function fetchLogLines({
  projectRef, managementCredential, source, since, until, fetchImpl = fetch,
}) {
  const seen = new Set();
  const lines = [];
  let cursor = since;
  let shape = null;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await queryLogPage({ projectRef, managementCredential, source, since: cursor, until, fetchImpl });
    shape = result.shape;
    let lastTimestamp = null;
    for (const row of result.rows) {
      const key = row?.id ?? `${row?.timestamp}:${row?.event_message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(typeof row?.event_message === 'string' ? row.event_message : '');
      lastTimestamp = row?.timestamp ?? lastTimestamp;
    }
    if (result.rows.length < PAGE_LIMIT) { complete = true; break; }
    const next = lastTimestamp === null ? null : toIso(lastTimestamp);
    if (!next || next === cursor) break; // cannot advance: do not pretend the read is complete
    cursor = next;
  }
  return { source, shape, lines, complete };
}

function check(name, ok, detail) {
  return { name, ok, detail: detail ?? (ok ? 'pass' : 'unexpected result') };
}

/**
 * @param {object} args
 * @param {string} args.since / args.until   ISO window of the run under audit
 * @param {string} args.runMarker            the run tag every request id of the run starts with
 * @param {string} args.contentHash          the garment fingerprint that was sent
 * @param {number} args.expectDispatches     how many provider dispatches the run reported
 */
export async function runUserGarmentLogAudit({
  projectRef, supabaseUrl, managementCredential, since, until, runMarker, contentHash,
  expectDispatches = 0, fetchImpl = fetch,
}) {
  assertNotProductionUrl(supabaseUrl);
  if (!managementCredential) throw new Error('log audit needs the governed management credential in the environment');
  for (const [name, value] of [['since', since], ['until', until]]) {
    if (!value || Number.isNaN(new Date(value).getTime())) throw new Error(`--${name} must be an ISO timestamp`);
  }
  if (!runMarker) throw new Error('--audit-run-tag is required: an audit that cannot find its own run proves nothing');

  const results = [];
  const sources = [];
  const allLines = [];
  for (const source of LOG_SOURCES) {
    const read = await fetchLogLines({ projectRef, managementCredential, source, since, until, fetchImpl });
    sources.push({ source, queryShape: read.shape, linesRead: read.lines.length, complete: read.complete });
    allLines.push(...read.lines);
    results.push(check(
      `${source}: the whole window was read`,
      read.complete,
      `linesRead=${read.lines.length} complete=${read.complete} queryShape=${read.shape}`,
    ));
  }

  const scan = scanLogLines(allLines, { contentHash, runMarker });
  results.push(check(
    'the window contains this run (its own request ids appear in the function logs)',
    scan.runEvents.length > 0,
    `linesScanned=${scan.linesScanned} linesForThisRun=${scan.runEvents.length}`,
  ));
  for (const hit of scan.hits) {
    results.push(check(`no ${hit.id} in any log line`, hit.matches === 0, `matches=${hit.matches} of ${scan.linesScanned} lines`));
  }

  // `vto_generate_start` is logged after the reservation and immediately
  // before the provider call: it is the server's own record of a dispatch.
  const starts = scan.runEvents.filter((event) => event.event === 'vto_generate_start');
  results.push(check(
    `the server logged exactly ${expectDispatches} provider dispatch(es) for this run`,
    starts.length === expectDispatches,
    `vto_generate_start events for this run = ${starts.length}`,
  ));

  return {
    results,
    sources,
    linesScanned: scan.linesScanned,
    runEvents: scan.runEvents,
    serverLoggedCategory: starts[0]?.category ?? null,
    serverLoggedSlot: starts[0]?.slot ?? null,
    serverLoggedProvider: starts[0]?.provider ?? null,
    dispatchesLogged: starts.length,
  };
}
