package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * OCCLUSION, AT THE ONLY LAYER THIS LANE CAN HONESTLY REACH.
 *
 * WHAT THIS TEST IS NOT. It does not prove the garment looks right when an
 * arm crosses the torso. Nothing off a device can prove that, and mission
 * section 30's verdict on occlusion QUALITY stays PENDING-RUNTIME.
 *
 * WHY NO SEGMENTATION WAS ADDED. The bundled MediaPipe Pose Landmarker CAN
 * emit a segmentation mask -- `LiveVtoMediaPipePoseProvider` passes
 * `setOutputSegmentationMasks(false)` deliberately, so the capability exists
 * and is switched off. Turning it on is not free and not verifiable here:
 * it adds real per-frame mask generation to a pipeline whose device
 * behaviour is unmeasured and whose one measured device already carries a
 * camera hold, and CONSUMING a mask means a new masked-compositing path in
 * the renderer whose visual correctness cannot be checked without a phone.
 * Section 46 forbids performance work without device evidence; shipping an
 * unvalidatable performance REGRESSION is worse than the same rule read
 * backwards. Section 30's own fallback is what this file does instead:
 * preserve z-order, prevent the gross errors source-level logic can prevent,
 * and add replay tests for the likely occlusion cases.
 *
 * WHAT IT DOES PROVE, AND WHY IT MATTERS FOR OCCLUSION. Without a mask, a
 * limb crossing the torso is simply drawn UNDER the garment. That is a known
 * limitation, and it is survivable -- as long as the TORSO does not move when
 * the limb does. If arm motion perturbed the torso anchoring, the customer
 * would see the whole garment swim every time they gestured, which reads as a
 * broken renderer rather than as absent occlusion.
 *
 * "The garment does not move" would be too strong, and the first version of
 * this file asserted it and was wrong: the sleeves DO articulate to the elbow
 * direction, by design and by `LiveVtoGarmentAttachment`'s own statement of
 * it. The real split is torso-frozen / sleeves-free, and both halves are
 * asserted below -- the second as a negative control, so a refactor that
 * accidentally froze the sleeves could not pass by making the first one
 * trivially true.
 */
class OcclusionStabilityTest {

  private val canvasW = 720f
  private val canvasH = 960f

  private fun manifest(): KsgarmentManifest {
    val root = GoldenBodyFrames.moduleRoot()
    val text = java.io.File(root, "android/src/main/assets/n1b-fixture/manifest.json").readText()
    return KsgarmentManifest.parseAssetManifest(text)
  }

  private fun compute(frame: BodyFrame): GeometrySnapshot =
    LiveVtoGeometryPipeline.compute(
      manifest = manifest(),
      frame = frame,
      bodyFrameId = "occlusion-test",
      canvasWidth = canvasW,
      canvasHeight = canvasH,
      textureWidth = 512,
      textureHeight = 512,
    )

