/** Bounded, provider-free checks. These do not certify authenticated paid Scanner behavior. */
export async function checkProductionContract({ functionName, url, anonKey, verifyJwt, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/$/, '')}/functions/v1/${functionName}`;
  const probes = [{ name: 'reachable', method: 'OPTIONS', statuses: [200, 204] },
    { name: 'unauthorized', method: 'POST', statuses: [401, 403],
      // No image, text, identification or search evidence: cannot invoke a provider even if routing regresses.
      body: JSON.stringify({ requestMode: 'commerce_only', mode: 'text' }) }];
  if (functionName === 'scan-identify' && verifyJwt === false) probes.push(
    { name: 'invalid_json', method: 'POST', body: '{', statuses: [400], error: 'Invalid JSON' },
    { name: 'unsupported_contract', method: 'POST', body: JSON.stringify({ contractVersion: 'deployment-probe-unsupported' }),
      statuses: [400], code: 'UNSUPPORTED_CONTRACT_VERSION' });
  const results = [];
  for (const probe of probes) {
    try {
      const response = await fetchImpl(endpoint, {
        method: probe.method, headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        ...(probe.body ? { body: probe.body } : {}), signal: AbortSignal.timeout(15000),
      });
      const body = await response.text();
      const sensitive = body.length > 8192 || /service_role|eyJ[a-zA-Z0-9_-]{10}|sbp_|sb_secret_|password|BOOT_ERROR/i.test(body);
      let contract = true;
      if (probe.error || probe.code) {
        try { const parsed = JSON.parse(body); contract = probe.error ? parsed.error === probe.error :
          (parsed.error?.code ?? parsed.errorCode ?? parsed.error) === probe.code; }
        catch { contract = false; }
      }
      results.push({ name: probe.name, status: response.status,
        ok: probe.statuses.includes(response.status) && !sensitive && contract,
        sensitiveFieldsExposed: sensitive, responseContract: contract });
    } catch { results.push({ name: probe.name, ok: false, error: 'Bounded contract probe failed' }); }
  }
  return { ok: results.every((result) => result.ok), probes: results, paid_provider_calls: 0,
    authenticated_scanner_certification: 'UNVERIFIED: authorized actor and provider allocation required' };
}
