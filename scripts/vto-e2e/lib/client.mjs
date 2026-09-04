/**
 * Minimal HTTP client for the VTO E2E harness. Node 20+ fetch built-in only.
 */
'use strict';

export function edgeUrl(base, functionName) {
  return `${String(base).replace(/\/+$/, '')}/functions/v1/${functionName}`;
}

export async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 60_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), json, textLength: text.length };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Calls vto-generate with a bearer token. Never logs the token or the raw
 * response body (result.dataUri / provider fields are stripped by the
 * caller before anything is written to a report — see lib/report.mjs).
 */
export async function callVtoGenerate({ base, publishableKey, accessToken, body, timeoutMs }) {
  return request(edgeUrl(base, 'vto-generate'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: publishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeoutMs,
  });
}
