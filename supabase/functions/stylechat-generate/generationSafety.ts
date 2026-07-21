export const GENERATION_OPERATION_TYPE = 'stylechat_generate_reply';

export interface GenerationIdentityInput {
  actorId: string;
  sessionId: string;
  sourceMessageId?: string | null;
  message: string;
  requestId: string;
}

export interface GenerationIdentity {
  operationType: typeof GENERATION_OPERATION_TYPE;
  operationKey: string;
  requestId: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildGenerationIdentity(
  input: GenerationIdentityInput,
): Promise<GenerationIdentity> {
  const stableSource = input.sourceMessageId?.trim() ||
    `legacy-message-hash:${(await sha256Hex(input.message.trim())).slice(0, 32)}`;
  return {
    operationType: GENERATION_OPERATION_TYPE,
    operationKey: [
      input.actorId,
      input.sessionId,
      stableSource,
      GENERATION_OPERATION_TYPE,
    ].join(':'),
    requestId: input.requestId,
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
