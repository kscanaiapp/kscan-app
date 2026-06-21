package com.kscan.glasses.connectivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectivityPlaceholderTest {

    @Test
    fun `mock transport status changes`() {
        val transport = MockConnectivityTransport()
        assertEquals(ConnectivityStatus.DISCONNECTED, transport.status)

        transport.connect()
        assertEquals(ConnectivityStatus.CONNECTED, transport.status)

        transport.disconnect()
        assertEquals(ConnectivityStatus.DISCONNECTED, transport.status)
    }

    @Test
    fun `mock transport records control messages`() {
        val transport = MockConnectivityTransport()
        transport.sendControl("hello")
        assertEquals(1, transport.controlMessages.size)
        assertEquals("hello", transport.controlMessages[0])
    }

    @Test
    fun `mock transport records payload refs`() {
        val transport = MockConnectivityTransport()
        transport.sendPayloadPlaceholder("ref-123")
        assertEquals(1, transport.payloadRefs.size)
        assertEquals("ref-123", transport.payloadRefs[0])
    }

    @Test
    fun `bridge manager delegates to transport`() {
        val transport = MockConnectivityTransport()
        val manager = BridgeConnectivityManager(transport)

        manager.connect()
        assertEquals(ConnectivityStatus.CONNECTED, manager.status)

        manager.sendControl("test")
        assertEquals(1, transport.controlMessages.size)
    }
}
