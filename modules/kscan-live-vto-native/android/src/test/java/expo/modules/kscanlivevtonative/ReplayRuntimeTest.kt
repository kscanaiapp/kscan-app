package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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

class ReplayRuntimeTest {

  private fun source(id: String = "neutral-armraise-neutral", framesPerSegment: Int = 20): ReplayFrameSource {
    val (cases, _) = GoldenBodyFrames.load()
    fun frame(name: String) = cases.first { it.id == name }.frame
    return InterpolatedPoseReplaySource(
      id = id,
      keyframes = listOf(frame("neutral-frontal"), frame("arms-slightly-out"), frame("neutral-frontal")),
      framesPerSegment = framesPerSegment,
    )
  }

  private fun garment(name: String = "n1b-fixture") = GoldenBodyFrames.fixture(name)

  private fun session(events: MutableList<ReplayEvent> = mutableListOf()) =
    Pair(LiveVtoReplaySession(CANVAS_W, CANVAS_H) { events.add(it) }, events)

  // ── State machine ────────────────────────────────────────────────────────

  @Test
  fun lifecycleFollowsTheDeclaredStateMachine() {
    val (s, events) = session()
    val (manifest, dims) = garment()

    assertEquals(ReplayState.IDLE, s.currentState())
    assertFalse("start before load must be refused, not throw", s.start())
    assertFalse("pause before play must be refused", s.pause())

    assertTrue(s.load(source(), manifest, dims.first, dims.second))
    assertEquals(ReplayState.READY, s.currentState())

    assertTrue(s.start())
    assertEquals(ReplayState.PLAYING, s.currentState())
    assertFalse("start while playing must be refused", s.start())

    assertTrue(s.advance())
    assertTrue(s.pause())
    assertEquals(ReplayState.PAUSED, s.currentState())
    assertFalse("a paused session must not produce frames", s.advance())

    assertTrue(s.resume())
    assertEquals(ReplayState.PLAYING, s.currentState())

    assertTrue(s.stop())
    assertEquals(ReplayState.STOPPED, s.currentState())
    assertFalse("a stopped session must not produce frames", s.advance())

    assertTrue(s.dispose())
    assertEquals(ReplayState.DISPOSED, s.currentState())

    // LOADING is transient but must actually be entered, not skipped.
    assertTrue("LOADING must be observable", events.any { it.state == ReplayState.LOADING })
    assertTrue(events.map { it.state }.containsAll(
      listOf(ReplayState.READY, ReplayState.PLAYING, ReplayState.PAUSED, ReplayState.STOPPED, ReplayState.DISPOSED),
    ))
  }

  @Test
  fun eofStopsProductionEmitsATerminalStateAndAllowsRestart() {
    val (s, events) = session()
    val (manifest, dims) = garment()
    val src = source(framesPerSegment = 5)
    assertTrue(s.load(src, manifest, dims.first, dims.second))
    assertTrue(s.start())

    var produced = 0
    while (s.advance()) produced++

    assertEquals("every frame in the source must be produced exactly once", src.frameCount, produced)
    assertEquals(ReplayState.EOF, s.currentState())
    assertFalse("EOF must stop frame production", s.advance())
    assertTrue("EOF must be emitted as a state event", events.any { it.state == ReplayState.EOF })

    // Not a silent loop: it stopped and stayed stopped until asked again.
    assertTrue(s.restart())
    assertEquals(ReplayState.PLAYING, s.currentState())
    var again = 0
    while (s.advance()) again++
    assertEquals("restart must replay the whole source", src.frameCount, again)
    assertEquals(ReplayState.EOF, s.currentState())
  }

  @Test
  fun rapidStartStopCyclesAreSafe() {
    val (s, _) = session()
    val (manifest, dims) = garment()
    assertTrue(s.load(source(framesPerSegment = 3), manifest, dims.first, dims.second))
    repeat(50) {
      assertTrue(s.start())
      s.advance()
      assertTrue(s.stop())
    }
    assertEquals(ReplayState.STOPPED, s.currentState())
    assertEquals("stop must empty the slot", 0, s.slot.depth)
  }

