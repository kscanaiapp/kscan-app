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

  return {
    async getAuthenticatedActor() {
      const { data, error } = await client.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id };
    },
    async getAccountStatus(actorId) {
      const { data } = await client
        .from('profiles')
        .select('account_status')
        .eq('id', actorId)
        .maybeSingle();
      return typeof data?.account_status === 'string' ? data.account_status : null;
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
