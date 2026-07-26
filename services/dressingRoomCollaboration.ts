/**
 * DR-3 server-authoritative collaboration access + mutation helpers.
 *
 * Security never depends on client feature flags — RPCs/RLS enforce access.
 * Flags only gate next-build UI/client wiring.
 */
import * as ExpoCrypto from 'expo-crypto';
import { supabase } from './supabaseClient';

export const DR3_COLLAB_PAGE_SIZE = 30;
export const DR3_COLLAB_REFRESH_MS = 12_000;
export const DR3_COLLAB_REFRESH_MAX_MS = 60_000;
export const DR3_COLLAB_CATCHUP_MAX_PAGES = 5;

export const COLLAB_ACCESS_ERROR = 'You no longer have access to this room.';

export function isCollaborationAccessError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'string') {
    return (
      error === COLLAB_ACCESS_ERROR ||
      /no longer have access|unavailable|unauthorized|42501|PGRST301/i.test(error)
    );
  }
  if (error instanceof Error) {
    return isCollaborationAccessError(error.message);
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return isCollaborationAccessError(String((error as { message: unknown }).message));
  }
  return false;
}

export type CollaborationRelationship = 'owner' | 'shared_recipient';

export type CollaborationAccessDecision =
  | {
      ok: true;
      roomId: string;
      authenticatedActorId: string;
      currentOwnerId: string;
      relationship: CollaborationRelationship;
      canView: true;
      canReact: true;
      canMessage: true;
      canReply: true;
      canSubscribe: true;
      canUpdateReadState: false;
      accessVersion: number;
    }
  | {
      ok: false;
      reason: 'unauthenticated' | 'unauthorized' | 'not_found' | 'unavailable';
      roomId?: string;
      accessVersion?: number;
    };

export type MessageCursor = {
  createdAt: string;
  id: string;
  direction?: 'older' | 'newer';
};

export type CollaborationRoomMessage = {
  id: string;
  roomId: string;
  senderId: string;
  body: string;
  createdAt: string;
  clientMessageId?: string | null;
  parentMessageId?: string | null;
  isMine: boolean;
};

