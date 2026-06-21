package com.kscan.glasses.connectivity

/**
 * Mock connectivity transport for tests and local development.
 *
 * No real BluetoothAdapter. No real WifiP2pManager.
 */
class MockConnectivityTransport : BleTransport, WifiTransport {

    override var status: ConnectivityStatus = ConnectivityStatus.DISCONNECTED
        private set

    private val _controlMessages = mutableListOf<String>()
    val controlMessages: List<String> get() = _controlMessages.toList()

    private val _payloadRefs = mutableListOf<String>()
    val payloadRefs: List<String> get() = _payloadRefs.toList()

    override fun connect(): Boolean {
        status = ConnectivityStatus.CONNECTED
        return true
    }

    override fun disconnect(): Boolean {
        status = ConnectivityStatus.DISCONNECTED
        return true
    }

    override fun sendControl(message: String): Boolean {
        _controlMessages.add(message)
        return true
    }

    override fun sendPayloadPlaceholder(payloadRef: String): Boolean {
        _payloadRefs.add(payloadRef)
        return true
    }

    fun reset() {
        status = ConnectivityStatus.DISCONNECTED
        _controlMessages.clear()
        _payloadRefs.clear()
    }
}
