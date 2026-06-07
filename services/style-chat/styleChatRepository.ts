import { supabase } from '../supabaseClient';
import type {
  StyleChatMessage,
  StyleChatMode,
  StyleChatSession,
  StyleChatUiBlock,
} from './types';

// ── Auth helper ───────────────────────────────────────────────────────────────
// Mirrors getCurrentSessionUserId() in styleObjects.ts — never trust a
// user_id from the UI; always derive from the live Supabase session.

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id ?? null;
  if (!id) throw new Error('Sign in to use StyleChat.');
  return id;
}

// ── Row shapes returned by Supabase ───────────────────────────────────────────

interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  mode: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  user_id: string;
  sender: string;
  content: string;
  referenced_scan_ids: string[];
  referenced_saved_item_ids: string[];
  referenced_dressing_room_ids: string[];
  referenced_catalog_items: string[];
  ui_blocks: StyleChatUiBlock[];
  provider: string | null;
  model: string | null;
  token_estimate: number;
  created_at: string;
}

// ── Row → domain mappers ──────────────────────────────────────────────────────

function toSession(row: SessionRow): StyleChatSession {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as StyleChatMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): StyleChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    sender: row.sender as StyleChatMessage['sender'],
    content: row.content,
    referencedScanIds: row.referenced_scan_ids ?? [],
    referencedSavedItemIds: row.referenced_saved_item_ids ?? [],
    referencedDressingRoomIds: row.referenced_dressing_room_ids ?? [],
    referencedCatalogItems: row.referenced_catalog_items ?? [],
    uiBlocks: Array.isArray(row.ui_blocks) ? row.ui_blocks : [],
    provider: row.provider ?? 'mock',
    model: row.model ?? undefined,
    tokenEstimate: row.token_estimate ?? 0,
    createdAt: row.created_at,
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function listStyleChatSessions(): Promise<StyleChatSession[]> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from('style_chat_sessions')
    .select('id, user_id, title, mode, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data as SessionRow[]).map(toSession);
}

export async function createStyleChatSession(input: {
  title?: string;
  mode?: StyleChatMode;
}): Promise<StyleChatSession> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from('style_chat_sessions')
    .insert({
      user_id: userId,
      title: input.title?.trim() || 'New Styling Session',
      mode: input.mode ?? 'general',
    })
    .select('id, user_id, title, mode, created_at, updated_at')
    .single();

  if (error) throw new Error(error.message);
  return toSession(data as SessionRow);
}

export async function getStyleChatSession(sessionId: string): Promise<StyleChatSession | null> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from('style_chat_sessions')
    .select('id, user_id, title, mode, created_at, updated_at')
    .eq('id', sessionId)
    .eq('user_id', userId)  // belt-and-suspenders: RLS also enforces this
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return toSession(data as SessionRow);
}

async function touchSession(sessionId: string): Promise<void> {
  // Best-effort updated_at bump; failure is non-fatal
  await supabase
    .from('style_chat_sessions')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', sessionId);
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function listStyleChatMessages(sessionId: string): Promise<StyleChatMessage[]> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from('style_chat_messages')
    .select(
      'id, session_id, user_id, sender, content, referenced_scan_ids, referenced_saved_item_ids, referenced_dressing_room_ids, referenced_catalog_items, ui_blocks, provider, model, token_estimate, created_at',
    )
    .eq('session_id', sessionId)
    .eq('user_id', userId)  // belt-and-suspenders
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data as MessageRow[]).map(toMessage);
}

export async function saveStyleChatMessage(input: {
  sessionId: string;
  sender: StyleChatMessage['sender'];
  content: string;
  uiBlocks?: StyleChatUiBlock[];
  provider?: string;
  model?: string;
  referencedScanIds?: string[];
  referencedSavedItemIds?: string[];
  referencedDressingRoomIds?: string[];
  referencedCatalogItems?: string[];
}): Promise<StyleChatMessage> {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from('style_chat_messages')
    .insert({
      session_id: input.sessionId,
      user_id: userId,
      sender: input.sender,
      content: input.content,
      ui_blocks: input.uiBlocks ?? [],
      provider: input.provider ?? 'mock',
      model: input.model ?? null,
      referenced_scan_ids: input.referencedScanIds ?? [],
      referenced_saved_item_ids: input.referencedSavedItemIds ?? [],
      referenced_dressing_room_ids: input.referencedDressingRoomIds ?? [],
      referenced_catalog_items: input.referencedCatalogItems ?? [],
    })
    .select(
      'id, session_id, user_id, sender, content, referenced_scan_ids, referenced_saved_item_ids, referenced_dressing_room_ids, referenced_catalog_items, ui_blocks, provider, model, token_estimate, created_at',
    )
    .single();

  if (error) throw new Error(error.message);

  // Best-effort session timestamp bump; fire-and-forget
  void touchSession(input.sessionId);

  return toMessage(data as MessageRow);
}

// ── Usage ─────────────────────────────────────────────────────────────────────

export interface UsageRecord {
  messagesUsed: number;
  messagesLimit: number;
}

export async function readStyleChatUsage(): Promise<UsageRecord> {
  const userId = await requireUserId();
  const periodStart = new Date();
  periodStart.setDate(1);
  const periodStartStr = periodStart.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('style_chat_usage')
    .select('messages_used')
    .eq('user_id', userId)
    .eq('period_start', periodStartStr)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return {
    messagesUsed: (data as { messages_used: number } | null)?.messages_used ?? 0,
    messagesLimit: 50,
  };
}

export async function incrementStyleChatUsage(): Promise<UsageRecord> {
  const { data, error } = await supabase.rpc('increment_style_chat_usage');
  if (error) throw new Error(error.message);

  // rpc returns an array of rows from the RETURNS TABLE
  const row = Array.isArray(data) ? data[0] : data;
  return {
    messagesUsed: row?.messages_used ?? 1,
    messagesLimit: row?.messages_limit ?? 50,
  };
}

// ── Daily usage (v0.4 beta cap) ───────────────────────────────────────────────
// Reads today's usage from style_chat_daily_usage via the server RPC.
// The Edge Function is the authority for enforcement; this is display-only.

export async function readStyleChatDailyUsage(): Promise<UsageRecord> {
  const { data, error } = await supabase.rpc('get_stylechat_daily_usage');
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    messagesUsed: row?.messages_used ?? 0,
    messagesLimit: row?.messages_limit ?? 25,
  };
}
