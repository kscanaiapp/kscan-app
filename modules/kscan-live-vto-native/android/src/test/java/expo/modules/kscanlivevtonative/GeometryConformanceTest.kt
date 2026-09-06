package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

private const val CANVAS_W = 720f
private const val CANVAS_H = 960f

/**
 * N1-C cross-runtime conformance: runs the NATIVE geometry pipeline over the
 * whole golden BodyFrame set and writes the native half of the delta table.
 *
 * This test does not itself compare against the reference oracle -- that
 * comparison is `tools/compare-conformance.mjs`, which reads this test's
 * output and the Node oracle runner's output. Keeping the comparison outside
 * the test is deliberate: the delta table has to be reviewable evidence, not
 * a boolean buried in a green test run.
 *
 * What this test DOES assert is everything judgeable without the oracle:
 * fail-closed behaviour, finite geometry, orientation, and stability across
 * sequences.
 */
class GeometryConformanceTest {

  private fun outDir(): File =
    File(GoldenBodyFrames.moduleRoot(), "build/conformance").apply { mkdirs() }

  @Test
  fun writesNativeSnapshotsForEveryGolden() {
    val (cases, refusals) = GoldenBodyFrames.load()
    val out = StringBuilder()
    for (fixtureName in listOf("n1b-fixture", "n1c-asym-fixture")) {
      val (manifest, dims) = GoldenBodyFrames.fixture(fixtureName)
      for (case in cases + refusals) {
        val snapshot = LiveVtoGeometryPipeline.compute(
          manifest = manifest,
          frame = case.frame,
          bodyFrameId = case.id,
          canvasWidth = CANVAS_W,
          canvasHeight = CANVAS_H,
          textureWidth = dims.first,
          textureHeight = dims.second,
        )
        out.append("{\"fixture\":\"").append(fixtureName).append("\",\"case\":\"").append(case.id)
          .append("\",\"snapshot\":").append(GeometrySnapshotJson.encode(snapshot)).append("}\n")
      }
    }
    File(outDir(), "native-snapshots.jsonl").writeText(out.toString())
    assertTrue("expected native snapshots to be written", File(outDir(), "native-snapshots.jsonl").length() > 0)
  }

  @Test
  fun everyValidGoldenProducesFiniteRenderableGeometry() {
    val (cases, _) = GoldenBodyFrames.load()
    val (manifest, dims) = GoldenBodyFrames.fixture("n1b-fixture")
    for (case in cases) {
      val s = LiveVtoGeometryPipeline.compute(manifest, case.frame, case.id, CANVAS_W, CANVAS_H, dims.first, dims.second)
      assertNull(case.id + ": expected no refusal but got " + s.failure, s.failure)
      assertEquals(case.id + ": geometry validation problems " + s.validate(), emptyList<String>(), s.validate())
      assertTrue(case.id + ": rigid gate failed with " + s.gateFindings, s.gatePassed)
      assertNotNull(case.id + ": gate passed but no mesh was produced", s.meshVertices)
      assertEquals(case.id + ": every manifest control point must get a target", 11, s.controlPoints.size)
    }
  }

  @Test
  fun everyRefusalGoldenFailsClosedWithItsDeclaredReason() {
    val (_, refusals) = GoldenBodyFrames.load()
    val (manifest, dims) = GoldenBodyFrames.fixture("n1b-fixture")
    for (case in refusals) {
      val s = LiveVtoGeometryPipeline.compute(manifest, case.frame, case.id, CANVAS_W, CANVAS_H, dims.first, dims.second)
      if (case.expectedFailure == null) {
        // Declared as a rigid-gate rejection, not a pipeline refusal: the
        // geometry is finite and computable, but semantically impossible.
        // The gate must catch it and withhold the mesh.
        assertNull(case.id + ": expected the rigid gate to catch this, not a pipeline refusal", s.failure)
        assertFalse(case.id + ": rigid gate should have rejected this", s.gatePassed)
        for (expected in case.expectedGateFindings) {
          assertTrue(
            case.id + ": expected gate finding " + expected + ", got " + s.gateFindings,
            s.gateFindings.contains(expected),
          )
        }
        assertNull(case.id + ": a rejected gate must not produce a mesh", s.meshVertices)
      } else {
        assertEquals(case.id + ": wrong refusal reason", case.expectedFailure, s.failure)
        assertNull(case.id + ": a refusal must carry no mesh", s.meshVertices)
        assertTrue(case.id + ": a refusal must carry no control points", s.controlPoints.isEmpty())
      }
    }
  }

