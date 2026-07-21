import {
  GENERATION_OPERATION_TYPE,
  type EliseGenerationOperationStatus,
  type EliseOperationReservation,
} from './eliseGenerationTypes.ts';

export { GENERATION_OPERATION_TYPE };

export interface GenerationIdentityInput {
  actorId: string;
  sessionId: string;
  sourceMessageId?: string | null;
  /** Server request id — used for legacy requests without sourceMessageId. */
  requestId: string;
  /** Legacy fallback only when neither sourceMessageId nor requestId can bind. */
  message?: string;
}

export interface GenerationIdentity {
  operationType: typeof GENERATION_OPERATION_TYPE;
  operationKey: string;
  requestId: string;
  sourceMessageId: string | null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Preferred identity: actor + session + sourceMessageId + operation type.
 * When sourceMessageId is absent, bind to server requestId (not raw message text alone).
 */
export async function buildGenerationIdentity(
  input: GenerationIdentityInput,
): Promise<GenerationIdentity> {
  const sourceMessageId = input.sourceMessageId?.trim() || null;
  let stableSource: string;
  if (sourceMessageId) {
    stableSource = sourceMessageId;
  } else if (input.requestId.trim()) {
    stableSource = `request:${input.requestId.trim().slice(0, 80)}`;
  } else {
    const message = (input.message ?? '').trim();
    stableSource = `legacy-message-hash:${(await sha256Hex(message)).slice(0, 32)}`;
  }
  return {
    operationType: GENERATION_OPERATION_TYPE,
    operationKey: [
      input.actorId,
      input.sessionId,
      stableSource,
      GENERATION_OPERATION_TYPE,
    ].join(':'),
    requestId: input.requestId,
    sourceMessageId,
  };
}

export async function validateSourceMessageOwnership(input: {
  userClient: { from(table: string): any };
  sourceMessageId?: string | null;
  actorId: string;
  sessionId: string;
}): Promise<boolean> {
  if (!input.sourceMessageId) return true;
  const { data, error } = await input.userClient
    .from('style_chat_messages')
    .select('id')
    .eq('id', input.sourceMessageId)
    .eq('session_id', input.sessionId)
    .eq('user_id', input.actorId)
    .eq('sender', 'user')
    .maybeSingle();
  return !error && Boolean(data);
}

export async function validateSessionOwnership(input: {
  userClient: { from(table: string): any };
  sessionId: string;
  actorId: string;
}): Promise<boolean> {
  const { data, error } = await input.userClient
    .from('style_chat_sessions')
    .select('id')
    .eq('id', input.sessionId)
    .eq('user_id', input.actorId)
    .maybeSingle();
  return !error && Boolean(data);
}

/**
 * Supabase `.rpc()` returns a thenable PostgrestFilterBuilder, not a full Promise
 * (no `.catch` / `.finally` / `[Symbol.toStringTag]`). Model it as PromiseLike so
 * real SupabaseClient values assign without casts while await still works.
 */
export type GenerationRpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

export type GenerationRpcClient = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<GenerationRpcResult>;
  from(table: string): any;
};

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  if (data && typeof data === 'object') return data as T;
  return null;
}

export async function reserveGenerationOperation(input: {
  userClient: GenerationRpcClient;
  sessionId: string;
  sourceMessageId: string | null;
  operationKey: string;
  requestId: string;
}): Promise<EliseOperationReservation | null> {
  const { data, error } = await input.userClient.rpc('reserve_elise_generation_operation', {
    p_session_id: input.sessionId,
    p_source_message_id: input.sourceMessageId,
    p_operation_key: input.operationKey,
    p_request_id: input.requestId,
    p_operation_type: GENERATION_OPERATION_TYPE,
  });
  if (error) return null;
  const row = firstRow<Record<string, unknown>>(data);
  if (!row || typeof row.operation_id !== 'string') return null;
  return {
    operationId: String(row.operation_id),
    status: String(row.status) as EliseGenerationOperationStatus,
    attemptCount: typeof row.attempt_count === 'number' ? row.attempt_count : 1,
    assistantMessageId: typeof row.assistant_message_id === 'string' ? row.assistant_message_id : null,
    isDuplicate: Boolean(row.is_duplicate),
    mayGenerate: Boolean(row.may_generate),
    stableErrorClass: typeof row.stable_error_class === 'string' ? row.stable_error_class : null,
  };
}

