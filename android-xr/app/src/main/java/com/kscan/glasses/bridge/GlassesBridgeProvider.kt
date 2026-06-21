package com.kscan.glasses.bridge

/**
 * Abstract bridge provider contract for glasses ↔ phone communication.
 *
 * This is a **pure contract** — no transport implementation, no Jetpack XR,
 * no Glimmer, no Cast, no Bluetooth, no Wi-Fi, no camera APIs.
 *
 * Implementations may record messages in memory for testing/demo purposes.
 */
interface GlassesBridgeProvider {

    /** Returns true if a glasses device is currently logically connected. */
    val isConnected: Boolean

    /** Returns the current cached device state, or null if none. */
    val currentState: DeviceState?

    /** Send a message toward the glasses or phone bridge. */
    fun send(message: BridgeMessage)

    /** Register a listener for incoming bridge messages. */
    fun registerListener(listener: BridgeListener)

    /** Unregister a previously registered listener. */
    fun unregisterListener(listener: BridgeListener)

    /** Reset/clear any in-memory state (useful for tests). */
    fun reset()

    /** Listener interface for bridge message observation. */
    fun interface BridgeListener {
        fun onMessage(message: BridgeMessage)
    }
}