  @Test
  fun disposeDuringPlaybackStopsProductionAndEmitsNothingFurther() {
    val (s, events) = session()
    val (manifest, dims) = garment()
    assertTrue(s.load(source(), manifest, dims.first, dims.second))
    assertTrue(s.start())
    repeat(5) { s.advance() }

    val before = events.size
    assertTrue(s.dispose())
    assertEquals("dispose must emit exactly one terminal event", before + 1, events.size)
    assertEquals(ReplayState.DISPOSED, events.last().state)

    assertFalse("no frame may be produced after dispose", s.advance())
    assertEquals("dispose must release the pending snapshot", 0, s.slot.depth)
    assertNull("no snapshot may be readable after dispose", s.consumeForRender())

    // Every post-dispose command is a refused no-op, and none of them emits.
    val afterDispose = events.size
    assertFalse(s.start()); assertFalse(s.pause()); assertFalse(s.resume())
    assertFalse(s.stop()); assertFalse(s.restart()); assertFalse(s.dispose())
    assertFalse(s.load(source(), manifest, dims.first, dims.second))
    assertEquals("no event may fire after the terminal event", afterDispose, events.size)
  }

  @Test
  fun disposeIsSafeWhileAProducerThreadIsRunning() {
    val (s, _) = session()
    val (manifest, dims) = garment()
    assertTrue(s.load(source(framesPerSegment = 2000), manifest, dims.first, dims.second))
    assertTrue(s.start())

    val executor = Executors.newSingleThreadExecutor()
    val stopped = AtomicBoolean(false)
    val crashed = AtomicReferenceHolder()
    executor.execute {
      try {
        while (!stopped.get()) s.advance()
      } catch (t: Throwable) {
        crashed.value = t
      }
    }
    Thread.sleep(60)
    s.dispose()
    stopped.set(true)
    executor.shutdown()
    assertTrue("producer thread did not settle", executor.awaitTermination(5, TimeUnit.SECONDS))

    assertNull("dispose during active production threw: " + crashed.value, crashed.value)
    assertEquals(ReplayState.DISPOSED, s.currentState())
    assertEquals(0, s.slot.depth)
  }

  private class AtomicReferenceHolder { @Volatile var value: Throwable? = null }

  // ── Backpressure (amendment D15) ─────────────────────────────────────────

  /**
   * A NON-VACUOUS overload test: the producer runs faster than the consumer
   * and must provably drop stale frames while the slot stays depth-1.
   *
   * If this test could not produce a dropped frame it would be INVALID, so
   * it asserts `dropped > 0` explicitly rather than asserting a bound that a
   * lockstep loop would also satisfy.
   */
  @Test
  fun producerOutrunningConsumerDropsStaleFramesAndStaysBounded() {
    val (s, _) = session()
    val (manifest, dims) = garment()
    val src = source(framesPerSegment = 300)
    assertTrue(s.load(src, manifest, dims.first, dims.second))
    assertTrue(s.start())

    // Consume only every 10th produced frame -- a renderer an order of
    // magnitude slower than production.
    var rendered = 0
    var produced = 0
    while (s.advance()) {
      produced++
      if (produced % 10 == 0 && s.consumeForRender() != null) rendered++
      assertTrue("the latest-state slot must never queue", s.slot.depth <= 1)
    }

    val stats = s.stats()
    assertEquals(src.frameCount, produced)
    assertTrue("BACKPRESSURE TEST INVALID: no frame was dropped", stats.dropped > 0)
    assertTrue("more frames must be produced than rendered", stats.produced > stats.rendered)
    assertEquals("max slot depth must stay bounded at 1", 1, stats.maxSlotDepth)
    assertEquals(
      "every produced frame must be either rendered or counted as dropped",
      stats.produced,
      stats.rendered + stats.dropped + s.slot.depth,
    )
    assertTrue("the renderer must still have seen frames", rendered > 0)

    writeEvidence(
      "backpressure-deterministic.json",
      "{\"mode\":\"deterministic-slow-consumer\"," +
        "\"sourceFrames\":" + src.frameCount + "," +
        "\"produced\":" + stats.produced + "," +
        "\"rendered\":" + stats.rendered + "," +
        "\"dropped\":" + stats.dropped + "," +
        "\"maxSlotDepth\":" + stats.maxSlotDepth + "," +
        "\"refused\":" + stats.refused + "," +
        "\"consumeEveryNthFrame\":10," +
        "\"accountingInvariant\":\"produced == rendered + dropped + depth\"," +
        "\"accountingHolds\":" + (stats.produced == stats.rendered + stats.dropped + s.slot.depth) + "}\n",
    )
  }

  private fun writeEvidence(name: String, contents: String) {
    val dir = java.io.File(GoldenBodyFrames.moduleRoot(), "build/conformance")
    dir.mkdirs()
    java.io.File(dir, name).writeText(contents)
  }

