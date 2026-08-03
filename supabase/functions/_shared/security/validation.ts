// Shared request validation: content type, body size, and per-function schemas.
//
// Design note: size limits are enforced while *reading* the body (readJsonBody),
// not after JSON.parse — a Content-Length lie or missing header must not let an
// attacker force a large parse/allocation before the limit is checked.

export interface ReadBodyResult {
  ok: true;
  raw: string;
}

export interface ReadBodyError {
  ok: false;
  reason: 'too_large' | 'wrong_content_type' | 'missing_body' | 'malformed_json';
}

export function assertJsonContentType(req: Request): boolean {
  const contentType = req.headers.get('Content-Type') ?? '';
  return contentType.toLowerCase().includes('application/json');
}

// Reads the request body up to maxBytes, aborting mid-stream if exceeded so an
// oversized payload never fully lands in memory.
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<ReadBodyResult | ReadBodyError> {
  if (!req.body) return { ok: false, reason: 'missing_body' };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (total === 0) return { ok: false, reason: 'missing_body' };

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, raw: new TextDecoder().decode(combined) };
}

export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | ReadBodyError> {
  const bodyResult = await readBodyWithLimit(req, maxBytes);
  if (!bodyResult.ok) return bodyResult;

  try {
    return { ok: true, value: JSON.parse(bodyResult.raw) };
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
}

// ── Function-specific schema validation ─────────────────────────────────────────

export type FieldSchema =
  | { type: 'string'; required?: boolean; minLength?: number; maxLength?: number; pattern?: RegExp; enum?: readonly string[] }
  | { type: 'number'; required?: boolean; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; required?: boolean }
  | { type: 'uuid'; required?: boolean }
  | { type: 'url'; required?: boolean; maxLength?: number; allowedProtocols?: readonly string[] }
  | { type: 'array'; required?: boolean; minItems?: number; maxItems?: number; items?: FieldSchema };

export interface RequestSchema {
  fields: Record<string, FieldSchema>;
  // Defaults to false: unrecognized fields are rejected rather than silently dropped.
  allowUnknownFields?: boolean;
}

export interface ValidationSuccess {
  ok: true;
  value: Record<string, unknown>;
}

export interface ValidationFailure {
  ok: false;
  // Field-level detail for server-side logs only — never return this to the client.
  issues: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ALLOWED_URL_PROTOCOLS = ['https:'];

function validateField(name: string, schema: FieldSchema, value: unknown, issues: string[]): void {
  const present = value !== undefined && value !== null;

  if (!present) {
    if (schema.required) issues.push(`${name}: required`);
    return;
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') { issues.push(`${name}: expected string`); return; }
      if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${name}: too short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${name}: too long`);
      if (schema.pattern && !schema.pattern.test(value)) issues.push(`${name}: malformed`);
      if (schema.enum && !schema.enum.includes(value)) issues.push(`${name}: not in allowed enum`);
      break;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) { issues.push(`${name}: expected number`); return; }
      if (schema.integer && !Number.isInteger(value)) issues.push(`${name}: expected integer`);
      if (schema.min !== undefined && value < schema.min) issues.push(`${name}: below minimum`);
      if (schema.max !== undefined && value > schema.max) issues.push(`${name}: above maximum`);
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') issues.push(`${name}: expected boolean`);
      break;
    }
    case 'uuid': {
      if (typeof value !== 'string' || !UUID_RE.test(value)) issues.push(`${name}: expected uuid`);
      break;
    }
    case 'url': {
      if (typeof value !== 'string') { issues.push(`${name}: expected url string`); return; }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) { issues.push(`${name}: too long`); return; }
      try {
        const parsed = new URL(value);
        const allowed = schema.allowedProtocols ?? DEFAULT_ALLOWED_URL_PROTOCOLS;
        if (!allowed.includes(parsed.protocol)) issues.push(`${name}: disallowed protocol`);
      } catch {
        issues.push(`${name}: malformed url`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) { issues.push(`${name}: expected array`); return; }
      if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${name}: too few items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${name}: too many items`);
      if (schema.items) {
        value.forEach((item, i) => validateField(`${name}[${i}]`, schema.items!, item, issues));
      }
      break;
    }
  }
}

export function validateRequestBody(body: unknown, schema: RequestSchema): ValidationSuccess | ValidationFailure {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, issues: ['body: expected a JSON object'] };
  }

  const record = body as Record<string, unknown>;
  const issues: string[] = [];

  for (const [name, fieldSchema] of Object.entries(schema.fields)) {
    validateField(name, fieldSchema, record[name], issues);
  }

  if (!schema.allowUnknownFields) {
    for (const key of Object.keys(record)) {
      if (!(key in schema.fields)) issues.push(`${key}: unsupported field`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: record };
}

// A conservative default cap for provider-backed function bodies. Individual
// functions may pass a smaller maxBytes to readJsonBody/readBodyWithLimit.
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024; // 32 KB
