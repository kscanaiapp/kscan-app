// stylechat-generate v2 — structured action extraction and validation (pure).
//
// The model may propose actions inside an <actions>[...]</actions> block.
// This module extracts the block, parses strictly, applies the allowlist,
// verifies every referenced id against the authenticated resolved attachment
// set, bounds labels, and drops anything invalid WITHOUT fabricating a
// replacement. The surviving text reply is always preserved. No action ever
// carries arbitrary routes, URLs, RPC names, SQL, or mutations — actions are
// navigation intents only; every mutation still requires an explicit user
// step through established authenticated services.

import type { ResolvedAttachment } from './attachmentContext.ts';

export const STYLECHAT_ACTION_CONTRACT_VERSION = '2';

export const ALLOWED_STYLECHAT_ACTIONS = [
  'open_stylist',
  'style_anchor_item',
  'style_for_event',
  'restyle_outfit',
  'swap_item',
  'open_look',
  'ask_my_room',
] as const;
export type StyleChatActionType = (typeof ALLOWED_STYLECHAT_ACTIONS)[number];

const ALLOWED_OCCASIONS = ['casual', 'work', 'date', 'event', 'travel', 'other'];
const ALLOWED_DRESS_CODES = ['relaxed', 'smart_casual', 'dressy', 'formal'];
const MAX_LABEL_CHARS = 40;
const MAX_ACTIONS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ValidatedStyleChatAction = {
  type: StyleChatActionType;
  label: string;
  contractVersion: typeof STYLECHAT_ACTION_CONTRACT_VERSION;
  payload: {
    anchor?: { sourceType: 'saved_scan' | 'inspiration_item'; sourceId: string };
    keepItems?: Array<{ sourceType: 'saved_scan' | 'inspiration_item'; sourceId: string }>;
    lookId?: string;
    occasion?: string;
    dressCode?: string;
    contextHint?: string;
  };
};

/** Default app-controlled labels; model copy is normalized against these. */
const DEFAULT_LABELS: Record<StyleChatActionType, string> = {
  open_stylist: 'CREATE OUTFITS WITH ELISE',
  style_anchor_item: 'STYLE THIS WITH ELISE',
  style_for_event: 'ASK ELISE TO STYLE THIS EVENT',
  restyle_outfit: 'ASK ELISE TO RESTYLE',
  swap_item: 'ASK ELISE TO SWAP THIS ITEM',
  open_look: 'OPEN THIS LOOK',
  ask_my_room: 'ASK MY ROOM',
};

/**
 * Splits model output into visible reply text and the raw actions block.
 * Missing/malformed tags leave the text intact and produce no actions.
 */
export function extractActionsBlock(rawText: string): { text: string; rawActions: unknown } {
  const text = typeof rawText === 'string' ? rawText : '';
  const match = text.match(/<actions>([\s\S]*?)<\/actions>/i);
  const cleanedText = text
    .replace(/<actions>[\s\S]*?<\/actions>/gi, ' ')
    .replace(/<\/?actions>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!match) return { text: cleanedText, rawActions: null };
  try {
    return { text: cleanedText, rawActions: JSON.parse(match[1]) };
  } catch {
    return { text: cleanedText, rawActions: null };
  }
}

type ResolvedRefIndex = {
  itemKeys: Set<string>;
  lookIds: Set<string>;
};

export function indexResolvedRefs(resolved: ResolvedAttachment[]): ResolvedRefIndex {
  const itemKeys = new Set<string>();
  const lookIds = new Set<string>();
  for (const attachment of resolved) {
    if (attachment.attachmentType === 'look') lookIds.add(attachment.lookId);
    for (const item of attachment.items) {
      if (item.ref.sourceId) itemKeys.add(`${item.ref.sourceType}:${item.ref.sourceId}`);
    }
  }
  return { itemKeys, lookIds };
}

function parseRef(raw: unknown, index: ResolvedRefIndex) {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const sourceType = record.sourceType;
  if (sourceType !== 'saved_scan' && sourceType !== 'inspiration_item') return null;
  if (typeof record.sourceId !== 'string' || !UUID_RE.test(record.sourceId)) return null;
  const sourceId = record.sourceId.toLowerCase();
  // Placeholder/invented/foreign ids: must exist in the resolved set.
  if (!index.itemKeys.has(`${sourceType}:${sourceId}`)) return null;
  return { sourceType, sourceId } as const;
}

function boundLabel(raw: unknown, type: StyleChatActionType): string {
  if (typeof raw !== 'string') return DEFAULT_LABELS[type];
  const text = raw.replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_LABEL_CHARS) return DEFAULT_LABELS[type];
  return text;
}

/**
 * Strict allowlist validation. Unknown fields are removed by reconstruction;
 * invalid actions are dropped entirely (never patched, never replaced).
 */
export function validateStyleChatActions(
  rawActions: unknown,
  resolved: ResolvedAttachment[],
): ValidatedStyleChatAction[] {
  if (!Array.isArray(rawActions)) return [];
  const index = indexResolvedRefs(resolved);
  const validated: ValidatedStyleChatAction[] = [];

  for (const entry of rawActions.slice(0, MAX_ACTIONS * 2)) {
    if (validated.length >= MAX_ACTIONS) break;
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== 'string' || !(ALLOWED_STYLECHAT_ACTIONS as readonly string[]).includes(type)) {
      continue; // unknown / arbitrary action → dropped
    }
    const actionType = type as StyleChatActionType;
    const payload: ValidatedStyleChatAction['payload'] = {};

    if (actionType === 'style_anchor_item' || actionType === 'swap_item') {
      const anchor = parseRef(record.anchor ?? record.item ?? record.itemRef, index);
      if (!anchor) continue; // anchor required and must be a resolved ref
      payload.anchor = anchor;
    } else if (actionType === 'restyle_outfit') {
      const rawKeep = Array.isArray(record.keepItems) ? record.keepItems : [];
      const keepItems = [];
      let valid = true;
      for (const rawRef of rawKeep.slice(0, 6)) {
        const ref = parseRef(rawRef, index);
        if (!ref) { valid = false; break; }
        keepItems.push(ref);
      }
      if (!valid) continue;
      payload.keepItems = keepItems;
      const anchor = parseRef(record.anchor, index);
      if (anchor) payload.anchor = anchor;
    } else if (actionType === 'open_look' || actionType === 'ask_my_room') {
      if (typeof record.lookId !== 'string' || !UUID_RE.test(record.lookId)) continue;
      const lookId = record.lookId.toLowerCase();
      if (!index.lookIds.has(lookId)) continue; // foreign/invented Look id
      payload.lookId = lookId;
    } else if (actionType === 'style_for_event') {
      if (typeof record.occasion === 'string' && ALLOWED_OCCASIONS.includes(record.occasion)) {
        payload.occasion = record.occasion;
      }
      if (typeof record.dressCode === 'string' && ALLOWED_DRESS_CODES.includes(record.dressCode)) {
        payload.dressCode = record.dressCode;
      }
      const anchor = parseRef(record.anchor, index);
      if (anchor) payload.anchor = anchor;
    } else if (actionType === 'open_stylist') {
      const anchor = parseRef(record.anchor, index);
      if (anchor) payload.anchor = anchor;
    }

    if (typeof record.contextHint === 'string') {
      const hint = record.contextHint.replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim();
      if (hint) payload.contextHint = hint.slice(0, 200);
    }

    validated.push({
      type: actionType,
      label: boundLabel(record.label, actionType),
      contractVersion: STYLECHAT_ACTION_CONTRACT_VERSION,
      payload,
    });
  }

  return validated;
}
