/**
 * Strict model-output validation for Elise actions and TypeChat/TextScan results.
 * Unknown fields, unsafe URLs, and executable instruction shapes fail closed.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'rpc',
  'sql',
  'query_sql',
  'route',
  'path',
  'deepLink',
  'deeplink',
  'tool',
  'toolName',
  'function',
  'functionName',
  'edgeFunction',
  'storagePath',
  'bucket',
  'table',
  'mutation',
  'execute',
  'rawSql',
  'headers',
  'authorization',
  'apiKey',
  'jwt',
  'serviceRole',
]);

const FORBIDDEN_VALUE_PATTERNS = [
  /\bdrop\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\binsert\s+into\b/i,
  /\bupdate\s+\w+\s+set\b/i,
  /\brpc\b\s*[:(]/i,
  /\bfile:\/\//i,
  /\bcontent:\/\//i,
  /\/admin\b/i,
  /\bsupabase\.functions\.invoke\b/i,
];

export const ALLOWED_TYPECHAT_STATUSES = ['completed', 'non_fashion', 'failed'] as const;

export type OutputValidationFailure = {
  ok: false;
  reason:
    | 'not_object'
    | 'unknown_field'
    | 'forbidden_field'
    | 'forbidden_value'
    | 'unsafe_url'
    | 'invalid_id'
    | 'overlong'
    | 'invalid_status'
    | 'invalid_type';
  detail?: string;
};

export type OutputValidationSuccess<T> = { ok: true; value: T };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenValue(value: unknown): string | null {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(value)) return pattern.source;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = containsForbiddenValue(entry);
      if (hit) return hit;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_OUTPUT_KEYS.has(key)) return key;
      const hit = containsForbiddenValue(entry);
      if (hit) return hit;
    }
  }
  return null;
}

export function isSafeHttpUrl(value: unknown, maxLen = 500): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return false;
  if (/^(file|content|javascript|data):/i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function rejectForbiddenModelShape(
  value: unknown,
): OutputValidationSuccess<Record<string, unknown>> | OutputValidationFailure {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' };
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) {
      return { ok: false, reason: 'forbidden_field', detail: key };
    }
  }
  const forbidden = containsForbiddenValue(value);
  if (forbidden) return { ok: false, reason: 'forbidden_value', detail: forbidden };
  return { ok: true, value };
}

/**
 * Strict allowlist reconstruction for TypeChat/TextScan model JSON.
 * Unknown top-level keys are rejected (fail closed).
 */
export function validateTypeChatModelOutput(
  raw: unknown,
): OutputValidationSuccess<{
  status: (typeof ALLOWED_TYPECHAT_STATUSES)[number];
  userMessage?: string;
  attributes?: Record<string, unknown>;
  identification?: Record<string, unknown>;
  recommendedProducts?: unknown[];
}> | OutputValidationFailure {
  if (!isRecord(raw)) return { ok: false, reason: 'not_object' };

  const allowedTop = new Set([
    'status',
    'userMessage',
    'attributes',
    'identification',
    'recommendedProducts',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) {
      return { ok: false, reason: 'unknown_field', detail: key };
    }
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) {
      return { ok: false, reason: 'forbidden_field', detail: key };
    }
  }

  const shape = rejectForbiddenModelShape(raw);
  if (!shape.ok) return shape;

  const statusRaw = typeof raw.status === 'string' ? raw.status.toLowerCase().trim() : '';
  let status: (typeof ALLOWED_TYPECHAT_STATUSES)[number] | null = null;
  if (statusRaw === 'completed') status = 'completed';
  else if (statusRaw.includes('non')) status = 'non_fashion';
  else if (statusRaw === 'failed') status = 'failed';
  if (!status) return { ok: false, reason: 'invalid_status', detail: statusRaw };

  if (raw.userMessage != null && typeof raw.userMessage !== 'string') {
    return { ok: false, reason: 'invalid_type', detail: 'userMessage' };
  }
  if (typeof raw.userMessage === 'string' && raw.userMessage.length > 500) {
    return { ok: false, reason: 'overlong', detail: 'userMessage' };
  }
  if (raw.attributes != null && !isRecord(raw.attributes)) {
    return { ok: false, reason: 'invalid_type', detail: 'attributes' };
  }
  if (raw.identification != null && !isRecord(raw.identification)) {
    return { ok: false, reason: 'invalid_type', detail: 'identification' };
  }
  if (raw.recommendedProducts != null && !Array.isArray(raw.recommendedProducts)) {
    return { ok: false, reason: 'invalid_type', detail: 'recommendedProducts' };
  }

  // Product URLs inside model output are ignored for execution; still reject unsafe ones if present.
  if (Array.isArray(raw.recommendedProducts)) {
    for (const product of raw.recommendedProducts.slice(0, 12)) {
      if (!isRecord(product)) continue;
      for (const key of ['url', 'productUrl', 'link', 'href']) {
        if (product[key] != null && !isSafeHttpUrl(product[key])) {
          return { ok: false, reason: 'unsafe_url', detail: key };
        }
      }
      for (const key of Object.keys(product)) {
        if (FORBIDDEN_OUTPUT_KEYS.has(key)) {
          return { ok: false, reason: 'forbidden_field', detail: key };
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      status,
      ...(typeof raw.userMessage === 'string' ? { userMessage: raw.userMessage } : {}),
      ...(isRecord(raw.attributes) ? { attributes: raw.attributes } : {}),
      ...(isRecord(raw.identification) ? { identification: raw.identification } : {}),
      ...(Array.isArray(raw.recommendedProducts)
        ? { recommendedProducts: raw.recommendedProducts }
        : {}),
    },
  };
}

export const ALLOWED_ELISE_ACTION_TYPES = [
  'open_stylist',
  'style_anchor_item',
  'style_for_event',
  'restyle_outfit',
  'swap_item',
  'open_look',
  'ask_my_room',
  'search_fashion',
  'compare_items',
  'open_scan',
  'save_product',
] as const;

export function isAllowedEliseActionType(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (ALLOWED_ELISE_ACTION_TYPES as readonly string[]).includes(value)
  );
}
