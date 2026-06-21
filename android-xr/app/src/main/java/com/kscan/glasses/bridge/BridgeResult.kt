package com.kscan.glasses.bridge

sealed class BridgeResult<out T> {
    data class Success<out T>(val data: T) : BridgeResult<T>()
    data class Failure(val error: Throwable) : BridgeResult<Nothing>()
}
