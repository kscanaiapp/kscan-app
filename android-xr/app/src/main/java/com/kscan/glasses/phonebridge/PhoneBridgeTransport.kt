package com.kscan.glasses.phonebridge

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * Raw string frame transport for the versioned phone bridge.
 *
 * Deliberately carries RAW frames, not typed messages: malformed, oversized,
 * and otherwise hostile frames must be able to reach the validator so it can
 * reject them with a safe code. Typed decode happens only after validation.
 *
 * **Implementer contract:** real transports (BLE/Wi-Fi/socket) MUST abort or
 * close the read path before assembling a UTF-8 frame larger than
 * [PhoneBridgeProtocol.MAX_MESSAGE_BYTES]. The validator's byte-ceiling check
 * runs on an already-materialized [String] and cannot prevent unbounded
 * allocation at the wire boundary.
 */
interface PhoneBridgeTransport {
    /** Inbound raw frames from the peer, in arrival order. */
    val incoming: Flow<String>

    /** Queues a raw frame for delivery to the peer. */
    suspend fun send(raw: String)

    /** Closes the transport; no further frames are delivered. */
    fun close()
}

/**
 * In-memory loopback pair: two endpoints wired to each other, used by the mock
 * phone companion and by tests. [glassesSide] is the endpoint the glasses
 * runtime uses; [phoneSide] is the one the companion uses.
 */
class InMemoryTransportPair(
    capacity: Int = Channel.BUFFERED,
) {
    private val glassesToPhone = Channel<String>(capacity)
    private val phoneToGlasses = Channel<String>(capacity)

    val glassesSide: PhoneBridgeTransport = Endpoint(
        outbound = glassesToPhone,
        inbound = phoneToGlasses,
        peer = { phoneSideOpen = false },
    )

    val phoneSide: PhoneBridgeTransport = Endpoint(
        outbound = phoneToGlasses,
        inbound = glassesToPhone,
        peer = { glassesSideOpen = false },
    )

    private var glassesSideOpen = true
    private var phoneSideOpen = true

    private inner class Endpoint(
        private val outbound: Channel<String>,
        private val inbound: Channel<String>,
        private val peer: () -> Unit,
    ) : PhoneBridgeTransport {
        override val incoming: Flow<String> = inbound.receiveAsFlow()

        override suspend fun send(raw: String) {
            outbound.send(raw)
        }

        override fun close() {
            peer()
            outbound.close()
        }
    }
}