export async function markGenerationGenerating(
  userClient: GenerationRpcClient,
  operationId: string,
): Promise<boolean> {
  const { data, error } = await userClient.rpc('mark_elise_generation_generating', {
    p_operation_id: operationId,
  });
  return !error && Boolean(data);
}

export async function revalidateGenerationContext(input: {
  userClient: GenerationRpcClient;
  operationId: string;
  sessionId: string;
  sourceMessageId: string | null;
}): Promise<{ valid: boolean; reason: string | null }> {
  const { data, error } = await input.userClient.rpc('revalidate_elise_generation_context', {
    p_operation_id: input.operationId,
    p_session_id: input.sessionId,
    p_source_message_id: input.sourceMessageId,
  });
  if (error) return { valid: false, reason: 'rpc_error' };
  const row = firstRow<Record<string, unknown>>(data);
  if (!row) return { valid: false, reason: 'empty' };
  return {
    valid: Boolean(row.valid),
    reason: typeof row.reason === 'string' ? row.reason : null,
  };
}

export async function finalizeGenerationOperation(input: {
  userClient: GenerationRpcClient;
  operationId: string;
  status: EliseGenerationOperationStatus;
  assistantMessageId?: string | null;
  stableErrorClass?: string | null;
}): Promise<boolean> {
  const { data, error } = await input.userClient.rpc('finalize_elise_generation_operation', {
    p_operation_id: input.operationId,
    p_status: input.status,
    p_assistant_message_id: input.assistantMessageId ?? null,
    p_stable_error_class: input.stableErrorClass ?? null,
  });
  return !error && Boolean(data);
}

export async function loadAssistantMessageById(input: {
  userClient: GenerationRpcClient;
  actorId: string;
  sessionId: string;
  assistantMessageId: string;
}): Promise<{ content: string; model: string | null; tokenEstimate: number } | null> {
  const { data, error } = await input.userClient
    .from('style_chat_messages')
    .select('id,content,model,token_estimate,sender,user_id,session_id')
    .eq('id', input.assistantMessageId)
    .eq('user_id', input.actorId)
    .eq('session_id', input.sessionId)
    .eq('sender', 'assistant')
    .maybeSingle();
  if (error || !data) return null;
  const content = typeof data.content === 'string' ? data.content : '';
  if (!content.trim()) return null;
  return {
    content,
    model: typeof data.model === 'string' ? data.model : null,
    tokenEstimate: typeof data.token_estimate === 'number' ? data.token_estimate : 0,
  };
}

/**
 * Persist assistant reply once under the actor/session/source-message unique index.
 * On unique conflict, recover the existing row.
 */
export async function persistAssistantOnce(input: {
  userClient: GenerationRpcClient;
  actorId: string;
  sessionId: string;
  sourceMessageId: string | null;
  content: string;
  model: string;
  tokenEstimate: number;
}): Promise<{ id: string; content: string; duplicate: boolean } | null> {
  const insertPayload: Record<string, unknown> = {
    session_id: input.sessionId,
    user_id: input.actorId,
    sender: 'assistant',
    content: input.content.trim(),
    provider: 'gemini',
    model: input.model,
    token_estimate: input.tokenEstimate,
    referenced_scan_ids: [],
    referenced_saved_item_ids: [],
    referenced_dressing_room_ids: [],
    referenced_catalog_items: [],
    ui_blocks: [],
  };
  if (input.sourceMessageId) {
    insertPayload.source_message_id = input.sourceMessageId;
  }

  const { data, error } = await input.userClient
    .from('style_chat_messages')
    .insert(insertPayload)
    .select('id,content')
    .single();

  if (!error && data?.id) {
    return { id: String(data.id), content: String(data.content ?? input.content), duplicate: false };
  }

  const message = error?.message ?? '';
  if (
    input.sourceMessageId &&
    /duplicate|unique|style_chat_assistant_source_message_unique/i.test(message)
  ) {
    const { data: existing } = await input.userClient
      .from('style_chat_messages')
      .select('id,content')
      .eq('session_id', input.sessionId)
      .eq('user_id', input.actorId)
      .eq('sender', 'assistant')
      .eq('source_message_id', input.sourceMessageId)
      .maybeSingle();
    if (existing?.id) {
      return {
        id: String(existing.id),
        content: String(existing.content ?? input.content),
        duplicate: true,
      };
    }
  }
  return null;
}
