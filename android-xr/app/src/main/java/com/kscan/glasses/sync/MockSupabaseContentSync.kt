package com.kscan.glasses.sync

/**
 * Mock Supabase content sync for tests and local development.
 *
 * No real Supabase SDK. No tokens. No keys.
 */
class MockSupabaseContentSync : SupabaseContentSync {

    private val _items = mutableListOf<SyncedItemPlaceholder>()
    val items: List<SyncedItemPlaceholder> get() = _items.toList()

    override fun saveItemPlaceholder(itemId: String, label: String): Boolean {
        _items.add(SyncedItemPlaceholder(itemId, label, SyncStatus.SYNCED))
        return true
    }

    override fun fetchSavedItemsPlaceholder(): List<SyncedItemPlaceholder> {
        return _items.toList()
    }

    override fun syncContentPlaceholder(contentRef: String): Boolean {
        return true
    }

    fun reset() {
        _items.clear()
    }
}