  /**
   * The same claim under real concurrency: an independent producer thread
   * must never wait for the renderer. If production were coupled to render,
   * a deliberately slow consumer would throttle the producer and the
   * produced count would collapse toward the consumed count.
   */
  @Test
  fun producerClockIsIndependentOfRenderCadence() {
    val (s, _) = session()
    val (manifest, dims) = garment()
    assertTrue(s.load(source(framesPerSegment = 5000), manifest, dims.first, dims.second))
    assertTrue(s.start())

    val done = CountDownLatch(1)
    val renderedCount = AtomicLong(0)
    val producer = Executors.newSingleThreadExecutor()
    val consumer = Executors.newSingleThreadExecutor()
    val stop = AtomicBoolean(false)

    producer.execute {
      while (!stop.get() && s.advance()) { /* free-running */ }
      done.countDown()
    }
    consumer.execute {
      while (!stop.get()) {
        if (s.consumeForRender() != null) renderedCount.incrementAndGet()
        Thread.sleep(5) // a deliberately slow renderer
      }
    }

    Thread.sleep(250)
    stop.set(true)
    done.await(5, TimeUnit.SECONDS)
    producer.shutdownNow(); consumer.shutdownNow()
    producer.awaitTermination(5, TimeUnit.SECONDS)
    consumer.awaitTermination(5, TimeUnit.SECONDS)

    val stats = s.stats()
    assertTrue("producer produced nothing", stats.produced > 0)
    assertTrue(
      "producer appears coupled to the renderer: produced=" + stats.produced + " rendered=" + renderedCount.get(),
      stats.produced > renderedCount.get() * 2,
    )
    assertTrue("no frame was dropped under a slow renderer", stats.dropped > 0)
    assertEquals("slot depth must stay bounded under real concurrency", 1, stats.maxSlotDepth)

    writeEvidence(
      "backpressure-concurrent.json",
      "{\"mode\":\"free-running-producer-thread-vs-5ms-consumer\"," +
        "\"wallClockMs\":250," +
        "\"produced\":" + stats.produced + "," +
        "\"rendered\":" + renderedCount.get() + "," +
        "\"dropped\":" + stats.dropped + "," +
        "\"maxSlotDepth\":" + stats.maxSlotDepth + "," +
        "\"producerToRendererRatio\":" + (stats.produced.toDouble() / maxOf(1L, renderedCount.get())) + "}\n",
    )
  }

  // ── Product switching during replay (amendment D16) ──────────────────────

  @Test
  fun switchingGarmentMidReplayTakesEffectWithoutRestartAndLeavesNoStaleState() {
    val (s, _) = session()
    val (a, aDims) = garment("n1b-fixture")
    val (b, bDims) = garment("n1c-asym-fixture")
    assertTrue(s.load(source(framesPerSegment = 40), a, aDims.first, aDims.second))
    assertTrue(s.start())

    repeat(10) { s.advance() }
    val underA = s.consumeForRender()
    assertNotNull(underA)
    assertEquals(a.productId, underA!!.activeAssetId)

    assertTrue(s.selectGarment(b, bDims.first, bDims.second))
    assertEquals("a switch must not restart replay", ReplayState.PLAYING, s.currentState())
    assertEquals("the pre-switch snapshot must not survive the switch", 0, s.slot.depth)
    assertNull("A's geometry must not be readable once B is active", s.consumeForRender())

    // Every subsequent snapshot is B, and B is driven by the CURRENT pose --
    // not by the pose that was live when A was loaded.
    repeat(10) { s.advance() }
    val underB = s.consumeForRender()
    assertNotNull(underB)
    assertEquals(b.productId, underB!!.activeAssetId)
    assertTrue("B must be driven by a later frame than A was", underB.bodyFrameId != underA.bodyFrameId)

    // Switching back is symmetric.
    assertTrue(s.selectGarment(a, aDims.first, aDims.second))
    repeat(5) { s.advance() }
    assertEquals(a.productId, s.consumeForRender()!!.activeAssetId)
    assertEquals(ReplayState.PLAYING, s.currentState())
  }

  @Test
  fun switchingToAnInvalidGarmentFailsClosedWithoutCorruptingTheSession() {
    val (s, _) = session()
    val (a, aDims) = garment("n1b-fixture")
    val (b, _) = garment("n1c-asym-fixture")
    assertTrue(s.load(source(), a, aDims.first, aDims.second))
    assertTrue(s.start())
    repeat(3) { s.advance() }

    assertFalse("a garment with invalid dimensions must be refused", s.selectGarment(b, 0, 0))
    assertEquals(ReplayState.ERROR, s.currentState())
    assertFalse("an errored session must not keep producing", s.advance())
    assertEquals("an errored session must hold no renderable geometry", 0, s.slot.depth)
    assertTrue("dispose must still work from ERROR", s.dispose())
  }

  // ── Replay + deformation (mission section 21) ────────────────────────────

