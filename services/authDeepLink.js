function parseParamString(value) {
  const params = {};
  if (!value) return params;
  const trimmed = value.replace(/^[?#]/, '');
  if (!trimmed) return params;

  for (const pair of trimmed.split('&')) {
    if (!pair) continue;
    const [rawKey, ...rawValue] = pair.split('=');
    const key = decodeURIComponent(rawKey || '');
    if (!key) continue;
    params[key] = decodeURIComponent(rawValue.join('=') || '');
  }
  return params;
}

function parseAuthCallbackUrl(url) {
  const source = String(url || '');
  const hashIndex = source.indexOf('#');
  const queryIndex = source.indexOf('?');

  const hashParams = hashIndex >= 0 ? parseParamString(source.slice(hashIndex + 1)) : {};
  const queryEnd = hashIndex >= 0 ? hashIndex : source.length;
  const queryParams =
    queryIndex >= 0 && queryIndex < queryEnd
      ? parseParamString(source.slice(queryIndex + 1, queryEnd))
      : {};

  const params = { ...queryParams, ...hashParams };
  const accessToken = params.access_token || null;
  const refreshToken = params.refresh_token || null;
  const tokenHash = params.token_hash || null;
  const type = params.type || null;
  const code = params.code || null;
  const error = params.error_description || params.error || null;

  return {
    accessToken,
    refreshToken,
    tokenHash,
    type,
    code,
    error,
    hasSessionTokens: Boolean(accessToken && refreshToken),
    hasTokenHash: Boolean(tokenHash && type),
    isRecovery: type === 'recovery',
  };
}

function getAuthCallbackRedirect(parsed) {
  if (parsed.isRecovery) return '/auth/update-password';
  return '/';
}

function buildAuthCallbackUrlFromParams(params) {
  if (!params || typeof params !== 'object') return null;
  const entries = Object.entries(params)
    .map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
    .filter(([key, value]) => key && value !== undefined && value !== null && value !== '');

  if (entries.length === 0) return null;

  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

  return `kscan://auth/callback?${query}`;
}

module.exports = {
  buildAuthCallbackUrlFromParams,
  parseAuthCallbackUrl,
  getAuthCallbackRedirect,
};
