'use strict';

/**
 * What the campaign has ALREADY spent, so a second dispatch can never silently
 * double the budget. Two sources, the larger always wins:
 *
 *   1. explicit prior counts supplied by the dispatcher (workflow inputs);
 *   2. the server's own quota ledger (`scan_identify_usage_daily`), read through
 *      a fixed, validated, read-only query for the campaign's synthetic actors.
 *
 * If neither source is available the caller must refuse paid calls (fail closed).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function decodeJwtSub(jwt) {
  const part = String(jwt).split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.sub === 'string' && UUID_RE.test(json.sub) ? json.sub : null;
  } catch {
    return null;
  }
}

function buildLedgerQuery(userIds, sinceDate) {
  if (!DATE_RE.test(sinceDate)) throw new TypeError('since date must be YYYY-MM-DD');
  if (!Array.isArray(userIds) || userIds.length === 0 || !userIds.every((id) => UUID_RE.test(id))) {
    throw new TypeError('user ids must be validated uuids');
  }
  const list = userIds.map((id) => `'${id.toLowerCase()}'`).join(',');
  return `select user_id::text as u, usage_date::text as d, mode, sum("count")::int as n `
    + `from public.scan_identify_usage_daily where user_id in (${list}) and usage_date >= '${sinceDate}' group by 1,2,3`;
}

async function readLedger({ projectRef, managementToken, subsByActor, sinceDate, today, fetchImpl = fetch }) {
  const ids = Object.values(subsByActor).filter(Boolean);
  const sql = buildLedgerQuery(ids, sinceDate);
  const response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${managementToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!response.ok) return { ok: false, status: response.status };
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) return { ok: false, status: response.status };

  const actorByUser = Object.fromEntries(Object.entries(subsByActor).filter(([, id]) => id).map(([actor, id]) => [id.toLowerCase(), actor]));
  let imageMode = 0;
  let commerceOnly = 0;
  const imageModePerActorToday = {};
  for (const row of rows) {
    const actor = actorByUser[String(row.u).toLowerCase()];
    if (!actor) continue;
    const n = Number(row.n) || 0;
    if (row.mode === 'commerce_only') commerceOnly += n;
    else if (row.mode === 'image') {
      imageMode += n;
      if (row.d === today) imageModePerActorToday[actor] = (imageModePerActorToday[actor] ?? 0) + n;
    }
  }
  return { ok: true, imageMode, commerceOnly, imageModePerActorToday };
}

function mergePrior(explicit, ledger) {
  const e = explicit ?? { imageMode: 0, commerceOnly: 0, imageModePerActorToday: {} };
  if (!ledger?.ok) return { source: 'explicit_only', ...e };
  const perActor = { ...e.imageModePerActorToday };
  for (const [actor, n] of Object.entries(ledger.imageModePerActorToday)) {
    perActor[actor] = Math.max(perActor[actor] ?? 0, n);
  }
  return {
    source: 'ledger_and_explicit',
    imageMode: Math.max(e.imageMode ?? 0, ledger.imageMode),
    commerceOnly: Math.max(e.commerceOnly ?? 0, ledger.commerceOnly),
    imageModePerActorToday: perActor,
  };
}

module.exports = { buildLedgerQuery, decodeJwtSub, mergePrior, readLedger };
