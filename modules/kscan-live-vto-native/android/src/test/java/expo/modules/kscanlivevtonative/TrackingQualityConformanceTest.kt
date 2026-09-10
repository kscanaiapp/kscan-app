package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Executes the SHARED cross-platform tracking-quality fixture
 * (`goldens/tracking-quality-scenarios.json`) against the real
 * `LiveVtoTrackingQualityMachine`.
 *
 * WHY A SHARED FIXTURE AND NOT KOTLIN TEST CASES. Mission section 13
 * requires Android and iOS to resolve the SAME governed input to the SAME
 * logical state. Two suites of hand-written cases that merely look alike
 * cannot prove that -- the first typo reads as a genuine divergence, and a
 * genuine divergence reads as a typo. One committed file, executed by this
 * test, by `Tests/LiveVtoCoreTests/LiveVtoTrackingQualityTests.swift`, and
 * by `__tests__/vtoLiveTrackingParity.test.js`, is the only version of this
 * claim that can fail for the right reason. Same reasoning, same pattern as
 * `GoldenBodyFrames` / `goldens/bodyframes.json` (amendment D12).
 *
 * FLOAT WIDENING IS REAL. `0.9f.toDouble()` is 0.8999999761581421, so every
 * confidence comparison uses the fixture's own declared tolerance rather
 * than exact equality. Asserting exact equality here would have forced the
 * fixture to carry platform float artifacts as if they were contract.
 */
class TrackingQualityConformanceTest {

  private fun fixture(): Map<String, Any?> {
    val root = GoldenBodyFrames.moduleRoot()
    val file = File(root, "goldens/tracking-quality-scenarios.json")
    assertTrue("shared tracking fixture is missing: ${file.absolutePath}", file.isFile)
    return LiveVtoJson.obj(LiveVtoJson.parse(file.readText()))
  }

  /** JSON cannot carry NaN, so the fixture spells it as the string "NaN". */
  private fun confidenceOf(raw: Any?): Float = when (raw) {
    is Double -> raw.toFloat()
    is String -> if (raw == "NaN") Float.NaN else throw IllegalArgumentException("unsupported confidence literal: $raw")
    else -> throw IllegalArgumentException("unsupported confidence value: $raw")
  }

  @Test
  fun theMachineMatchesEveryStepOfTheSharedCrossPlatformFixture() {
    val doc = fixture()
    val tolerance = LiveVtoJson.num(doc["confidenceTolerance"])
    val scenarios = LiveVtoJson.arr(doc["scenarios"])
    assertTrue("the shared fixture must actually contain scenarios", scenarios.isNotEmpty())

    var stepsExecuted = 0
    for (rawScenario in scenarios) {
      val scenario = LiveVtoJson.obj(rawScenario)
      val name = LiveVtoJson.str(scenario["name"])
      val machine = LiveVtoTrackingQualityMachine()

      for ((index, rawStep) in LiveVtoJson.arr(scenario["steps"]).withIndex()) {
        val step = LiveVtoJson.obj(rawStep)
        val where = "$name step ${index + 1}"
        val event: LiveVtoTrackingEvent? = when (val kind = LiveVtoJson.str(step["kind"])) {
          "observe" -> machine.observe(
            LiveVtoTrackingObservation(
              monotonicMs = LiveVtoJson.num(step["monotonicMs"]).toLong(),
              outcome = when (val outcome = LiveVtoJson.str(step["outcome"])) {
                "POSE_RESOLVED" -> LiveVtoPerceptionOutcome.POSE_RESOLVED
                "POSE_REFUSED" -> LiveVtoPerceptionOutcome.POSE_REFUSED
                else -> throw IllegalArgumentException("unknown outcome $outcome at $where")
              },
              trackingConfidence = confidenceOf(step["trackingConfidence"]),
              geometryGatePassed = step["geometryGatePassed"] == true,
              geometryFailure = step["geometryFailure"] as? String,
              personFrameAvailable = step["personFrameAvailable"] == true,
            )
          )
          "tick" -> machine.tick(
            monotonicMs = LiveVtoJson.num(step["monotonicMs"]).toLong(),
            personFrameAvailable = step["personFrameAvailable"] == true,
          )
          "reset" -> {
            machine.reset()
            null
          }
          else -> throw IllegalArgumentException("unknown step kind $kind at $where")
        }

        val expect = LiveVtoJson.obj(step["expect"])
        val expectedEvent = expect["event"]
        if (expectedEvent == null) {
          assertNull("$where must emit nothing, got ${event?.name} ${event?.payload}", event)
        } else {
          val expectedObj = LiveVtoJson.obj(expectedEvent)
          assertNotNull("$where must emit ${LiveVtoJson.str(expectedObj["name"])}, got nothing", event)
          assertEquals("$where event name", LiveVtoJson.str(expectedObj["name"]), event!!.name)
          val expectedPayload = LiveVtoJson.obj(expectedObj["payload"])
          assertEquals(
            "$where payload keys",
            expectedPayload.keys.sorted(),
            event.payload.keys.sorted(),
          )
          for ((key, expectedValue) in expectedPayload) {
            val actual = event.payload[key]
            if (key == "confidence") {
              val expectedNumber = LiveVtoJson.num(expectedValue)
              val actualNumber = actual as? Double
                ?: throw AssertionError("$where payload.confidence must be a number, got $actual")
              assertTrue(
                "$where payload.confidence expected $expectedNumber got $actualNumber",
                Math.abs(expectedNumber - actualNumber) <= tolerance,
              )
            } else {
              assertEquals("$where payload.$key", expectedValue, actual)
            }
          }
        }

        val snapshot = machine.snapshot()
        assertEquals("$where phase", LiveVtoJson.str(expect["phase"]), snapshot.phase.name)
        assertEquals("$where guidance", LiveVtoJson.str(expect["guidance"]), snapshot.guidance.wireToken)
        assertEquals("$where captureReady", expect["captureReady"] == true, snapshot.captureReady)
        val expectedConfidence = LiveVtoJson.num(expect["confidence"])
        assertTrue(
          "$where confidence expected $expectedConfidence got ${snapshot.confidence}",
          Math.abs(expectedConfidence - snapshot.confidence.toDouble()) <= tolerance,
        )
        stepsExecuted += 1
      }
    }

    // A conformance runner that silently executed zero steps is a false
    // green, not a pass -- the same false-green class this program has hit
    // before with empty JUnit reports.
    assertTrue("the fixture runner executed no steps at all", stepsExecuted >= 40)
  }