  /**
   * Amendment D6: left stays left, right stays right.
   *
   * Asserted on the numbers, not on pixels: in this coordinate space the
   * wearer's own left sits at the LOWER u, so the garment's leftShoulder
   * target must land at a smaller x than its rightShoulder target for every
   * pose whose body itself is left-of-right. A mirror inversion, a swapped
   * target assignment, or a flipped lateral axis all break this.
   */
  @Test
  fun leftRightOrientationIsPreservedAcrossEveryGolden() {
    val (cases, _) = GoldenBodyFrames.load()
    for (fixtureName in listOf("n1b-fixture", "n1c-asym-fixture")) {
      val (manifest, dims) = GoldenBodyFrames.fixture(fixtureName)
      for (case in cases) {
        val s = LiveVtoGeometryPipeline.compute(manifest, case.frame, case.id, CANVAS_W, CANVAS_H, dims.first, dims.second)
        val bodyLeft = (case.frame.leftShoulder as Landmark.Present).point.x
        val bodyRight = (case.frame.rightShoulder as Landmark.Present).point.x
        val gLeft = s.controlPoints.getValue("leftShoulder")
        val gRight = s.controlPoints.getValue("rightShoulder")
        assertEquals(
          fixtureName + "/" + case.id + ": garment shoulder ordering must follow the body's",
          bodyLeft < bodyRight,
          gLeft.x < gRight.x,
        )
        // Hems too -- a swap confined to the hem would pass a shoulder-only check.
        val hLeft = s.controlPoints.getValue("leftHem")
        val hRight = s.controlPoints.getValue("rightHem")
        assertEquals(
          fixtureName + "/" + case.id + ": garment hem ordering must follow the body's",
          bodyLeft < bodyRight,
          hLeft.x < hRight.x,
        )
        assertFalse(
          fixtureName + "/" + case.id + ": left/right inversion reported by the rigid gate",
          s.gateFindings.contains("left_right_inversion"),
        )
      }
    }
  }

  /**
   * The raised-shoulder pair. A mirroring defect that survived the ordering
   * check above would still swap WHICH shoulder rises, so assert the
   * asymmetry lands on the side that was actually raised.
   */
  @Test
  fun raisedShoulderAsymmetryLandsOnTheRaisedSide() {
    val (cases, _) = GoldenBodyFrames.load()
    val (manifest, dims) = GoldenBodyFrames.fixture("n1c-asym-fixture")
    fun snap(id: String) = LiveVtoGeometryPipeline.compute(
      manifest, cases.first { it.id == id }.frame, id, CANVAS_W, CANVAS_H, dims.first, dims.second,
    )

    val neutral = snap("neutral-frontal")
    val leftUp = snap("left-shoulder-raised")
    val rightUp = snap("right-shoulder-raised")

    // Raising the wearer's own left shoulder must lift the garment's LEFT
    // shoulder target (smaller y = higher on screen) more than its right.
    val leftDelta = neutral.controlPoints.getValue("leftShoulder").y - leftUp.controlPoints.getValue("leftShoulder").y
    val leftOtherDelta = neutral.controlPoints.getValue("rightShoulder").y - leftUp.controlPoints.getValue("rightShoulder").y
    assertTrue(
      "raising the left shoulder must lift the garment's left shoulder (" + leftDelta + " vs " + leftOtherDelta + ")",
      leftDelta > leftOtherDelta,
    )

    val rightDelta = neutral.controlPoints.getValue("rightShoulder").y - rightUp.controlPoints.getValue("rightShoulder").y
    val rightOtherDelta = neutral.controlPoints.getValue("leftShoulder").y - rightUp.controlPoints.getValue("leftShoulder").y
    assertTrue(
      "raising the right shoulder must lift the garment's right shoulder (" + rightDelta + " vs " + rightOtherDelta + ")",
      rightDelta > rightOtherDelta,
    )

    // And the pair must be genuine mirrors of each other, not the same result twice.
    assertTrue("the two raised-shoulder cases must differ", leftUp.controlPoints != rightUp.controlPoints)
  }

