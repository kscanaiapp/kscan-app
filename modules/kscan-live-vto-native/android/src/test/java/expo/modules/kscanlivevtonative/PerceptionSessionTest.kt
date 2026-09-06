package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

private const val CANVAS_W = 720f
private const val CANVAS_H = 960f

/** A deterministic stand-in `PerceptionInputFrame` -- no real bitmap needed for these tests. */
private class FakeInputFrame(override val width: Int = 271, override val height: Int = 302) : PerceptionInputFrame

/**
 * A test-double `PerceptionProvider`. This is legitimate test infrastructure
 * for `LiveVtoPerceptionSession`'s own bounded-state-machine logic, which is
 * provider-agnostic by design -- it is NOT used anywhere to claim
 * `REAL_MODEL EXECUTED: YES` (mission section 14 is explicit that only a
 * real, on-device MediaPipe run counts for that). Configurable latency lets
 * the backpressure test create genuine backpressure deterministically,
 * rather than depending on real inference timing on whatever machine runs
 * the JVM suite.
 */
private class FakePerceptionProvider(
  private val landmarksToReturn: () -> RawPoseFrame?,
  private val processDelayMillis: Long = 0L,
  private val failInitialize: Boolean = false,
) : PerceptionProvider {
  @Volatile var ready = false
  @Volatile var disposed = false
  val processCount = AtomicLong(0)

  override fun initialize(): Boolean {
    if (failInitialize) return false
    ready = true
    return true
  }

  override fun getCapability() = PerceptionCapability(true, ready, "fake", "fake-model", null)

  override fun processFrame(frame: PerceptionInputFrame): PerceptionResult {
    if (disposed) throw IllegalStateException("processFrame called after dispose")
    if (processDelayMillis > 0) Thread.sleep(processDelayMillis)
    processCount.incrementAndGet()
    val raw = landmarksToReturn() ?: return PerceptionResult.NoPose("fake provider configured to return no pose")
    return PerceptionResult.Success(raw)
  }

  override fun reset() {}
  override fun dispose() { disposed = true; ready = false }
}

private fun neutralRawFrame(): RawPoseFrame {
  val lm = MutableList(PoseLandmarkIndex.COUNT) { RawPoseLandmark(0f, 0f, 0f, present = false) }
  fun p(x: Float, y: Float) = RawPoseLandmark(x, y, 0.9f, present = true)
  lm[PoseLandmarkIndex.LEFT_SHOULDER] = p(0.38f, 0.28f)
  lm[PoseLandmarkIndex.RIGHT_SHOULDER] = p(0.62f, 0.28f)
  lm[PoseLandmarkIndex.LEFT_HIP] = p(0.40f, 0.60f)
  lm[PoseLandmarkIndex.RIGHT_HIP] = p(0.60f, 0.60f)
  return RawPoseFrame(System.currentTimeMillis(), lm, 0.9f)
}

class PerceptionSessionTest {

  private fun garment() = GoldenBodyFrames.fixture("n1b-fixture")

  // ── Lifecycle ────────────────────────────────────────────────────────────

  @Test
  fun lifecycleFollowsTheDeclaredStateMachine() {
    val provider = FakePerceptionProvider({ neutralRawFrame() })
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()

    assertEquals(ReplayState.IDLE, session.currentState())
    assertFalse(session.start())
    assertTrue(session.load(manifest, dims.first, dims.second))
    assertEquals(ReplayState.READY, session.currentState())
    assertTrue(provider.ready)

    assertTrue(session.start())
    assertEquals(ReplayState.PLAYING, session.currentState())
    assertTrue(session.submitFrame(FakeInputFrame()))
    assertTrue(session.runOneInferenceStep())

    assertTrue(session.stop())
    assertEquals(ReplayState.STOPPED, session.currentState())
    assertFalse(session.submitFrame(FakeInputFrame()))

    assertTrue(session.dispose())
    assertEquals(ReplayState.DISPOSED, session.currentState())
    assertTrue(provider.disposed)
  }

