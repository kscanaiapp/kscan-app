package com.kscan.glasses.network

/**
 * Stub for Supabase session / message relay between glasses and phone app.
 *
 * TODO: Wire @supabase/supabase-js equivalent on Android or delegate to phone-bridge only.
 * Do not log auth tokens or store face metadata.
 */
class SupabaseSyncClient {
    suspend fun connect(sessionId: String): Result<Unit> {
        return Result.failure(UnsupportedOperationException("SupabaseSyncClient not implemented"))
    }

    suspend fun disconnect() {}

    suspend fun publishMessage(channel: String, payload: String): Result<Unit> {
        return Result.failure(UnsupportedOperationException("SupabaseSyncClient not implemented"))
    }
}
