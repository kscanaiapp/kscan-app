package com.kscan.glasses.sync

/**
 * Mock Supabase session bridge for tests and local development.
 *
 * No real Supabase SDK. No tokens. No keys.
 */
class MockSupabaseSessionBridge : SupabaseSessionBridge {

    private var _snapshot: SessionSnapshotPlaceholder? = null

    override fun requestSessionSnapshot(): SessionSnapshotPlaceholder? {
        return _snapshot
    }

    override fun notifySessionUpdated(snapshot: SessionSnapshotPlaceholder) {
        _snapshot = snapshot
    }

    fun reset() {
        _snapshot = null
    }
}
