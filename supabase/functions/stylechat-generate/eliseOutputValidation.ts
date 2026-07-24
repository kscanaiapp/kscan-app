/**
 * E-2 output validation — preserve plain-text client response; discard unsafe actions.
 */

import { stripUnsafeModelOutput } from './promptHardening.ts';
import {
  ELISE_OUTPUT_VERSION,
  type EliseGenerationOutput,
  type EliseValidatedAction,
} from './eliseGenerationTypes.ts';

const MAX_TEXT_CHARS = 8_000;
const MAX_EXPLANATION_CHARS = 1_200;
const FORBIDDEN_ACTION_TYPES = new Set([
  'sql',
  'rpc',
  'storage_write',
  'closet_mutate',
  'room_mutate',
  'place_order',
  'open_url',
  'open_arbitrary_url',
  'set_preference',
  'account_mutate',
  'session_mutate',
]);

const ALLOWED_ACTION_TYPES = new Set([
  'open_stylist',
  'style_anchor_item',
  'style_for_event',
  'restyle_outfit',
  'swap_item',
  'open_look',
  'ask_my_room',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeText(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function validateEliseActions(
  rawActions: unknown,
): { actions: EliseValidatedAction[]; dropped: boolean } {
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return { actions: [], dropped: false };
  }
  const actions: EliseValidatedAction[] = [];
  let dropped = false;
  for (const candidate of rawActions.slice(0, 8)) {
    if (actions.length >= 2) {
      dropped = true;
      break;
    }
    if (!isRecord(candidate)) {
      dropped = true;
      continue;
    }
    const type = typeof candidate.type === 'string' ? candidate.type.trim() : '';
    if (!type || FORBIDDEN_ACTION_TYPES.has(type) || !ALLOWED_ACTION_TYPES.has(type)) {
      dropped = true;
      continue;
    }
    // Reject action payloads that look like SQL/RPC/storage mutations.
    const serialized = JSON.stringify(candidate).toLowerCase();
    if (
      /select\s+|insert\s+|update\s+|delete\s+|drop\s+|rpc:|storage:|mutation:/.test(serialized)
    ) {
      dropped = true;
      continue;
    }
    if (typeof candidate.url === 'string' || typeof candidate.href === 'string') {
      dropped = true;
      continue;
    }
    const action: EliseValidatedAction = { type };
    if (typeof candidate.label === 'string' && candidate.label.trim()) {
      action.label = sanitizeText(candidate.label, 80);
    }
    // Preserve known nested refs only when object-shaped and id-like.
    for (const key of ['anchor', 'look', 'item', 'event']) {
      const value = candidate[key];
      if (isRecord(value)) {
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'string') safe[k] = sanitizeText(v, 80);
          else if (typeof v === 'number' && Number.isFinite(v)) safe[k] = v;
          else if (typeof v === 'boolean') safe[k] = v;
        }
        if (Object.keys(safe).length) action[key] = safe;
      }
    }
    actions.push(action);
  }
  return { actions, dropped };
}

export function validateEliseGenerationOutput(input: {
  text: string;
  explanation?: string | null;
  rawActions?: unknown;
  fallbackText: string;
  usedFallback?: boolean;
}): EliseGenerationOutput {
  let validationOutcome: EliseGenerationOutput['metadata']['validationOutcome'] = 'accepted';
  let text = stripUnsafeModelOutput(sanitizeText(input.text ?? '', MAX_TEXT_CHARS));
  let usedFallback = Boolean(input.usedFallback);

  if (!text) {
    text = sanitizeText(input.fallbackText, MAX_TEXT_CHARS);
    usedFallback = true;
    validationOutcome = 'fallback';
  } else if (text.length >= MAX_TEXT_CHARS) {
    validationOutcome = 'truncated';
  }

  let explanation: string | null = null;
  if (typeof input.explanation === 'string' && input.explanation.trim()) {
    explanation = sanitizeText(stripUnsafeModelOutput(input.explanation), MAX_EXPLANATION_CHARS);
    if (!explanation) explanation = null;
  }

  const { actions, dropped } = validateEliseActions(input.rawActions);
  if (dropped && validationOutcome === 'accepted') {
    validationOutcome = 'actions_dropped';
  }

  // Action-only responses are not acceptable — force fallback text.
  if (!text && actions.length > 0) {
    text = sanitizeText(input.fallbackText, MAX_TEXT_CHARS);
    usedFallback = true;
    validationOutcome = 'fallback';
  }

  return {
    text,
    explanation,
    actions,
    metadata: {
      outputVersion: ELISE_OUTPUT_VERSION,
      usedFallback,
      validationOutcome,
    },
  };
}
