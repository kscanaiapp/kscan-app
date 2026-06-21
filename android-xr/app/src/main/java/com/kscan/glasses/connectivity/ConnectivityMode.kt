package com.kscan.glasses.connectivity

/**
 * Connectivity mode for glasses ↔ phone transport.
 *
 * Phase 2: MOCK only. No real BLE or Wi-Fi Direct.
 */
enum class ConnectivityMode {
    MOCK,
    BLE,
    WIFI_DIRECT,
    OFF,
}
