package com.kscan.glasses.phonebridge

import android.content.Context
import java.util.UUID

/** App-scoped opaque device binding. It is not an Android hardware identifier or user credential. */
object WearableDeviceIdentity {
    private const val PREFS = "kscan_wearable_identity"
    private const val KEY = "device_id"

    fun getOrCreate(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.takeIf(::isValid)?.let { return it }
        val id = UUID.randomUUID().toString()
        check(prefs.edit().putString(KEY, id).commit()) { "device identity storage unavailable" }
        return id
    }

    private fun isValid(value: String): Boolean = runCatching { UUID.fromString(value) }.isSuccess
}