  /**
   * Amendment D13: an impossible one-frame displacement between two valid
   * poses must not be amplified into invalid geometry, and must not corrupt
   * the frame that follows it.
   */
  @Test
  fun badFrameInASequenceIsNotAmplifiedAndDoesNotPoisonTheNextFrame() {
    val (cases, _) = GoldenBodyFrames.load()
    val (manifest, dims) = GoldenBodyFrames.fixture("n1b-fixture")
    val good = cases.first { it.id == "neutral-frontal" }.frame

    // An impossible single-frame displacement: the wearer's left shoulder
    // teleports across the body's midline and back.
    val bad = good.copy(leftShoulder = Landmark.Present(Vec2(0.95f, 0.28f), 1f))

    val before = LiveVtoGeometryPipeline.compute(manifest, good, "seq", CANVAS_W, CANVAS_H, dims.first, dims.second)
    val during = LiveVtoGeometryPipeline.compute(manifest, bad, "seq", CANVAS_W, CANVAS_H, dims.first, dims.second)
    val after = LiveVtoGeometryPipeline.compute(manifest, good, "seq", CANVAS_W, CANVAS_H, dims.first, dims.second)

    assertEquals("bad frame produced invalid geometry: " + during.validate(), emptyList<String>(), during.validate())
    assertTrue(
      "a crossed-over shoulder must be caught, not rendered",
      during.failure != null || !during.gatePassed,
    )
    assertNull("a rejected frame must not produce a mesh", during.meshVertices)

    // The next good frame must be byte-identical to the same pose computed
    // without the bad frame in between: the pipeline holds no state.
    assertEquals(
      "bad frame leaked state into the next frame",
      GeometrySnapshotJson.encode(before),
      GeometrySnapshotJson.encode(after),
    )
  }

  /**
   * Section 12: geometry must vary continuously with the pose. Interpolating
   * between two valid poses must not introduce a discontinuity the input
   * sequence does not itself contain.
   */
  @Test
  fun deformationIsContinuousAcrossASmoothSequence() {
    val (cases, _) = GoldenBodyFrames.load()
    val (manifest, dims) = GoldenBodyFrames.fixture("n1b-fixture")
    val a = cases.first { it.id == "neutral-frontal" }.frame
    val b = cases.first { it.id == "arms-slightly-out" }.frame

    fun lerp(t: Float): BodyFrame {
      fun mix(x: Landmark, y: Landmark): Landmark {
        val px = (x as? Landmark.Present)?.point ?: return Landmark.Absent
        val py = (y as? Landmark.Present)?.point ?: return Landmark.Absent
        return Landmark.Present(Vec2(px.x + (py.x - px.x) * t, px.y + (py.y - px.y) * t), 1f)
      }
      return a.copy(
        leftShoulder = mix(a.leftShoulder, b.leftShoulder), rightShoulder = mix(a.rightShoulder, b.rightShoulder),
        leftElbow = mix(a.leftElbow, b.leftElbow), rightElbow = mix(a.rightElbow, b.rightElbow),
        leftHip = mix(a.leftHip, b.leftHip), rightHip = mix(a.rightHip, b.rightHip),
        neckCenter = mix(a.neckCenter, b.neckCenter),
      )
    }

    val steps = 40
    var previous: GeometrySnapshot? = null
    var maxStep = 0f
    for (i in 0..steps) {
      val s = LiveVtoGeometryPipeline.compute(
        manifest, lerp(i.toFloat() / steps), "lerp", CANVAS_W, CANVAS_H, dims.first, dims.second,
      )
      assertNull("lerp step " + i + " refused: " + s.failure, s.failure)
      assertEquals("lerp step " + i + " invalid: " + s.validate(), emptyList<String>(), s.validate())
      previous?.let { prev ->
        for ((id, p) in s.controlPoints) {
          val q = prev.controlPoints.getValue(id)
          maxStep = maxOf(maxStep, (p - q).length())
        }
      }
      previous = s
    }
    // The whole sweep moves the elbows ~0.12 normalized (~86px). Split over
    // 40 steps, no single step may jump anywhere near the full sweep: a
    // discontinuity the input does not contain would blow straight past this.
    assertTrue("frame-to-frame control-point jump " + maxStep + "px is discontinuous for a smooth input", maxStep < 20f)
  }

