package com.kscan.glasses.mobilebridge

/**
 * In-memory mock mobile app bridge for tests and local development.
 *
 * No real intents, no real phone app dependency.
 */
class MockMobileAppBridge : MobileAppBridge {

    private val _requests = mutableListOf<MobileAppBridgeMessage>()
    val requests: List<MobileAppBridgeMessage>
        get() = _requests.toList()

    private var _sessionSnapshot: SessionSnapshot? = null

    override suspend fun requestSave(itemId: String, label: String): MobileAppBridgeResult {
        _requests.add(MobileAppBridgeMessage.SaveItem(itemId, label))
        return MobileAppBridgeResult.Success()
    }

    override suspend fun requestOpen(resultId: String): MobileAppBridgeResult {
        _requests.add(MobileAppBridgeMessage.OpenResult(resultId))
        return MobileAppBridgeResult.Success()
    }

    override suspend fun requestSessionSnapshot(): SessionSnapshot? {
        _requests.add(MobileAppBridgeMessage.RequestSession("mock-session"))
        return _sessionSnapshot
    }

    override fun buildHandoffUri(route: MobileAppRoute): String {
        return when (route) {
            MobileAppRoute.HANDOFF_RESULT -> "${route.path}result-123"
            MobileAppRoute.HANDOFF_SAVE -> "${route.path}item-123"
            MobileAppRoute.HANDOFF_OPEN -> "${route.path}result-123"
            MobileAppRoute.SESSION_REQUEST -> route.path
        }
    }

    override fun validateRoute(route: String): MobileAppRoute? {
        return MobileAppRoute.fromUri(route)
    }

    /** Set a mock session snapshot for testing. */
    fun setSessionSnapshot(snapshot: SessionSnapshot) {
        _sessionSnapshot = snapshot
    }

    /** Reset recorded state. */
    fun reset() {
        _requests.clear()
        _sessionSnapshot = null
    }
}
