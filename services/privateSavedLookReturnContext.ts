import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveWriteAuthority } from './actorContext';
import { buildSavedLookReturnContext } from './privateSavedLookHandoff';
import type { PrivateSavedLookV1 } from '../types/privateSavedLook';
import type { SavedLookReturnContextV1 } from '../types/privateSavedLookHandoff';

export const SAVED_LOOK_RETURN_CONTEXT_KEY =
  'kscan_private_dressing_room_saved_look_return_context_v1';

/**
 * How long a missing-piece return context stays usable.
 *
 * This is presentation state for one round trip out to a commerce surface and
 * back. It is not a durable record, and it has no expiry today, so a context
 * written weeks ago still highlights a slot on an unrelated later visit. Thirty
 * minutes is generous for the round trip it describes and short enough that a
 * forgotten context cannot resurface as a mystery highlight.
 */
export const SAVED_LOOK_RETURN_CONTEXT_TTL_MS = 30 * 60 * 1000;

/**
 * Fails closed on an unreadable or impossible timestamp, including one in the
 * future: a clock that moved backwards must not extend the window indefinitely.
 */
export function isReturnContextExpired(
  context: SavedLookReturnContextV1,
  nowMs: number = Date.now(),
): boolean {
  const created = Date.parse(context?.createdAt);
  if (!Number.isFinite(created) || !Number.isFinite(nowMs)) return true;
  const age = nowMs - created;
  return age < 0 || age > SAVED_LOOK_RETURN_CONTEXT_TTL_MS;
}

/**
 * The slot a context may highlight on a loaded Saved Look, or null.
 *
 * Pure, and deliberately stricter than an id comparison: the context must name
 * THIS Look and a slot that Look still has. A Look edited between handoff and
 * return can lose the slot the context refers to, and highlighting a slot that
 * is no longer part of the composition would point the user at nothing.
 */
export function resolveReturnContextSlot(
  context: SavedLookReturnContextV1 | null | undefined,
  savedLook: PrivateSavedLookV1 | null | undefined,
): SavedLookReturnContextV1['slotKey'] | null {
  if (!context || !savedLook) return null;
  if (!context.savedLookId || context.savedLookId !== savedLook.id) return null;
  const slots = Array.isArray(savedLook.slots) ? savedLook.slots : [];
  return slots.some((slot) => slot?.slotKey === context.slotKey) ? context.slotKey : null;
}

type StoredContext = {
  schemaVersion: 1;
  actorId: string;
  context: SavedLookReturnContextV1;
};

function actorFor(request: unknown): string | null {
  const authority = resolveWriteAuthority(request, undefined) as {
    ok: boolean;
    ownerId?: string | null;
  };
  return authority.ok && authority.ownerId ? authority.ownerId : null;
}

function parse(value: unknown): StoredContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.actorId !== 'string' || !raw.actorId) return null;
  const context = raw.context as Record<string, unknown> | null;
  const parsed = context
    ? buildSavedLookReturnContext({
        savedLookId: String(context.savedLookId ?? ''),
        slotKey: context.slotKey,
        returnRoute: String(context.returnRoute ?? ''),
        now: String(context.createdAt ?? ''),
      })
    : null;
  return parsed ? { schemaVersion: 1, actorId: raw.actorId, context: parsed } : null;
}

function parseSerialized(raw: string | null): StoredContext | null {
  if (!raw) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function persistSavedLookReturnContext(
  actorRequest: unknown,
  context: SavedLookReturnContextV1,
): Promise<boolean> {
  const actorId = actorFor(actorRequest);
  if (!actorId) return false;
  const parsed = buildSavedLookReturnContext({ ...context, now: context.createdAt });
  if (!parsed) return false;
  const stored: StoredContext = { schemaVersion: 1, actorId, context: parsed };
  await AsyncStorage.setItem(SAVED_LOOK_RETURN_CONTEXT_KEY, JSON.stringify(stored));
  return actorFor(actorRequest) === actorId;
}

export async function loadSavedLookReturnContext(
  actorRequest: unknown,
  options?: { nowMs?: number },
): Promise<SavedLookReturnContextV1 | null> {
  const actorId = actorFor(actorRequest);
  if (!actorId) return null;
  const raw = await AsyncStorage.getItem(SAVED_LOOK_RETURN_CONTEXT_KEY).catch(() => null);
  const stored = parseSerialized(raw);
  if (actorFor(actorRequest) !== actorId || stored?.actorId !== actorId) return null;
  // Expired context is dead presentation state: refuse it AND drop it, so it
  // cannot resurface later. Only this actor's own entry is removed — the actor
  // match above has already been proven.
  if (isReturnContextExpired(stored.context, options?.nowMs ?? Date.now())) {
    await AsyncStorage.removeItem(SAVED_LOOK_RETURN_CONTEXT_KEY).catch(() => null);
    return null;
  }
  return stored.context;
}

export async function clearSavedLookReturnContext(actorRequest: unknown): Promise<boolean> {
  const actorId = actorFor(actorRequest);
  if (!actorId) return false;
  const raw = await AsyncStorage.getItem(SAVED_LOOK_RETURN_CONTEXT_KEY).catch(() => null);
  const stored = parseSerialized(raw);
  if (!stored || stored.actorId !== actorId) return true;
  await AsyncStorage.removeItem(SAVED_LOOK_RETURN_CONTEXT_KEY);
  return actorFor(actorRequest) === actorId;
}