  /**
   * Move ONLY the arm landmarks: the TORSO anchoring must not move at all,
   * and only the SLEEVES may follow.
   *
   * THE FIRST VERSION OF THIS TEST ASSERTED THE WRONG THING and failed
   * immediately, which is the test working. It claimed nothing about the
   * garment should move when an arm moves. That is false by design:
   * `LiveVtoGarmentAttachment` says so in its own words -- "Sleeves are the
   * one family that does not follow the torso frame: they rotate to the
   * elbow direction". A sleeve that ignored the arm would be the defect.
   *
   * The invariant that actually matters for a renderer with no occlusion
   * mask is narrower and stronger: the nine TORSO control points must be
   * BIT-IDENTICAL across every arm pose. Exact equality, not a tolerance --
   * the torso anchors are computed from shoulders and hips, neither of which
   * changes here, so any difference at all means an arm landmark leaked into
   * the torso frame, and a tolerance would let a small leak through while
   * reporting that it was fine.
   */
  @Test
  fun armMotionDoesNotMoveTheGarment() {
    val neutral = BodyFrame.neutral(timestampMs = 0L)

    // Every arm pose a customer produces in normal use, including the two
    // the QA packet's Journey C asks for by name (arm across torso, arms
    // raised overhead).
    val armPoses = mapOf(
      "arms slightly out" to BodyFrame.armsSlightlyOut(timestampMs = 0L),
      "left arm across torso" to neutral.copy(
        leftElbow = Landmark.Present(Vec2(0.45f, 0.42f), 1f),
        leftWrist = Landmark.Present(Vec2(0.58f, 0.44f), 1f),
      ),
      "right arm across torso" to neutral.copy(
        rightElbow = Landmark.Present(Vec2(0.55f, 0.42f), 1f),
        rightWrist = Landmark.Present(Vec2(0.42f, 0.44f), 1f),
      ),
      "both arms overhead" to neutral.copy(
        leftElbow = Landmark.Present(Vec2(0.36f, 0.12f), 1f),
        leftWrist = Landmark.Present(Vec2(0.34f, 0.02f), 1f),
        rightElbow = Landmark.Present(Vec2(0.64f, 0.12f), 1f),
        rightWrist = Landmark.Present(Vec2(0.66f, 0.02f), 1f),
      ),
      "arms absent entirely" to neutral.copy(
        leftElbow = Landmark.Absent,
        leftWrist = Landmark.Absent,
        rightElbow = Landmark.Absent,
        rightWrist = Landmark.Absent,
      ),
    )

    val sleeveIds = setOf(
      GarmentControlPointId.LEFT_SLEEVE.id,
      GarmentControlPointId.RIGHT_SLEEVE.id,
    )

    val reference = compute(neutral)
    assertNull("the neutral pose must produce real geometry for this to mean anything", reference.failure)
    assertTrue("the neutral pose must pass the rigid gate", reference.gatePassed)
    assertTrue(
      "the reference must actually contain torso control points, or this proves nothing",
      reference.controlPoints.keys.any { it !in sleeveIds },
    )

    for ((name, frame) in armPoses) {
      val moved = compute(frame)
      assertNull("$name must still produce geometry", moved.failure)
      assertEquals("$name changed the rigid gate outcome", reference.gatePassed, moved.gatePassed)
      assertEquals("$name moved the garment scale", reference.scale, moved.scale, 0.0f)
      assertEquals("$name rotated the garment", reference.rotationRadians, moved.rotationRadians, 0.0f)
      assertEquals(
        "$name changed the control-point set",
        reference.controlPoints.keys.sorted(),
        moved.controlPoints.keys.sorted(),
      )
      for ((id, point) in reference.controlPoints) {
        if (id in sleeveIds) continue // articulating to the arm is the design
        val other = moved.controlPoints[id]!!
        assertEquals("$name moved TORSO control point $id (x)", point.x, other.x, 0.0f)
        assertEquals("$name moved TORSO control point $id (y)", point.y, other.y, 0.0f)
      }
    }
  }

  /**
   * The other half of the same claim, stated as a negative control: the
   * sleeves DO move. Without this, the test above would still pass if a
   * refactor accidentally froze the sleeves to the torso frame -- the
   * garment would stop articulating and nothing would say so.
   */
  @Test
  fun theSleevesDoFollowTheArmsEvenThoughTheTorsoDoesNot() {
    val neutral = compute(BodyFrame.neutral(timestampMs = 0L))
    val armsOut = compute(BodyFrame.armsSlightlyOut(timestampMs = 0L))
    var moved = 0
    for (id in listOf(GarmentControlPointId.LEFT_SLEEVE.id, GarmentControlPointId.RIGHT_SLEEVE.id)) {
      val before = neutral.controlPoints[id] ?: continue
      val after = armsOut.controlPoints[id] ?: continue
      if (abs(before.x - after.x) > 0.01f || abs(before.y - after.y) > 0.01f) moved += 1
    }
    assertEquals("both sleeves must articulate to the arm direction", 2, moved)
  }

  /**
   * A partial torso turn DOES legitimately move the garment -- that is the
   * deformation working. What must not happen is a turn producing a
   * DISCONTINUITY: the garment jumping across the canvas, inverting, or
   * collapsing to nothing. Those are the gross rendering errors section 30
   * says to prevent where source-level logic can.
   */
  @Test
  fun aPartialTorsoTurnMovesTheGarmentSmoothlyRatherThanJumping() {
    val (cases, _) = GoldenBodyFrames.load()
    val neutral = cases.first { it.id == "neutral-frontal" }
    val reference = compute(neutral.frame)
    assertNull(reference.failure)

    for (id in listOf("torso-rotated-left", "torso-rotated-right")) {
      val turned = compute(cases.first { it.id == id }.frame)
      assertNull("$id must produce geometry, not a refusal", turned.failure)

      // Positive scale, finite rotation: never inverted, never collapsed.
      assertTrue("$id produced a non-positive scale (${turned.scale})", turned.scale > 0f)
      assertTrue("$id produced a non-finite rotation", turned.rotationRadians.isFinite())

      // The garment stays in the same neighbourhood. A modest turn that
      // relocated the garment by most of the canvas is a jump, not a turn.
      val dx = abs(turned.boundsMin.x - reference.boundsMin.x)
      val dy = abs(turned.boundsMin.y - reference.boundsMin.y)
      assertTrue("$id moved the garment $dx px horizontally -- that is a jump", dx < canvasW * 0.5f)
      assertTrue("$id moved the garment $dy px vertically -- that is a jump", dy < canvasH * 0.5f)

      // And it still has real extent.
      assertTrue("$id collapsed the garment horizontally", turned.boundsMax.x > turned.boundsMin.x)
      assertTrue("$id collapsed the garment vertically", turned.boundsMax.y > turned.boundsMin.y)
    }
  }

