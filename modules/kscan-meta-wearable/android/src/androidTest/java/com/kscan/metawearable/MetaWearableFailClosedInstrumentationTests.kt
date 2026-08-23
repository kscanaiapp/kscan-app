package com.kscan.metawearable

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device proof that a DAT-off build fabricates nothing.
 *
 * WHY THIS EXISTS. Every previous pass could only assert the fail-closed
 * contract by reading MetaWearableEngine.kt. That is the weakest possible
 * evidence for the property that matters most here: a build without the Meta
 * SDK must never report a connected device, a live session, a camera, a
 * display, or a capture — because anything it invents becomes a fake success
 * the wearer cannot distinguish from a real one.
 *
 * These tests run on a real Android runtime against the real compiled engine
 * resolved by MetaWearableEngineFactory, so they exercise the actual reflection
 * lookup and the actual BuildConfig flag rather than a test double.
 *
 * They are deliberately scoped to the DAT-off configuration. If someone links
 * the DAT SDK, `datOff()` short-circuits every capability assertion instead of
 * asserting the wrong contract — a DAT-on build has its own expectations and
 * must not silently inherit these. `buildIsActuallyDatOff` is the exception: it
 * asserts unconditionally, so the suite can never quietly become a no-op
 * without saying so.
 */
@RunWith(AndroidJUnit4::class)
class MetaWearableFailClosedInstrumentationTests {

    private val engine: MetaWearableEngine get() = MetaWearableEngineFactory.engine

    /** True when this binary genuinely carries no DAT SDK. */
    private fun datOff(): Boolean = !BuildConfig.MWDAT_ENABLED

    /** Asserts [block] throws MetaWearableException with the expected code. */
    private suspend fun assertRefuses(
        name: String,
        expected: String = MetaWearableCodes.ADAPTER_UNAVAILABLE,
        block: suspend () -> Any?,
    ) {
        try {
            val result = block()
            fail("$name returned $result instead of refusing — a DAT-off build fabricated a capability")
        } catch (expectedFailure: MetaWearableException) {
            assertEquals("$name refused with the wrong code", expected, expectedFailure.code)
        }
    }

    @Test
    fun buildIsActuallyDatOff() {
        // Pins the premise of every other test in this class. If this fails the
        // suite is measuring a different binary than it claims to.
        assertFalse(
            "BuildConfig.MWDAT_ENABLED is true — these fail-closed expectations do not apply to a DAT-on build",
            BuildConfig.MWDAT_ENABLED,
        )
    }

    @Test
    fun factoryResolvesTheUnavailableEngine() {
        if (!datOff()) return
        assertTrue(
            "MetaWearableEngineFactory resolved ${engine.javaClass.name} instead of UnavailableEngine",
            engine === UnavailableEngine,
        )
    }

    @Test
    fun statusAdmitsTheSdkIsAbsent() {
        if (!datOff()) return
        val status = engine.status()
        assertEquals("available", false, status["available"])
        assertEquals("sdkLinked", false, status["sdkLinked"])
        assertEquals("initState", MetaInitState.UNINITIALIZED.name, status["initState"])
        assertEquals("reason", "MWDAT_NOT_LINKED", status["reason"])
    }

    @Test
    fun initializeNeverReachesReady() {
        if (!datOff()) return
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // initialize() is the one entry point that must NOT throw — the JS layer
        // calls it eagerly on screen mount and treats a throw as a crash path.
        // It must degrade, not explode, and must not claim READY.
        val status = engine.initialize(context)
        assertEquals(MetaInitState.UNINITIALIZED.name, status["initState"])
        assertEquals(MetaInitState.UNINITIALIZED, engine.initState)
    }

    @Test
    fun noDeviceIsEverInvented() {
        if (!datOff()) return
        assertEquals("registrationState", "UNAVAILABLE", engine.registrationState())
        assertTrue("listDevices returned a device on a build with no SDK", engine.listDevices().isEmpty())
        assertNull("activeDevice returned a device on a build with no SDK", engine.activeDevice())
        assertEquals("deviceState claimed availability", false, engine.deviceState()["available"])
    }

    @Test
    fun noCameraOrDisplayIsEverInvented() {
        if (!datOff()) return
        assertEquals("cameraPermissionStatus", "DENIED", engine.cameraPermissionStatus())
        assertFalse("displayAvailable returned true with no SDK", engine.displayAvailable())
    }

    @Test
    fun everySessionActionRefuses() {
        if (!datOff()) return
        runBlocking {
            assertRefuses("createSession") { engine.createSession() }
            assertRefuses("startSession") { engine.startSession() }
            assertRefuses("stopSession") { engine.stopSession() }
        }
    }

    @Test
    fun everyCameraActionRefuses() {
        if (!datOff()) return
        runBlocking {
            assertRefuses("attachCamera") { engine.attachCamera(mapOf("quality" to "MEDIUM")) }
            assertRefuses("startCamera") { engine.startCamera() }
            assertRefuses("stopCamera") { engine.stopCamera() }
            // The one that matters most: no capture may be produced.
            assertRefuses("capturePhoto") { engine.capturePhoto(1_000L) }
        }
    }

    @Test
    fun everyDisplayActionRefuses() {
        if (!datOff()) return
        runBlocking {
            assertRefuses("attachDisplay") { engine.attachDisplay() }
            assertRefuses("renderResult") { engine.renderResult(mapOf("title" to "x")) }
            assertRefuses("clearDisplay") { engine.clearDisplay() }
        }
    }

    @Test
    fun mockDeviceKitIsNotQuietlyAvailable() {
        if (!datOff()) return
        // MockDeviceKit ships only with the DAT dependency set. A build without
        // it must say so rather than offering a simulator that would produce
        // results indistinguishable from real hardware.
        assertFalse("mockSupported() is true without the DAT SDK", engine.mockSupported())
        runBlocking {
            assertRefuses("mockEnable") { engine.mockEnable(emptyMap()) }
            assertRefuses("mockPairGlasses") { engine.mockPairGlasses("ray-ban") }
            assertRefuses("mockSetDevicePower") { engine.mockSetDevicePower(true) }
            assertRefuses("mockSetWorn") { engine.mockSetWorn(true) }
            assertRefuses("mockDisconnect") { engine.mockDisconnect() }
            assertRefuses("mockDisable") { engine.mockDisable() }
        }
    }

    @Test
    fun disconnectIsABenignNoOpRatherThanAFakeSuccess() {
        if (!datOff()) return
        runBlocking {
            val result = engine.disconnect()
            // Tearing down nothing legitimately succeeds, but it must announce
            // that it did nothing rather than implying a device was released.
            assertEquals(true, result["ok"])
            assertEquals(true, result["noop"])
        }
    }

    @Test
    fun observerAttachesAndDetachesWithoutLeaking() {
        if (!datOff()) return
        // The module attaches exactly one observer in OnCreate and closes it in
        // OnDestroy. A React context recreation therefore runs this cycle
        // repeatedly; it must be safe every time and must never deliver events
        // from a build that has no device to report.
        var delivered = 0
        repeat(5) {
            val handle = engine.observe { _, _ -> delivered++ }
            handle.close()
            handle.close() // double close must not throw
        }
        assertEquals("a DAT-off engine emitted device events", 0, delivered)
    }

    @Test
    fun repeatedResolutionReturnsTheSameEngineInstance() {
        if (!datOff()) return
        // The factory memoises via `by lazy`. If it ever resolved twice it could
        // hand two different engines to the module and the observer, which is
        // how duplicate listener/state-machine bugs start.
        assertTrue(MetaWearableEngineFactory.engine === MetaWearableEngineFactory.engine)
    }
}
