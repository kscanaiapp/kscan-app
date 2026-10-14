import { createClient } from 'npm:@supabase/supabase-js@2.105.4';
import { createStylistSpeechHandler } from './handler.ts';
import type {
  SpeechMessageRow,
  SpeechSessionRow,
  StylistPreferenceRow,
  StylistSpeechDataAccess,
} from './types.ts';

function readPublishableKey(): string {
  const configured = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as Record<string, unknown>;
      const key = typeof parsed.default === 'string' ? parsed.default.trim() : '';
      if (key) return key;
    } catch {
      // Fall through to the legacy project key while it remains available.
    }
  }
  return Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? '';
}

function createDataAccess(authHeader: string): StylistSpeechDataAccess {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? '';
  const publishableKey = readPublishableKey();
  if (!supabaseUrl || !publishableKey) {
    throw new Error('Supabase function environment is unavailable.');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const client = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  // The privileged client is used only for service-only cost ledger RPCs after
  // the request actor and owned message have been independently verified.
  function costClient() {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    if (!serviceKey) throw new Error('Speech cost controls are unavailable.');
    return createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return {
    async getAuthenticatedActor() {
      const { data, error } = await client.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id, isAnonymous: data.user.is_anonymous === true };
    },
    async getAccountStatus(actorId) {
      const { data, error } = await client
        .from('profiles')
        .select('account_status, account_locked_at')
        .eq('id', actorId)
        .maybeSingle();
      return !error && data?.account_locked_at == null && typeof data?.account_status === 'string'
        ? data.account_status : null;
    },
    async hasActiveKPlus(actorId) {
      // JWT-bound RPC resolves auth.uid() inside Postgres. Never query
      // service-role entitlements directly or accept an actor from the body.
      const { data, error } = await client.rpc('has_active_k_plus');
      if (error) return false;
      return data === true;
    },
    async reserveSpeechRequest(actorId, fingerprint, characters) {
      const { data, error } = await costClient().rpc('reserve_speech_request', {
        p_user_id: actorId, p_fingerprint: fingerprint, p_characters: characters,
      });
      if (error || !data || typeof data.allowed !== 'boolean') throw new Error('Speech cost controls are unavailable.');
      return data;
    },
    async finishSpeechRequest(actorId, reservationId, succeeded) {
      const { error } = await costClient().rpc('finish_speech_request', {
        p_user_id: actorId, p_reservation_id: reservationId, p_succeeded: succeeded,
      });
      if (error) throw new Error('Speech cost finalization unavailable.');
    },
    async getSession(sessionId, actorId) {
      const { data, error } = await client
        .from('style_chat_sessions')
        .select('id, user_id')
        .eq('id', sessionId)
        .eq('user_id', actorId)
        .maybeSingle();
      if (error) return null;
      return data as SpeechSessionRow | null;
    },
    async getMessage(messageId, actorId) {
      const { data, error } = await client
        .from('style_chat_messages')
        .select('id, session_id, user_id, sender, content, ui_blocks, provider')
        .eq('id', messageId)
        .eq('user_id', actorId)
        .maybeSingle();
      if (error) return null;
      return data as SpeechMessageRow | null;
    },
    async getStylistPreference(actorId) {
      const { data, error } = await client
        .from('user_stylist_preferences')
        .select('avatar_id')
        .eq('user_id', actorId)
        .maybeSingle();
      if (error) return null;
      return data as StylistPreferenceRow | null;
    },
  };
}

const handler = createStylistSpeechHandler({
  createDataAccess,
  env: { get: (name) => Deno.env.get(name) },
});

Deno.serve(handler);