  /**
   * Product switching (section 13 / amendment D16), at the geometry layer:
   * switching fixtures under the same BodyFrame must produce the new asset's
   * identity, and switching back must reproduce the original exactly. No
   * stale asset identity, no mixed state.
   */
  @Test
  fun switchingGarmentsUnderTheSamePoseCarriesNoStaleState() {
    val (cases, _) = GoldenBodyFrames.load()
    val frame = cases.first { it.id == "neutral-frontal" }.frame
    val (a, aDims) = GoldenBodyFrames.fixture("n1b-fixture")
    val (b, bDims) = GoldenBodyFrames.fixture("n1c-asym-fixture")

    val a1 = LiveVtoGeometryPipeline.compute(a, frame, "switch", CANVAS_W, CANVAS_H, aDims.first, aDims.second)
    val b1 = LiveVtoGeometryPipeline.compute(b, frame, "switch", CANVAS_W, CANVAS_H, bDims.first, bDims.second)
    val a2 = LiveVtoGeometryPipeline.compute(a, frame, "switch", CANVAS_W, CANVAS_H, aDims.first, aDims.second)

    assertEquals("switched snapshot must carry the new asset's identity", b.productId, b1.activeAssetId)
    assertEquals("switching back must restore the original identity", a.productId, a2.activeAssetId)
    assertEquals(
      "A -> B -> A must reproduce A exactly",
      GeometrySnapshotJson.encode(a1),
      GeometrySnapshotJson.encode(a2),
    )
    assertTrue("A and B must be distinguishable", a1.activeAssetId != b1.activeAssetId)
  }

  /** An invalid garment must be refused at parse, never partially rendered. */
  @Test
  fun invalidGarmentManifestsAreRefusedAtParse() {
    val root = GoldenBodyFrames.moduleRoot()
    val good = File(root, "android/src/main/assets/n1b-fixture/manifest.json").readText()

    val variants = listOf(
      "wrongSchema" to good.replace("\"version\": \"1.0\"", "\"version\": \"9.9\""),
      "missingHem" to good.replace("\"id\": \"leftHem\"", "\"id\": \"notAControlPoint\""),
      "wrongMesh" to good.replace("\"type\": \"grid\"", "\"type\": \"triangles\""),
    )
    for ((name, text) in variants) {
      assertTrue(name + ": the mutation must actually change the manifest", text != good)
      var refused = false
      try {
        KsgarmentManifest.parseAssetManifest(text)
      } catch (e: LiveVtoGarmentValidationException) {
        refused = true
      }
      assertTrue(name + ": expected the manifest to be refused", refused)
    }

    var refusedCorrupt = false
    try {
      KsgarmentManifest.parseAssetManifest("{\"ksgarment\": {\"version\"")
    } catch (e: Exception) {
      refusedCorrupt = true
    }
    assertTrue("corrupt manifest text must be refused", refusedCorrupt)
  }

  /** The pipeline is pure: same inputs, byte-identical snapshot, every time. */
  @Test
  fun pipelineIsDeterministic() {
    val (cases, _) = GoldenBodyFrames.load()
    val (manifest, dims) = GoldenBodyFrames.fixture("n1b-fixture")
    for (case in cases) {
      val first = GeometrySnapshotJson.encode(
        LiveVtoGeometryPipeline.compute(manifest, case.frame, case.id, CANVAS_W, CANVAS_H, dims.first, dims.second), true,
      )
      repeat(3) {
        val again = GeometrySnapshotJson.encode(
          LiveVtoGeometryPipeline.compute(manifest, case.frame, case.id, CANVAS_W, CANVAS_H, dims.first, dims.second), true,
        )
        assertEquals(case.id + ": pipeline is not deterministic", first, again)
      }
    }
  }
}
