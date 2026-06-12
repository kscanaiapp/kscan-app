import {
  STYLE_MEMORY_MAX_SOURCE_REFS,
  STYLE_MEMORY_NEGATIVE_REACTION_TYPES,
  STYLE_MEMORY_POSITIVE_REACTION_TYPES,
} from '../../constants/styleMemory';
import type {
  BrandPreferencePayload,
  BudgetSignalPayload,
  CategoryPreferencePayload,
  ColorPreferencePayload,
  DressingRoomPositiveFeedbackPayload,
  StyleMemoryEventType,
  StyleMemorySourceKind,
  StyleMemorySourceRef,
} from './styleMemoryTypes';

type ValidatedPayload =
  | BrandPreferencePayload
  | BudgetSignalPayload
  | CategoryPreferencePayload
  | ColorPreferencePayload
  | DressingRoomPositiveFeedbackPayload;

const STYLE_MEMORY_SOURCE_KINDS: StyleMemorySourceKind[] = [
  'scan',
  'saved_item',
  'dressing_room',
  'product',
  'profile',
];

const POSITIVE_REACTIONS = new Set<string>(STYLE_MEMORY_POSITIVE_REACTION_TYPES);
const NEGATIVE_REACTIONS = new Set<string>(STYLE_MEMORY_NEGATIVE_REACTION_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getPositiveFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isStyleMemorySourceKind(value: unknown): value is StyleMemorySourceKind {
  return (
    typeof value === 'string' &&
    STYLE_MEMORY_SOURCE_KINDS.includes(value as StyleMemorySourceKind)
  );
}

function normalizeSourceRef(value: unknown): StyleMemorySourceRef | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const id = getTrimmedString(value.id);
  if (!isStyleMemorySourceKind(kind) || !id) return null;
  return { kind, id };
}

function normalizeSourceRefs(value: unknown): StyleMemorySourceRef[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > STYLE_MEMORY_MAX_SOURCE_REFS) {
    return null;
  }

  const sourceRefs: StyleMemorySourceRef[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const normalized = normalizeSourceRef(entry);
    if (!normalized) return null;

    const dedupeKey = `${normalized.kind}:${normalized.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    sourceRefs.push(normalized);
  }

  return sourceRefs.length > 0 ? sourceRefs : null;
}

function validateBasePayload(
  value: unknown,
): {
  source: StyleMemorySourceKind;
  signalKey: string;
  count: number;
  sourceRefs: StyleMemorySourceRef[];
  record: Record<string, unknown>;
} | null {
  if (!isRecord(value)) return null;

  const signalKey = getTrimmedString(value.signalKey);
  const count = getPositiveFiniteNumber(value.count);
  const source = value.source;
  const sourceRefs = normalizeSourceRefs(value.sourceRefs);

  if (!signalKey || !count || !isStyleMemorySourceKind(source) || !sourceRefs) {
    return null;
  }

  return {
    source,
    signalKey,
    count,
    sourceRefs,
    record: value,
  };
}

export function isPositiveMemoryReactionType(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_REACTIONS.has(value);
}

export function isNegativeMemoryReactionType(value: unknown): value is string {
  return typeof value === 'string' && NEGATIVE_REACTIONS.has(value);
}

export function isValidColorPreferencePayload(value: unknown): value is ColorPreferencePayload {
  const payload = validateBasePayload(value);
  if (!payload) return false;

  return Boolean(
    getTrimmedString(payload.record.color) &&
      getTrimmedString(payload.record.normalizedColor),
  );
}

export function isValidBrandPreferencePayload(value: unknown): value is BrandPreferencePayload {
  const payload = validateBasePayload(value);
  if (!payload) return false;

  return Boolean(
    getTrimmedString(payload.record.brandName) &&
      getTrimmedString(payload.record.normalizedBrandName),
  );
}

export function isValidCategoryPreferencePayload(value: unknown): value is CategoryPreferencePayload {
  const payload = validateBasePayload(value);
  if (!payload) return false;

  return Boolean(
    getTrimmedString(payload.record.category) &&
      getTrimmedString(payload.record.normalizedCategory),
  );
}

export function isValidBudgetSignalPayload(value: unknown): value is BudgetSignalPayload {
  const payload = validateBasePayload(value);
  if (!payload) return false;

  const priceMin = payload.record.priceMin;
  const priceMax = payload.record.priceMax;
  const priceAverage = payload.record.priceAverage;
  const numericValues = [priceMin, priceMax, priceAverage].filter(
    (entry) => entry !== undefined,
  );

  if (numericValues.length === 0) return false;
  if (numericValues.some((entry) => getPositiveFiniteNumber(entry) === null)) return false;

  if (
    payload.record.currency !== undefined &&
    getTrimmedString(payload.record.currency) === null
  ) {
    return false;
  }

  return true;
}

export function isValidDressingRoomPositiveFeedbackPayload(
  value: unknown,
): value is DressingRoomPositiveFeedbackPayload {
  const payload = validateBasePayload(value);
  if (!payload) return false;

  if (!isPositiveMemoryReactionType(payload.record.reactionType)) return false;

  if (
    payload.record.brandName !== undefined &&
    getTrimmedString(payload.record.brandName) === null
  ) {
    return false;
  }

  if (
    payload.record.category !== undefined &&
    getTrimmedString(payload.record.category) === null
  ) {
    return false;
  }

  return true;
}

export function validateStyleMemoryPayload(
  eventType: StyleMemoryEventType,
  value: unknown,
): ValidatedPayload | null {
  switch (eventType) {
    case 'color_preference':
      return isValidColorPreferencePayload(value) ? value : null;
    case 'brand_preference':
      return isValidBrandPreferencePayload(value) ? value : null;
    case 'category_preference':
      return isValidCategoryPreferencePayload(value) ? value : null;
    case 'budget_signal':
      return isValidBudgetSignalPayload(value) ? value : null;
    case 'dressing_room_positive_feedback':
      return isValidDressingRoomPositiveFeedbackPayload(value) ? value : null;
    default:
      return null;
  }
}
