import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveWriteAuthority } from './actorContext';
import { buildSavedLookReturnContext } from './privateSavedLookHandoff';
import type { SavedLookReturnContextV1 } from '../types/privateSavedLookHandoff';

export const SAVED_LOOK_RETURN_CONTEXT_KEY =
  'kscan_private_dressing_room_saved_look_return_context_v1';

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
): Promise<SavedLookReturnContextV1 | null> {
  const actorId = actorFor(actorRequest);
  if (!actorId) return null;
  const raw = await AsyncStorage.getItem(SAVED_LOOK_RETURN_CONTEXT_KEY).catch(() => null);
  const stored = parseSerialized(raw);
  if (actorFor(actorRequest) !== actorId || stored?.actorId !== actorId) return null;
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
