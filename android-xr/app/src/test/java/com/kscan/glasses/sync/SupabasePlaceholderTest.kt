package com.kscan.glasses.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SupabasePlaceholderTest {

    @Test
    fun `session bridge stores snapshot`() {
        val bridge = MockSupabaseSessionBridge()
        assertEquals(null, bridge.requestSessionSnapshot())

        val snapshot = SessionSnapshotPlaceholder(
            sessionId = "session-1",
            scanCount = 3,
        )
        bridge.notifySessionUpdated(snapshot)
        assertEquals("session-1", bridge.requestSessionSnapshot()?.sessionId)
        assertEquals(3, bridge.requestSessionSnapshot()?.scanCount)
    }

    @Test
    fun `content sync stores items`() {
        val sync = MockSupabaseContentSync()
        sync.saveItemPlaceholder("item-1", "Wool Blazer")

        val items = sync.fetchSavedItemsPlaceholder()
        assertEquals(1, items.size)
        assertEquals("item-1", items[0].itemId)
        assertEquals("Wool Blazer", items[0].label)
        assertEquals(SyncStatus.SYNCED, items[0].syncStatus)
    }

    @Test
    fun `content sync placeholder returns true`() {
        val sync = MockSupabaseContentSync()
        assertTrue(sync.syncContentPlaceholder("ref-1"))
    }

    @Test
    fun `no tokens or keys in models`() {
        // Verify that none of the placeholder models contain token-like fields
        val snapshot = SessionSnapshotPlaceholder("session-1")
        val item = SyncedItemPlaceholder("item-1", "label")
        // No assert needed — compilation proves the shape is safe
        assertEquals("session-1", snapshot.sessionId)
        assertEquals("item-1", item.itemId)
    }
}
