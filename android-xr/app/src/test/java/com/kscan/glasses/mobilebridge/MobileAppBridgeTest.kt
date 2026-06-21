package com.kscan.glasses.mobilebridge

import com.kscan.glasses.bridge.BridgeMode
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileAppBridgeTest {

    @Test
    fun `save action message shape`() = runTest {
        val bridge = MockMobileAppBridge()
        val result = bridge.requestSave("item-1", "Wool Blazer")

        assertTrue(result is MobileAppBridgeResult.Success)
        assertEquals(1, bridge.requests.size)
        val msg = bridge.requests[0] as MobileAppBridgeMessage.SaveItem
        assertEquals("item-1", msg.itemId)
        assertEquals("Wool Blazer", msg.label)
    }

    @Test
    fun `open-on-phone message shape`() = runTest {
        val bridge = MockMobileAppBridge()
        val result = bridge.requestOpen("result-42")

        assertTrue(result is MobileAppBridgeResult.Success)
        assertEquals(1, bridge.requests.size)
        val msg = bridge.requests[0] as MobileAppBridgeMessage.OpenResult
        assertEquals("result-42", msg.resultId)
    }

    @Test
    fun `session placeholder shape`() = runTest {
        val bridge = MockMobileAppBridge()
        val snapshot = SessionSnapshot(
            sessionId = "session-abc",
            bridgeMode = BridgeMode.MOCK,
            scanCount = 3,
        )
        bridge.setSessionSnapshot(snapshot)

        val result = bridge.requestSessionSnapshot()
        assertEquals("session-abc", result?.sessionId)
        assertEquals(3, result?.scanCount)
    }

    @Test
    fun `route validation returns correct route`() {
        val bridge = MockMobileAppBridge()
        assertEquals(MobileAppRoute.HANDOFF_RESULT, bridge.validateRoute("kscan://glasses/handoff/result/123"))
        assertEquals(MobileAppRoute.HANDOFF_SAVE, bridge.validateRoute("kscan://glasses/handoff/save/123"))
        assertEquals(MobileAppRoute.HANDOFF_OPEN, bridge.validateRoute("kscan://glasses/handoff/open/123"))
        assertEquals(MobileAppRoute.SESSION_REQUEST, bridge.validateRoute("kscan://glasses/session/request"))
    }

    @Test
    fun `invalid route fails safely`() {
        val bridge = MockMobileAppBridge()
        assertNull(bridge.validateRoute("kscan://unknown/path"))
        assertNull(bridge.validateRoute("https://example.com"))
        assertNull(bridge.validateRoute(""))
    }

    @Test
    fun `buildHandoffUri produces valid scheme`() {
        val bridge = MockMobileAppBridge()
        val uri = bridge.buildHandoffUri(MobileAppRoute.HANDOFF_SAVE)
        assertTrue(uri.startsWith("kscan://glasses/handoff/save/"))
    }
}