  @Test
  fun garmentMovesOverTimeAndStaysSynchronisedWithTheFrameIndex() {
    val (s, _) = session()
    val (manifest, dims) = garment()
    val src = source(framesPerSegment = 30)
    assertTrue(s.load(src, manifest, dims.first, dims.second))
    assertTrue(s.start())

    val seen = mutableListOf<GeometrySnapshot>()
    var index = 0
    while (s.advance()) {
      val snapshot = s.consumeForRender()
      assertNotNull("consuming immediately after producing must never miss a frame", snapshot)
      // The snapshot names the exact source frame it was computed from, so a
      // stale BodyFrame or an off-by-one is detectable, not merely unlikely.
      assertEquals(src.id + "#" + index, snapshot!!.bodyFrameId)
      seen.add(snapshot)
      index++
    }

    assertEquals(src.frameCount, seen.size)
    val distinct = seen.map { it.controlPoints.getValue("leftSleeve") }.distinct()
    assertTrue("the garment must actually move over the sequence, got " + distinct.size + " distinct sleeve positions",
      distinct.size > src.frameCount / 2)
    for (snapshot in seen) {
      assertNull(snapshot.bodyFrameId + " refused during replay: " + snapshot.failure, snapshot.failure)
      assertEquals(snapshot.bodyFrameId + " invalid: " + snapshot.validate(), emptyList<String>(), snapshot.validate())
    }
  }

  // ── Privacy boundary (amendment D24) ─────────────────────────────────────

  /**
   * The bridge must carry bounded state only. This asserts on the payload
   * the event actually serializes, so adding a field to ReplayEvent without
   * adding it to the allowlist fails here rather than silently widening the
   * boundary.
   */
  @Test
  fun replayEventsCarryOnlyBoundedStateAndNoFrameData() {
    val (s, events) = session()
    val (manifest, dims) = garment()
    assertTrue(s.load(source(framesPerSegment = 25), manifest, dims.first, dims.second))
    assertTrue(s.start())
    while (s.advance()) { s.consumeForRender() }
    s.dispose()

    val forbidden = listOf(
      "frame", "frames", "bitmap", "image", "imageBytes", "pixels", "mask", "masks",
      "landmark", "landmarks", "bodyFrame", "pose", "controlPoints", "mesh", "meshVertices",
      "texture", "buffer", "yuv", "rgba",
    )
    for (event in events) {
      val payload = event.toPayload()
      assertEquals(
        "ReplayEvent serialized a key outside the declared allowlist",
        ReplayEvent.ALLOWED_PAYLOAD_KEYS,
        payload.keys,
      )
      val rendered = payload.entries.joinToString(",") { it.key + "=" + it.value }.lowercase()
      for (key in forbidden) {
        assertFalse(
          "replay event payload mentions '" + key + "': " + rendered,
          payload.keys.any { it.lowercase().contains(key.lowercase()) },
        )
      }
      // A payload value must never be a container that could smuggle bulk data.
      for (value in payload.values) {
        assertTrue(
          "replay event carried a non-scalar payload value: " + value,
          value == null || value is String || value is Number || value is Boolean,
        )
      }
    }
  }

  /**
   * Events are per-TRANSITION, not per-FRAME. A runtime that emitted one
   * event per frame would be a high-frequency channel regardless of what
   * each event contained.
   */
  @Test
  fun eventCountIsBoundedByTransitionsNotByFrameCount() {
    val (s, events) = session()
    val (manifest, dims) = garment()
    val src = source(framesPerSegment = 200)
    assertTrue(s.load(src, manifest, dims.first, dims.second))
    assertTrue(s.start())
    while (s.advance()) { s.consumeForRender() }
    s.dispose()

    assertTrue("the run must have been long enough to be meaningful", src.frameCount > 100)
    assertTrue(
      "event count " + events.size + " scales with frames (" + src.frameCount + "), not transitions",
      events.size <= 10,
    )
  }

  // ── Resource discipline (mission section 26) ─────────────────────────────

  @Test
  fun repeatedStartRunStopDisposeCyclesDoNotGrowUnbounded() {
    val (manifest, dims) = garment()
    var lastDepth = 0
    repeat(20) {
      val events = mutableListOf<ReplayEvent>()
      val s = LiveVtoReplaySession(CANVAS_W, CANVAS_H) { events.add(it) }
      assertTrue(s.load(source(framesPerSegment = 10), manifest, dims.first, dims.second))
      assertTrue(s.start())
      while (s.advance()) s.consumeForRender()
      s.stop()
      s.dispose()
      assertEquals("slot must be empty after dispose", 0, s.slot.depth)
      assertTrue("event count must not grow across cycles", events.size <= 10)
      lastDepth = s.slot.depth
    }
    assertEquals(0, lastDepth)
  }
}