/** Cryptographically strong UUIDv4 for idempotency keys. Never Date.now()+Math.random(). */
export function createCollabRequestId(): string {
  // Web/runtime crypto when present (web builds, newer engines).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Hermes may have no global Web Crypto. Use the already-installed native
  // Expo module so Room Chat and reaction idempotency keys remain available.
  if (typeof ExpoCrypto.randomUUID === 'function') {
    return ExpoCrypto.randomUUID();
  }
  // RFC4122 v4 from expo-crypto secure bytes for runtimes where its UUID
  // convenience API is unavailable.
  const bytes = ExpoCrypto.getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV4(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCollaborationAccess(raw: unknown): CollaborationAccessDecision {
  const row = asRecord(raw);
  if (!row) return { ok: false, reason: 'unavailable' };
  if (row.ok !== true) {
    const reason =
      row.reason === 'unauthenticated' ||
      row.reason === 'not_found' ||
      row.reason === 'unauthorized'
        ? row.reason
        : 'unauthorized';
    return {
      ok: false,
      reason,
      roomId: typeof row.roomId === 'string' ? row.roomId : undefined,
      accessVersion:
        typeof row.accessVersion === 'number' ? row.accessVersion : undefined,
    };
  }
  const relationship =
    row.relationship === 'owner' || row.relationship === 'shared_recipient'
      ? row.relationship
      : null;
  if (
    typeof row.roomId !== 'string' ||
    typeof row.authenticatedActorId !== 'string' ||
    typeof row.currentOwnerId !== 'string' ||
    !relationship ||
    typeof row.accessVersion !== 'number'
  ) {
    return { ok: false, reason: 'unavailable' };
  }
  return {
    ok: true,
    roomId: row.roomId,
    authenticatedActorId: row.authenticatedActorId,
    currentOwnerId: row.currentOwnerId,
    relationship,
    canView: true,
    canReact: true,
    canMessage: true,
    canReply: true,
    canSubscribe: true,
    canUpdateReadState: false,
    accessVersion: row.accessVersion,
  };
}

/**
 * Pure merge for keyset pages + live inserts. Dedupes by stable message id.
 * Live messages never advance the historical "older" cursor.
 */
export function mergeMessagesById(
  existing: CollaborationRoomMessage[],
  incoming: CollaborationRoomMessage[],
): CollaborationRoomMessage[] {
  const map = new Map<string, CollaborationRoomMessage>();
  for (const message of existing) map.set(message.id, message);
  for (const message of incoming) map.set(message.id, message);
  return [...map.values()].sort((a, b) => {
    const byTime = a.createdAt.localeCompare(b.createdAt);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

export function olderCursorFromMessages(
  messages: CollaborationRoomMessage[],
): MessageCursor | null {
  if (messages.length === 0) return null;
  const first = messages[0];
  return { createdAt: first.createdAt, id: first.id, direction: 'older' };
}

export function newestCursorFromMessages(
  messages: CollaborationRoomMessage[],
): MessageCursor | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  return { createdAt: last.createdAt, id: last.id, direction: 'newer' };
}

/** Actor-generation token: stale responses/events must not apply across switches. */
let collabActorGeneration = 0;
let collabActorId: string | null = null;

export function bumpCollabActorGeneration(actorId: string | null): number {
  const next = actorId ?? null;
  if (next !== collabActorId) {
    collabActorId = next;
    collabActorGeneration += 1;
  }
  return collabActorGeneration;
}

export function getCollabActorGeneration(): number {
  return collabActorGeneration;
}

export function isCurrentCollabGeneration(generation: number): boolean {
  return generation === collabActorGeneration;
}

export async function resolveCollaborationAccess(
  roomId: string,
): Promise<CollaborationAccessDecision> {
  const normalized = String(roomId ?? '').trim();
  if (!normalized) return { ok: false, reason: 'unauthorized' };

  const { data, error } = await supabase.rpc(
    'resolve_dressing_room_collaboration_access',
    { p_room_id: normalized },
  );
  if (error) return { ok: false, reason: 'unavailable' };
  return parseCollaborationAccess(data);
}

export async function setItemReactionDesiredState(input: {
  roomId: string;
  itemId: string;
  reactionType: string;
  active: boolean;
  requestId: string;
}): Promise<{
  ok: true;
  roomId: string;
  itemId: string;
  reactionType: string;
  active: boolean;
  myReaction: string | null;
  requestId: string;
  accessVersion: number;
}> {
  if (!isUuidV4(input.requestId)) {
    throw new Error('Invalid request id');
  }
  const { data, error } = await supabase.rpc('set_dressing_room_item_reaction', {
    p_room_id: input.roomId,
    p_item_id: input.itemId,
    p_reaction_type: input.reactionType,
    p_active: input.active,
    p_request_id: input.requestId,
  });
  if (error || !data) {
    throw new Error("We couldn't save that reaction. Please try again.");
  }
  const row = asRecord(data);
  if (!row || row.ok !== true) {
    throw new Error("We couldn't save that reaction. Please try again.");
  }
  return {
    ok: true,
    roomId: String(row.roomId),
    itemId: String(row.itemId),
    reactionType: String(row.reactionType),
    active: Boolean(row.active),
    myReaction: typeof row.myReaction === 'string' ? row.myReaction : null,
    requestId: String(row.requestId),
    accessVersion: Number(row.accessVersion) || 0,
  };
}

function mapMessageRow(
  row: Record<string, unknown>,
  currentUserId: string | null,
): CollaborationRoomMessage | null {
  if (typeof row.id !== 'string' || typeof row.roomId !== 'string') return null;
  if (typeof row.senderId !== 'string' || typeof row.body !== 'string') return null;
  if (typeof row.createdAt !== 'string') return null;
  return {
    id: row.id,
    roomId: row.roomId,
    senderId: row.senderId,
    body: row.body,
    createdAt: row.createdAt,
    clientMessageId:
      typeof row.clientMessageId === 'string' ? row.clientMessageId : null,
    parentMessageId:
      typeof row.parentMessageId === 'string' ? row.parentMessageId : null,
    isMine: Boolean(currentUserId && row.senderId === currentUserId),
  };
}

export async function listCollaborationMessages(input: {
  roomId: string;
  limit?: number;
  cursor?: MessageCursor | null;
  direction?: 'older' | 'newer';
}): Promise<{
  messages: CollaborationRoomMessage[];
  nextCursor: MessageCursor | null;
  newestCursor: MessageCursor | null;
  accessVersion: number;
}> {
  const { data: sessionData } = await supabase.auth.getSession();
  const currentUserId = sessionData.session?.user?.id ?? null;

  const { data, error } = await supabase.rpc('list_dressing_room_messages', {
    p_room_id: input.roomId,
    p_limit: input.limit ?? DR3_COLLAB_PAGE_SIZE,
    p_cursor_created_at: input.cursor?.createdAt ?? null,
    p_cursor_id: input.cursor?.id ?? null,
    p_direction: input.direction ?? input.cursor?.direction ?? 'older',
  });
  if (error || !data) {
    throw new Error("We couldn't load messages. Please try again.");
  }
  const row = asRecord(data);
  if (!row || row.ok !== true) {
    throw new Error('You no longer have access to this room.');
  }
  const messagesRaw = Array.isArray(row.messages) ? row.messages : [];
  const messages = messagesRaw
    .map((item) => mapMessageRow(asRecord(item) ?? {}, currentUserId))
    .filter((item): item is CollaborationRoomMessage => Boolean(item));

  const next = asRecord(row.nextCursor);
  const newest = asRecord(row.newestCursor);
  return {
    messages,
    nextCursor:
      next && typeof next.createdAt === 'string' && typeof next.id === 'string'
        ? {
            createdAt: next.createdAt,
            id: next.id,
            direction: 'older',
          }
        : null,
    newestCursor:
      newest && typeof newest.createdAt === 'string' && typeof newest.id === 'string'
        ? {
            createdAt: newest.createdAt,
            id: newest.id,
            direction: 'newer',
          }
        : null,
    accessVersion: Number(row.accessVersion) || 0,
  };
}

export async function createCollaborationMessage(input: {
  roomId: string;
  text: string;
  clientMessageId: string;
  parentMessageId?: string | null;
}): Promise<CollaborationRoomMessage> {
  if (!isUuidV4(input.clientMessageId)) {
    throw new Error('Invalid client message id');
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const currentUserId = sessionData.session?.user?.id ?? null;

  const { data, error } = await supabase.rpc('create_dressing_room_message', {
    p_room_id: input.roomId,
    p_body: input.text,
    p_client_message_id: input.clientMessageId,
    p_parent_message_id: input.parentMessageId ?? null,
  });
  if (error || !data) {
    throw new Error("We couldn't send that message. Please try again.");
  }
  const mapped = mapMessageRow(asRecord(data) ?? {}, currentUserId);
  if (!mapped) {
    throw new Error("We couldn't send that message. Please try again.");
  }
  return mapped;
}

export type CollabSyncHandle = {
  stop: () => void;
};

export async function catchUpCollaborationMessages(input: {
  roomId: string;
  fromCursor: MessageCursor | null;
  maxPages?: number;
}): Promise<{
  messages: CollaborationRoomMessage[];
  newestCursor: MessageCursor | null;
  accessVersion: number;
}> {
  const maxPages = Math.max(1, Math.min(input.maxPages ?? DR3_COLLAB_CATCHUP_MAX_PAGES, 10));
  if (!input.fromCursor) {
    const page = await listCollaborationMessages({ roomId: input.roomId });
    return {
      messages: page.messages,
      newestCursor: page.newestCursor,
      accessVersion: page.accessVersion,
    };
  }

  let cursor: MessageCursor | null = {
    createdAt: input.fromCursor.createdAt,
    id: input.fromCursor.id,
    direction: 'newer',
  };
  let accessVersion = 0;
  let collected: CollaborationRoomMessage[] = [];
  let newestCursor: MessageCursor | null = input.fromCursor;

  for (let pageIndex = 0; pageIndex < maxPages && cursor; pageIndex += 1) {
    const page = await listCollaborationMessages({
      roomId: input.roomId,
      cursor,
      direction: 'newer',
      limit: DR3_COLLAB_PAGE_SIZE,
    });
    accessVersion = page.accessVersion;
    collected = mergeMessagesById(collected, page.messages);
    newestCursor = page.newestCursor ?? newestCursor;
    if (!page.messages.length || page.messages.length < DR3_COLLAB_PAGE_SIZE) {
      break;
    }
    cursor = page.newestCursor
      ? { ...page.newestCursor, direction: 'newer' }
      : null;
  }

  return { messages: collected, newestCursor, accessVersion };
}

/**
 * Bounded refresh + access revalidation. Realtime stays OFF by default —
 * this is the safe sync path until a private revocation channel is proven.
 */
export function startCollaborationBoundedRefresh(input: {
  roomId: string;
  actorGeneration: number;
  knownAccessVersion: number;
  onAccessLost: () => void;
  onTick: (accessVersion: number) => void | Promise<void>;
  intervalMs?: number;
}): CollabSyncHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = input.intervalMs ?? DR3_COLLAB_REFRESH_MS;
  let accessVersion = input.knownAccessVersion;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void run();
    }, delay);
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const run = async () => {
    if (stopped || !isCurrentCollabGeneration(input.actorGeneration)) {
      stop();
      return;
    }
    try {
      const access = await resolveCollaborationAccess(input.roomId);
      if (stopped || !isCurrentCollabGeneration(input.actorGeneration)) {
        stop();
        return;
      }
      if (!access.ok) {
        input.onAccessLost();
        stop();
        return;
      }
      if (
        typeof access.accessVersion === 'number' &&
        access.accessVersion !== accessVersion
      ) {
        // Access still ok but version advanced (e.g. owner revoke then re-share).
        // Revalidate already succeeded; adopt the new version for subsequent ticks.
        accessVersion = access.accessVersion;
      }
      await input.onTick(access.accessVersion);
      if (stopped || !isCurrentCollabGeneration(input.actorGeneration)) {
        stop();
        return;
      }
      delay = input.intervalMs ?? DR3_COLLAB_REFRESH_MS;
    } catch (error) {
      if (isCollaborationAccessError(error)) {
        input.onAccessLost();
        stop();
        return;
      }
      delay = Math.min(delay * 2, DR3_COLLAB_REFRESH_MAX_MS);
    }
    schedule();
  };

  schedule();
  return { stop };
}
