/** TODO: Supabase realtime channel for bridge control messages */
export class SupabaseSessionRelay {
  async connect(_sessionId: string): Promise<void> {
    // stub
  }

  async disconnect(): Promise<void> {
    // stub
  }

  async publish(_channel: string, _payload: string): Promise<void> {
    // stub — never include auth tokens or image data in logs
  }
}
