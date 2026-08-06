import { supabase } from './supabaseClient';
import { DRESSING_ROOM_THREADS_V1 } from '../constants/featureFlags';
import {
  bumpCollabActorGeneration,
  createCollaborationMessage,
  createCollabRequestId,
  getCollabActorGeneration,
  isCurrentCollabGeneration,
  listCollaborationMessages,
  catchUpCollaborationMessages,
  mergeMessagesById,
  type CollaborationRoomMessage,
  type MessageCursor,
} from './dressingRoomCollaboration';

// Shared In-App Room Messaging v1 + DR-3 cursor/idempotent extensions.
//
// Backed by public.dressing_room_messages. RLS grants read/write to the room
// OWNER and to AUTHORIZED PARTICIPANTS who joined via an active share token
// (see public.can_access_room_messages / public.join_room_via_share_token).
// This is real shared-room collaboration: every authorized participant can read
// and send, with backend persistence (not a single-user or device-local store).
//
// Message bodies are never exposed by the public link-share preview: the table
// is never selected, joined, counted, or returned by get_public_room_preview.
//
// Privacy rules for this module:
//   * Never log message bodies, auth tokens, sender IDs, or share tokens.
//   * Never surface raw Supabase/Postgres/RLS errors to the UI — every
//     thrown error carries a friendly, user-safe message.

export const ROOM_MESSAGE_MAX_LENGTH = 1000;

export const ROOM_MESSAGES_LOAD_ERROR = "We couldn't load messages. Please try again.";
export const ROOM_MESSAGE_SEND_ERROR = "We couldn't send that message. Please try again.";
export const ROOM_MESSAGES_ACCESS_ERROR = 'You no longer have access to this room.';
export const ROOM_MESSAGES_STALE_ERROR = 'This room session is no longer active.';
export const ROOM_MESSAGE_SIGN_IN_ERROR = 'Sign in to view and send room messages.';
export const ROOM_MESSAGE_EMPTY_ERROR = 'Message cannot be empty.';
export const ROOM_MESSAGE_TOO_LONG_ERROR = `Messages must be ${ROOM_MESSAGE_MAX_LENGTH} characters or fewer.`;
export const ROOM_JOIN_ERROR = "We couldn't open that shared room. The link may be invalid or no longer active.";
const ROOM_MESSAGES_REALTIME_UNAVAILABLE = 'Live message updates are not available yet.';

export type RoomMessage = {
  id: string;
  roomId: string;
  senderId: string;
  body: string;
  createdAt: string;
  isMine: boolean;
  clientMessageId?: string | null;
  parentMessageId?: string | null;
};

function threadsEnabled() {
  return DRESSING_ROOM_THREADS_V1;
}

function fromCollaborationMessage(message: CollaborationRoomMessage): RoomMessage {
  return {
    id: message.id,
    roomId: message.roomId,
    senderId: message.senderId,
    body: message.body,
    createdAt: message.createdAt,
    isMine: message.isMine,
    clientMessageId: message.clientMessageId ?? null,
    parentMessageId: message.parentMessageId ?? null,
  };
}

function devLog(event: string, code?: string | number | null) {
  // Safe metadata only: event name + error code. Never bodies/IDs/tokens.
  if (__DEV__) {
    console.warn(`[roomMessages] ${event}`, code ? { code } : undefined);
  }
}

function isPermissionError(error: { code?: string; status?: number } | null) {
  if (!error) return false;
  const code = String(error.code ?? '');
  // 42501: Postgres insufficient_privilege (RLS rejection).
  // PGRST301: PostgREST JWT/authorization failure.
  return code === '42501' || code === 'PGRST301' || error.status === 401 || error.status === 403;
}

function requireRoomId(roomId?: string | null) {
  const normalized = String(roomId ?? '').trim();
  if (!normalized) {
    throw new Error(ROOM_MESSAGES_LOAD_ERROR);
  }
  return normalized;
}

async function getCurrentSessionUserId() {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? null;
  bumpCollabActorGeneration(userId);
  return userId;
}

export function normalizeMessageBody(value?: string | null) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

export function validateMessageBody(value?: string | null) {
  const body = normalizeMessageBody(value);
  if (body.length === 0) {
    throw new Error(ROOM_MESSAGE_EMPTY_ERROR);
  }
  if (body.length > ROOM_MESSAGE_MAX_LENGTH) {
    throw new Error(ROOM_MESSAGE_TOO_LONG_ERROR);
  }
  return body;
}

export async function listRoomMessages(roomId: string): Promise<RoomMessage[]> {
  const normalizedRoomId = requireRoomId(roomId);
  const currentUserId = await getCurrentSessionUserId();
  if (!currentUserId) {
    throw new Error(ROOM_MESSAGE_SIGN_IN_ERROR);
  }

  const generation = getCollabActorGeneration();
  const page = await listCollaborationMessages({ roomId: normalizedRoomId });
  if (!isCurrentCollabGeneration(generation)) {
    throw new Error(ROOM_MESSAGES_STALE_ERROR);
  }
  return page.messages.map(fromCollaborationMessage);
}

