package com.kscan.glasses.connectivity

/**
 * Bluetooth transport placeholder.
 *
 * No real BluetoothAdapter. No real BLE implementation.
 * Compile-safe stub for future Phase 3+ work.
 */
interface BleTransport {
    fun connect(): Boolean
    fun disconnect(): Boolean
    fun sendControl(message: String): Boolean
    fun sendPayloadPlaceholder(payloadRef: String): Boolean
    val status: ConnectivityStatus
}