  /**
   * TRACKING DEGRADATION MUST NOT DRAW SOMETHING WRONG. Every golden refusal
   * case -- a missing shoulder, a NaN landmark, an impossible coordinate --
   * must produce a refusal with EMPTY geometry, never a half-computed
   * placement a renderer would happily draw.
   *
   * This is the occlusion case that actually matters without a mask: when
   * the perception stack loses confidence, the correct thing to show is
   * nothing, not a garment attached to a landmark that was never there.
   */
  @Test
  fun degradedTrackingRefusesRatherThanDrawingHalfComputedGeometry() {
    val (_, refusals) = GoldenBodyFrames.load()
    assertTrue("the golden set must carry refusal cases", refusals.isNotEmpty())
    var pipelineRefusals = 0
    var gateRefusals = 0
    for (case in refusals) {
      val snapshot = compute(case.frame)

      // TWO valid refusal shapes, and the first version of this test only
      // knew about one -- it demanded `failure != null` and failed on
      // `impossible-coordinate`, which the golden set itself declares as a
      // GATE finding (`garment_largely_outside_torso`), not a pipeline
      // refusal. That is the pipeline being MORE careful, not less: the
      // anchors were all present and finite, so it computed them and then
      // the rigid gate judged the result unusable.
      //
      // What matters for the renderer is identical either way, and it is the
      // thing actually asserted below: NOTHING DRAWABLE comes back.
      if (snapshot.failure != null) {
        pipelineRefusals += 1
        assertTrue("${case.id} was refused but kept control points", snapshot.controlPoints.isEmpty())
        assertEquals("${case.id} was refused but kept a scale", 0f, snapshot.scale, 0.0f)
      } else {
        gateRefusals += 1
        assertTrue(
          "${case.id} produced neither a refusal nor a gate failure -- it would be DRAWN",
          !snapshot.gatePassed,
        )
      }
      assertTrue("${case.id} was refused but kept a mesh to draw", snapshot.meshVertices == null)
      assertTrue("${case.id} was refused but passed the gate", !snapshot.gatePassed)
    }
    // Both shapes must actually be exercised, or a future change that
    // collapsed one into the other would go unnoticed.
    assertTrue("the golden set no longer exercises pipeline refusals", pipelineRefusals > 0)
    assertTrue("the golden set no longer exercises gate refusals", gateRefusals > 0)
  }

  /**
   * Z-ORDER IS PRESERVED, structurally. The garment is drawn over the camera
   * preview and under nothing else, and there is exactly one draw of it.
   * Checked against the source because it is a property of the composition
   * order, not of any value a computation returns.
   */
  @Test
  fun theGarmentIsCompositedOverTheCameraPreviewExactlyOnce() {
    val view = java.io.File(
      GoldenBodyFrames.moduleRoot(),
      "android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoTestRenderView.kt",
    ).readText()

    // FOUR call sites, not one -- the first version of this test asserted one
    // and failed at four, which was the test misreading the file rather than
    // a defect. `active`, `replay`, `perception` and `live`/`camera` are four
    // independent modes, each with its own draw; exactly one runs per frame
    // because the modes are mutually exclusive at the prop level. What would
    // be a real fault is one MODE drawing twice, doubling the garment's alpha
    // -- so the count is pinned to the number of modes, and a fifth draw
    // appearing without a fifth mode fails here.
    val meshDraws = Regex("drawBitmapMesh\\(").findAll(view).count()
    val modeProps = listOf("var active:", "var replay:", "var perception:", "var camera:")
      .count { view.contains(it) }
    assertEquals("modes and mesh draws must correspond one to one", modeProps, meshDraws)

    // Z-ORDER. The camera preview is inserted at the BOTTOM of the hierarchy
    // and this view paints over it, so the garment is composited ON the
    // preview and never behind it.
    assertTrue(
      "the camera preview must be added beneath this view's own drawing",
      view.contains("addView(pv"),
    )
    assertTrue(
      "this view must paint its own content over its children",
      view.contains("setWillNotDraw(false)"),
    )
  }
}
