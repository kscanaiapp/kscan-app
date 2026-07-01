const KSCAN_PUBLIC_BASE_URL = 'https://kscan.app';
const KSCAN_ROOM_API_BASE_URL = `${KSCAN_PUBLIC_BASE_URL}/api/rooms`;
const KSCAN_ANDROID_PACKAGE = 'com.kscanai.app';
const KSCAN_PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${KSCAN_ANDROID_PACKAGE}`;
const ROOM_OPEN_APP_TIMEOUT_MS = 650;

const SAFE_ATTRIBUTION_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'invite_id',
  'ref',
]);

const ROOM_LINK_EVENTS = new Set([
  'room_share_link_opened',
  'room_link_opened_native',
  'room_link_opened_web',
  'room_open_app_cta_clicked',
  'room_open_app_cta_failed',
  'room_token_invalid',
  'room_token_expired',
  'room_token_revoked',
  'room_token_max_redemptions',
  'room_joined_authenticated',
  'room_joined_anonymous',
]);

function normalizeRoomShareToken(value) {
  const token = String(value ?? '').trim();
  if (!token || token.length > 160) return null;
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getSafeAttributionParams(searchParams) {
  const output = {};
  for (const [key, value] of searchParams.entries()) {
    if (!SAFE_ATTRIBUTION_PARAMS.has(key)) continue;
    const cleanValue = String(value || '').trim();
    if (cleanValue) output[key] = cleanValue.slice(0, 120);
  }
  return output;
}

function buildSafeQuery(attribution = {}) {
  const params = new URLSearchParams();
  for (const key of SAFE_ATTRIBUTION_PARAMS) {
    const value = String(attribution[key] || '').trim();
    if (value) params.set(key, value.slice(0, 120));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function parseRoomDeepLink(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = raw.includes('://')
      ? new URL(raw)
      : new URL(raw.startsWith('/') ? raw : `/${raw}`, KSCAN_PUBLIC_BASE_URL);
  } catch {
    return null;
  }

  const isCustomScheme = url.protocol === 'kscan:';
  const isHttpRoomDomain =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (url.hostname === 'kscan.app' || url.hostname === 'www.kscan.app');

  if (!isCustomScheme && !isHttpRoomDomain) return null;

  const pathSegments = url.pathname.split('/').filter(Boolean);
  const roomSegments =
    isCustomScheme && url.hostname === 'rooms'
      ? ['rooms', ...pathSegments]
      : pathSegments;

  if (roomSegments[0] !== 'rooms' || !roomSegments[1]) return null;

  const shareToken = normalizeRoomShareToken(safeDecodeURIComponent(roomSegments[1]));
  if (!shareToken) return null;

  return {
    shareToken,
    attribution: getSafeAttributionParams(url.searchParams),
  };
}

function buildRoomWebUrl(shareToken, attribution) {
  const token = normalizeRoomShareToken(shareToken);
  if (!token) return KSCAN_PUBLIC_BASE_URL;
  return `${KSCAN_PUBLIC_BASE_URL}/rooms/${encodeURIComponent(token)}${buildSafeQuery(attribution)}`;
}

function buildRoomAppUrl(shareToken, attribution) {
  const token = normalizeRoomShareToken(shareToken);
  if (!token) return 'kscan://';
  return `kscan://rooms/${encodeURIComponent(token)}${buildSafeQuery(attribution)}`;
}

function buildNativeRoomPath(shareToken, attribution) {
  const token = normalizeRoomShareToken(shareToken);
  if (!token) return '/';
  return `/rooms/${encodeURIComponent(token)}${buildSafeQuery(attribution)}`;
}

function isLikelyInAppBrowser(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  return /instagram|fb_iab|fban|fbav|tiktok|musical_ly|whatsapp|messenger|line\//.test(ua);
}

function getRoomInstallUrl(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (/android/.test(ua)) return KSCAN_PLAY_STORE_URL;
  return null;
}

function logRoomLinkEvent(eventName, metadata = {}) {
  const event = ROOM_LINK_EVENTS.has(eventName) ? eventName : 'room_share_link_opened';
  const safeMetadata = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (/token|secret|key|user/i.test(key)) continue;
    safeMetadata[key] = value;
  }
  console.info('[room-link]', { event, ...safeMetadata });
}

module.exports = {
  KSCAN_ANDROID_PACKAGE,
  KSCAN_PLAY_STORE_URL,
  KSCAN_PUBLIC_BASE_URL,
  KSCAN_ROOM_API_BASE_URL,
  ROOM_OPEN_APP_TIMEOUT_MS,
  buildNativeRoomPath,
  buildRoomAppUrl,
  buildRoomWebUrl,
  getRoomInstallUrl,
  isLikelyInAppBrowser,
  logRoomLinkEvent,
  normalizeRoomShareToken,
  parseRoomDeepLink,
};
