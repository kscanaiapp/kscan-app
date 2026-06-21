package com.kscan.glasses.sync

/**
 * Supabase session bridge placeholder.
 *
 * No real Supabase SDK. No tokens. No keys.
 * Compile-safe stub for future session handoff.
 */
interface SupabaseSessionBridge {
    fun requestSessionSnapshot(): SessionSnapshotPlaceholder?
    fun notifySessionUpdated(snapshot: SessionSnapshotPlaceholder)
}

/**
 * Supabase content sync placeholder.
 *
 * No real Supabase SDK. No tokens. No keys.
 */
interface SupabaseContentSync {
    fun saveItemPlaceholder(itemId: String, label: String): Boolean
    fun fetchSavedItemsPlaceholder(): List<SyncedItemPlaceholder>
    fun syncContentPlaceholder(contentRef: String): Boolean
}

/** Lightweight session snapshot placeholder. No tokens, no secrets. */
data class SessionSnapshotPlaceholder(
    val sessionId: String,
    val lastActivityAtMs: Long? = null,
    val scanCount: Int = 0,
)

/** Lightweight synced item placeholder. No user data, no image bytes. */
data class SyncedItemPlaceholder(
    val itemId: String,
    val label: String,
    val syncStatus: SyncStatus = SyncStatus.PENDING,
)

enum class SyncStatus {
    PENDING,
    SYNCED,
    FAILED,
    OFFLINE,
}
