package com.kscan.glasses.connectivity

/**
 * Connectivity manager placeholder.
 *
 * Exposes the future API shape without real transport.
 */
class BridgeConnectivityManager(
    private val transport: BleTransport = MockConnectivityTransport(),
) {

    val status: ConnectivityStatus get() = transport.status

    fun connect(): Boolean = transport.connect()
    fun disconnect(): Boolean = transport.disconnect()
    fun sendControl(message: String): Boolean = transport.sendControl(message)
    fun sendPayloadPlaceholder(payloadRef: String): Boolean = transport.sendPayloadPlaceholder(payloadRef)
}