  /**
   * The thresholds are contract, not implementation detail: the Swift mirror
   * declares the same values and the fixture was derived from them. A change
   * to any of them has to change the fixture too, and this is what makes
   * that mechanical rather than a matter of somebody remembering.
   */
  @Test
  fun theDeclaredThresholdsMatchTheSharedFixtureParameters() {
    val parameters = LiveVtoJson.obj(fixture()["parameters"])
    assertEquals(
      LiveVtoJson.num(parameters["strongConfidence"]),
      LiveVtoTrackingQualityMachine.STRONG_CONFIDENCE.toDouble(),
      1e-6,
    )
    assertEquals(
      LiveVtoJson.num(parameters["weakFloorConfidence"]),
      LiveVtoTrackingQualityMachine.WEAK_FLOOR_CONFIDENCE.toDouble(),
      1e-6,
    )
    assertEquals(LiveVtoJson.num(parameters["acquireStreak"]).toInt(), LiveVtoTrackingQualityMachine.ACQUIRE_STREAK)
    assertEquals(LiveVtoJson.num(parameters["demoteStreak"]).toInt(), LiveVtoTrackingQualityMachine.DEMOTE_STREAK)
    assertEquals(LiveVtoJson.num(parameters["weakAfterMs"]).toLong(), LiveVtoTrackingQualityMachine.WEAK_AFTER_MS)
    assertEquals(LiveVtoJson.num(parameters["lostAfterMs"]).toLong(), LiveVtoTrackingQualityMachine.LOST_AFTER_MS)
    assertEquals(
      LiveVtoJson.num(parameters["reEmitIntervalMs"]).toLong(),
      LiveVtoTrackingQualityMachine.RE_EMIT_INTERVAL_MS,
    )
  }

  /**
   * Every guidance token this machine can produce must be a value
   * `types/vtoLive.ts`'s `LiveVtoGuidance` union actually contains. A token
   * the app cannot parse would reach the reducer, fail the string check, and
   * silently degrade to 'none' -- guidance that vanishes rather than
   * guidance that is wrong, which is harder to notice.
   */
  @Test
  fun everyGuidanceTokenExistsInTheApplicationContract() {
    val contract = File(GoldenBodyFrames.moduleRoot(), "../../types/vtoLive.ts").readText()
    val union = contract
      .substringAfter("export type LiveVtoGuidance =")
      .substringBefore(";")
    for (guidance in LiveVtoTrackingGuidance.entries) {
      assertTrue(
        "LiveVtoGuidance in types/vtoLive.ts has no '${guidance.wireToken}' member",
        union.contains("'${guidance.wireToken}'"),
      )
    }
  }

  /**
   * A stale-frame demotion must never be able to CREATE tracking. `tick` is
   * a demotion-only path by construction, and this proves it over the whole
   * phase set rather than the one ordering the fixture happens to walk.
   */
  @Test
  fun aTickNeverPromotesFromAnyPhase() {
    for (target in listOf("acquiring", "weak", "lost", "acquired")) {
      val machine = LiveVtoTrackingQualityMachine()
      when (target) {
        "acquiring" -> Unit
        "acquired" -> repeat(3) { i -> machine.observe(strong(i * 33L)) }
        "weak" -> {
          repeat(3) { i -> machine.observe(strong(i * 33L)) }
          repeat(2) { i -> machine.observe(degraded(99L + i * 33L)) }
        }
        "lost" -> {
          repeat(3) { i -> machine.observe(strong(i * 33L)) }
          machine.tick(5_000L, true)
        }
      }
      val before = machine.snapshot().phase
      for (t in longArrayOf(6_000L, 6_100L, 6_200L, 20_000L)) machine.tick(t, true)
      val after = machine.snapshot().phase
      assertTrue(
        "tick promoted $target from $before to $after",
        after == before || after == LiveVtoTrackingPhase.WEAK || after == LiveVtoTrackingPhase.LOST,
      )
      assertTrue("tick left capture readiness on in $after", !machine.snapshot().captureReady || after == before)
    }
  }

  private fun strong(t: Long) = LiveVtoTrackingObservation(
    monotonicMs = t,
    outcome = LiveVtoPerceptionOutcome.POSE_RESOLVED,
    trackingConfidence = 0.9f,
    geometryGatePassed = true,
    geometryFailure = null,
    personFrameAvailable = true,
  )

  private fun degraded(t: Long) = LiveVtoTrackingObservation(
    monotonicMs = t,
    outcome = LiveVtoPerceptionOutcome.POSE_RESOLVED,
    trackingConfidence = 0.4f,
    geometryGatePassed = true,
    geometryFailure = null,
    personFrameAvailable = true,
  )
}
