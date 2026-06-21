package com.kscan.glasses.connectivity

/**
 * Wi-Fi transport placeholder.
 *
 * No real WifiP2pManager. No real Wi-Fi Direct implementation.
 * Compile-safe stub for future Phase 3+ work.
 */
interface WifiTransport {
    fun connect(): Boolean
    fun disconnect(): Boolean
    fun sendControl(message: String): Boolean
    fun sendPayloadPlaceholder(payloadRef: String): Boolean
    val status: ConnectivityStatus
}