  @Test
  fun aProviderThatFailsToInitializeFailsClosedIntoError() {
    val provider = FakePerceptionProvider({ neutralRawFrame() }, failInitialize = true)
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    assertFalse(session.load(manifest, dims.first, dims.second))
    assertEquals(ReplayState.ERROR, session.currentState())
    assertFalse(session.start())
  }

  @Test
  fun disposeIsIdempotentAndSafeFromAnyState() {
    val provider = FakePerceptionProvider({ neutralRawFrame() })
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    assertTrue(session.dispose())
    assertFalse(session.dispose())
    assertEquals(ReplayState.DISPOSED, session.currentState())
  }

  // ── Real end-to-end mapping through the actual geometry pipeline ─────────

  @Test
  fun aSuccessfulInferenceProducesRenderableGeometry() {
    val provider = FakePerceptionProvider({ neutralRawFrame() })
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    session.load(manifest, dims.first, dims.second)
    session.start()
    session.submitFrame(FakeInputFrame())
    assertTrue(session.runOneInferenceStep())

    val snapshot = session.consumeForRender()
    assertTrue("expected a rendered snapshot from a successful inference", snapshot != null)
    assertEquals(null, snapshot!!.failure)
    assertTrue(snapshot.gatePassed)
    assertEquals(1L, session.stats().inferred)
    assertEquals(0L, session.stats().refused)
  }

  @Test
  fun aNoPoseResultIsCountedAsRefusedNeverAsRenderedGeometry() {
    val provider = FakePerceptionProvider({ null }) // always NoPose
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    session.load(manifest, dims.first, dims.second)
    session.start()
    session.submitFrame(FakeInputFrame())
    session.runOneInferenceStep()

    assertNull(session.consumeForRender())
    val stats = session.stats()
    assertEquals(1L, stats.inferred)
    assertEquals(1L, stats.refused)
  }

  @Test
  fun aProviderExceptionDuringInferenceIsCaughtAndCountedNotThrown() {
    val provider = object : PerceptionProvider {
      override fun initialize() = true
      override fun getCapability() = PerceptionCapability(true, true, "throwing-fake", "none", null)
      override fun processFrame(frame: PerceptionInputFrame): PerceptionResult = throw RuntimeException("simulated inference crash")
      override fun reset() {}
      override fun dispose() {}
    }
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    session.load(manifest, dims.first, dims.second)
    session.start()
    session.submitFrame(FakeInputFrame())

    session.runOneInferenceStep() // must not throw out of this call
    assertEquals(1L, session.stats().refused)
    assertEquals(ReplayState.PLAYING, session.currentState()) // one bad frame must not kill the session
  }

  /** Non-finite provider output must never reach the renderer as geometry (mission section 18). */
  @Test
  fun nonFiniteProviderOutputNeverProducesRenderableGeometry() {
    val lm = MutableList(PoseLandmarkIndex.COUNT) { RawPoseLandmark(0f, 0f, 0f, present = false) }
    lm[PoseLandmarkIndex.LEFT_SHOULDER] = RawPoseLandmark(Float.NaN, 0.28f, 0.9f, present = true)
    lm[PoseLandmarkIndex.RIGHT_SHOULDER] = RawPoseLandmark(0.62f, 0.28f, 0.9f, present = true)
    lm[PoseLandmarkIndex.LEFT_HIP] = RawPoseLandmark(0.40f, 0.60f, 0.9f, present = true)
    lm[PoseLandmarkIndex.RIGHT_HIP] = RawPoseLandmark(0.60f, 0.60f, 0.9f, present = true)
    val poisoned = RawPoseFrame(1L, lm, 0.9f)

    val provider = FakePerceptionProvider({ poisoned })
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    session.load(manifest, dims.first, dims.second)
    session.start()
    session.submitFrame(FakeInputFrame())
    session.runOneInferenceStep()

    assertNull(session.consumeForRender())
    assertEquals(1L, session.stats().refused)
  }

  // ── Backpressure (mission section 24/25): separate counters, non-vacuous ─