export async function listRoomMessagesPage(input: {
  roomId: string;
  cursor?: MessageCursor | null;
  direction?: 'older' | 'newer';
  limit?: number;
}): Promise<{
  messages: RoomMessage[];
  nextCursor: MessageCursor | null;
  newestCursor: MessageCursor | null;
  accessVersion: number;
}> {
  const normalizedRoomId = requireRoomId(input.roomId);
  const currentUserId = await getCurrentSessionUserId();
  if (!currentUserId) {
    throw new Error(ROOM_MESSAGE_SIGN_IN_ERROR);
  }
  const generation = getCollabActorGeneration();
  const page = await listCollaborationMessages({
    roomId: normalizedRoomId,
    cursor: input.cursor,
    direction: input.direction,
    limit: input.limit,
  });
  if (!isCurrentCollabGeneration(generation)) {
    throw new Error(ROOM_MESSAGES_STALE_ERROR);
  }
  return {
    messages: page.messages.map(fromCollaborationMessage),
    nextCursor: page.nextCursor,
    newestCursor: page.newestCursor,
    accessVersion: page.accessVersion,
  };
}

export async function catchUpRoomMessages(input: {
  roomId: string;
  fromCursor: MessageCursor | null;
}): Promise<{
  messages: RoomMessage[];
  newestCursor: MessageCursor | null;
  accessVersion: number;
}> {
  const normalizedRoomId = requireRoomId(input.roomId);
  const currentUserId = await getCurrentSessionUserId();
  if (!currentUserId) {
    throw new Error(ROOM_MESSAGE_SIGN_IN_ERROR);
  }
  const generation = getCollabActorGeneration();
  const page = await catchUpCollaborationMessages({
    roomId: normalizedRoomId,
    fromCursor: input.fromCursor,
  });
  if (!isCurrentCollabGeneration(generation)) {
    throw new Error(ROOM_MESSAGES_STALE_ERROR);
  }
  return {
    messages: page.messages.map(fromCollaborationMessage),
    newestCursor: page.newestCursor,
    accessVersion: page.accessVersion,
  };
}

export function mergeRoomMessages(
  existing: RoomMessage[],
  incoming: RoomMessage[],
): RoomMessage[] {
  return mergeMessagesById(
    existing.map((m) => ({
      ...m,
      clientMessageId: m.clientMessageId ?? null,
      parentMessageId: m.parentMessageId ?? null,
    })),
    incoming.map((m) => ({
      ...m,
      clientMessageId: m.clientMessageId ?? null,
      parentMessageId: m.parentMessageId ?? null,
    })),
  );
}

export async function sendRoomMessage(
  roomId: string,
  body: string,
  options?: { parentMessageId?: string | null; clientMessageId?: string },
): Promise<RoomMessage> {
  const normalizedRoomId = requireRoomId(roomId);
  const normalizedBody = validateMessageBody(body);

  const currentUserId = await getCurrentSessionUserId();
  if (!currentUserId) {
    throw new Error(ROOM_MESSAGE_SIGN_IN_ERROR);
  }

  const parentMessageId = threadsEnabled() ? options?.parentMessageId ?? null : null;
  const clientMessageId = options?.clientMessageId ?? createCollabRequestId();
  const generation = getCollabActorGeneration();
  const sent = await createCollaborationMessage({
    roomId: normalizedRoomId,
    text: normalizedBody,
    clientMessageId,
    parentMessageId,
  });
  if (!isCurrentCollabGeneration(generation)) {
    throw new Error(ROOM_MESSAGES_STALE_ERROR);
  }
  return fromCollaborationMessage(sent);
}

/**
 * Join a shared Dressing Room as an authenticated participant using an active
 * share token, then return the room id so the caller can open in-room chat.
 *
 * Membership is created server-side by the SECURITY DEFINER RPC, which validates
 * the token. Authentication is required (anonymous guests cannot join). The
 * share token is never logged.
 */
export async function joinSharedRoom(shareToken: string): Promise<string> {
  const normalizedToken = String(shareToken ?? '').trim();
  if (!normalizedToken) {
    throw new Error(ROOM_JOIN_ERROR);
  }

  const currentUserId = await getCurrentSessionUserId();
  if (!currentUserId) {
    throw new Error(ROOM_MESSAGE_SIGN_IN_ERROR);
  }

  const { data, error } = await supabase.rpc('join_room_via_share_token', {
    p_share_token: normalizedToken,
  });

  if (error || !data) {
    devLog('join failed', error?.code);
    throw new Error(isPermissionError(error) ? ROOM_MESSAGES_ACCESS_ERROR : ROOM_JOIN_ERROR);
  }

  return String(data);
}

/**
 * Realtime remains deferred. Prefer startCollaborationBoundedRefresh when
 * DRESSING_ROOM_REALTIME_SYNC_V1 is enabled at the UI layer.
 */
export function subscribeToRoomMessages(_roomId: string, _onMessage?: (message: RoomMessage) => void): never {
  throw new Error(ROOM_MESSAGES_REALTIME_UNAVAILABLE);
}
