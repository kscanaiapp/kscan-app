import { supabase } from './supabaseClient';

// Shared In-App Room Messaging v1.
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
};

type MessageRow = {
  id: string;
  room_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

const MESSAGE_COLUMNS = 'id, room_id, sender_id, body, created_at';

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
  return data.session?.user?.id ?? null;
}

function toRoomMessage(row: MessageRow, currentUserId: string | null): RoomMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
    isMine: Boolean(currentUserId && row.sender_id === currentUserId),
  };
}

export function normalizeMessageBody(value?: string | null) {
  return String(value ?? '').trim();
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

  const { data, error } = await supabase
    .from('dressing_room_messages')
    .select(MESSAGE_COLUMNS)
    .eq('room_id', normalizedRoomId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    devLog('list failed', error.code);
    throw new Error(isPermissionError(error) ? ROOM_MESSAGES_ACCESS_ERROR : ROOM_MESSAGES_LOAD_ERROR);
  }

  return (data ?? []).map((row) => toRoomMessage(row as MessageRow, currentUserId));
}

export async function sendRoomMessage(roomId: string, body: string): Promise<RoomMessage> {
  const normalizedRoomId = requireRoomId(roomId);
  const normalizedBody = validateMessageBody(body);

  const currentUserId = await getCurrentSessionUserId();
  if (!currentUserId) {
    throw new Error(ROOM_MESSAGE_SIGN_IN_ERROR);
  }

  const { data, error } = await supabase
    .from('dressing_room_messages')
    .insert({
      room_id: normalizedRoomId,
      sender_id: currentUserId,
      body: normalizedBody,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error || !data) {
    devLog('send failed', error?.code);
    throw new Error(isPermissionError(error) ? ROOM_MESSAGES_ACCESS_ERROR : ROOM_MESSAGE_SEND_ERROR);
  }

  return toRoomMessage(data as MessageRow, currentUserId);
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
 * Realtime is deferred to v2. This stub reserves the API name only; it never
 * opens a live subscription.
 */
export function subscribeToRoomMessages(_roomId: string, _onMessage?: (message: RoomMessage) => void): never {
  throw new Error(ROOM_MESSAGES_REALTIME_UNAVAILABLE);
}