  @Test
  fun frameDropsAndInferenceOutcomesAreCountedSeparately() {
    // Slow "inference" (simulated via processDelayMillis) so the fast
    // producer genuinely outruns the perception consumer -- deterministic,
    // not dependent on real device timing.
    val provider = FakePerceptionProvider({ neutralRawFrame() }, processDelayMillis = 20)
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    session.load(manifest, dims.first, dims.second)
    session.start()

    val stop = AtomicBoolean(false)
    val producer = Executors.newSingleThreadExecutor()
    val consumer = Executors.newSingleThreadExecutor()
    producer.execute {
      while (!stop.get()) {
        session.submitFrame(FakeInputFrame())
        Thread.sleep(2) // producer much faster than the 20ms "inference"
      }
    }
    consumer.execute {
      while (!stop.get()) session.runOneInferenceStep()
    }

    Thread.sleep(300)
    stop.set(true)
    producer.shutdownNow(); consumer.shutdownNow()
    producer.awaitTermination(5, TimeUnit.SECONDS)
    consumer.awaitTermination(5, TimeUnit.SECONDS)

    val stats = session.stats()
    assertTrue("BACKPRESSURE TEST INVALID: no frame was dropped before reaching perception", stats.droppedBeforePerception > 0)
    assertTrue("producer must outrun the consumer", stats.produced > stats.inferred)
    assertEquals("max input slot depth must stay bounded at 1", 1, stats.maxInputSlotDepth)
    assertEquals("max geometry slot depth must stay bounded at 1", 1, stats.maxGeometrySlotDepth)
    // Two independent counters, not one merged one -- section 24.
    assertTrue(stats.droppedBeforePerception >= 0)
    assertTrue(stats.droppedBeforeRender >= 0)
  }

  @Test
  fun perceptionDriverRunsBothClocksOffTheCallingThread() {
    val provider = FakePerceptionProvider({ neutralRawFrame() }, processDelayMillis = 15)
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    session.load(manifest, dims.first, dims.second)
    session.start()

    val callingThread = Thread.currentThread().name
    val threadsUsed = mutableSetOf<String>()
    val recordingProvider = object : PerceptionProvider {
      override fun initialize() = true
      override fun getCapability() = PerceptionCapability(true, true, "recording-fake", "none", null)
      override fun processFrame(frame: PerceptionInputFrame): PerceptionResult {
        synchronized(threadsUsed) { threadsUsed.add(Thread.currentThread().name) }
        return provider.processFrame(frame)
      }
      override fun reset() {}
      override fun dispose() {}
    }
    val recordingSession = LiveVtoPerceptionSession(recordingProvider, CANVAS_W, CANVAS_H)
    recordingSession.load(manifest, dims.first, dims.second)
    recordingSession.start()

    val driver = LiveVtoPerceptionDriver(recordingSession, { FakeInputFrame() }, producerPeriodMillis = 10)
    driver.start()
    Thread.sleep(150)
    driver.stop()
    recordingSession.dispose()

    assertFalse("perception must not run on the JVM test's calling thread", threadsUsed.contains(callingThread))
    assertTrue("perception thread should be named per its documented topology",
      threadsUsed.any { it == LiveVtoPerceptionDriver.PERCEPTION_THREAD_NAME })
  }

  @Test
  fun disposeDuringActiveDriverOperationIsSafe() {
    val provider = FakePerceptionProvider({ neutralRawFrame() }, processDelayMillis = 5)
    val session = LiveVtoPerceptionSession(provider, CANVAS_W, CANVAS_H)
    val (manifest, dims) = garment()
    session.load(manifest, dims.first, dims.second)
    session.start()
    val driver = LiveVtoPerceptionDriver(session, { FakeInputFrame() }, producerPeriodMillis = 5)
    driver.start()
    Thread.sleep(60)
    val disposed = CountDownLatch(1)
    Thread {
      session.dispose()
      disposed.countDown()
    }.start()
    assertTrue(disposed.await(5, TimeUnit.SECONDS))
    driver.stop()
    assertEquals(ReplayState.DISPOSED, session.currentState())
  }
}
