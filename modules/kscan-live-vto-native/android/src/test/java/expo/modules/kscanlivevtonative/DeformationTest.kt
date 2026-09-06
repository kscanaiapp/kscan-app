package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val CANVAS_W = 720f
private const val CANVAS_H = 960f

/**
 * Properties of the affine-MLS deformation that hold independently of the
 * reference oracle. Cross-runtime agreement is measured separately by
 * `tools/compare-conformance.mjs`; these are the mathematical invariants
 * that would still have to hold if the oracle vanished.
 */
class DeformationTest {

  private fun pair(sx: Float, sy: Float, tx: Float, ty: Float) =
    LiveVtoDeformation.ControlPointPair(Vec2(sx, sy), Vec2(tx, ty))

  /**
   * Exact interpolation at a control point -- the w_i -> infinity limit.
   * Without this, every control point would be approximated rather than
   * hit, and the control-point conformance table would be measuring
   * something the mesh does not actually pass through.
   */
  @Test
  fun deformationIsExactAtEveryControlPoint() {
    val pairs = listOf(
      pair(10f, 10f, 100f, 200f),
      pair(200f, 20f, 400f, 220f),
      pair(15f, 300f, 120f, 700f),
      pair(210f, 310f, 420f, 710f),
    )
    for (cp in pairs) {
      val result = LiveVtoDeformation.deformVertex(cp.source, pairs)
      assertEquals("x at control point ${cp.source}", cp.target.x, result.x, 1e-4f)
      assertEquals("y at control point ${cp.source}", cp.target.y, result.y, 1e-4f)
    }
  }

  /**
   * If the correspondences ARE an affine map, affine MLS must reproduce
   * that map exactly everywhere -- not just at the control points. This is
   * the strongest available check that the normal equations and the 2x2
   * inverse are right, and it fails loudly for a transposed matrix or a
   * swapped index, which a control-point-only test would not catch.
   */
  @Test
  fun anAffineCorrespondenceIsReproducedExactlyEverywhere() {
    // (x, y) -> (1.3x - 0.4y + 25, 0.2x + 1.1y - 12)
    fun affine(v: Vec2) = Vec2(1.3f * v.x - 0.4f * v.y + 25f, 0.2f * v.x + 1.1f * v.y - 12f)
    val sources = listOf(
      Vec2(0f, 0f), Vec2(271f, 0f), Vec2(0f, 302f), Vec2(271f, 302f),
      Vec2(135f, 90f), Vec2(60f, 240f), Vec2(210f, 200f),
    )
    val pairs = sources.map { LiveVtoDeformation.ControlPointPair(it, affine(it)) }

    for (x in 0..271 step 19) {
      for (y in 0..302 step 23) {
        val v = Vec2(x.toFloat(), y.toFloat())
        val expected = affine(v)
        val actual = LiveVtoDeformation.deformVertex(v, pairs)
        assertEquals("x at $v", expected.x, actual.x, 0.02f)
        assertEquals("y at $v", expected.y, actual.y, 0.02f)
      }
    }
  }

  /** A pure translation is the degenerate affine case and must be exact. */
  @Test
  fun aPureTranslationIsReproducedExactly() {
    val pairs = listOf(
      pair(0f, 0f, 50f, 70f),
      pair(100f, 0f, 150f, 70f),
      pair(0f, 100f, 50f, 170f),
    )
    val result = LiveVtoDeformation.deformVertex(Vec2(40f, 60f), pairs)
    assertEquals(90f, result.x, 0.01f)
    assertEquals(130f, result.y, 0.01f)
  }

  /** Collinear sources are singular; the reference falls back to identity rather than exploding. */
  @Test
  fun aDegenerateControlPointConfigurationFallsBackRatherThanExploding() {
    val collinear = listOf(
      pair(0f, 0f, 10f, 10f),
      pair(50f, 0f, 60f, 10f),
      pair(100f, 0f, 110f, 10f),
    )
    val result = LiveVtoDeformation.deformVertex(Vec2(50f, 80f), collinear)
    assertTrue("degenerate configuration produced non-finite geometry: $result", result.isFinite)
    assertTrue("degenerate configuration exploded: $result", kotlin.math.abs(result.x) < 1e5f && kotlin.math.abs(result.y) < 1e5f)
  }

  /**
   * `meshDefinition.width`/`height` are VERTEX counts, and Android's
   * `drawBitmapMesh` takes CELL counts with (w+1)*(h+1) vertices. The
   * snapshot must publish cell counts whose implied vertex count matches
   * the array it also publishes -- N1-ENV-011 was exactly this mismatch.
   */
  @Test
  fun theSnapshotMeshShapeMatchesTheVertexArrayItPublishes() {
    val (cases, _) = GoldenBodyFrames.load()
    for (fixtureName in listOf("n1b-fixture", "n1c-asym-fixture")) {
      val (manifest, dims) = GoldenBodyFrames.fixture(fixtureName)
      val snapshot = LiveVtoGeometryPipeline.compute(
        manifest, cases.first { it.id == "neutral-frontal" }.frame, "neutral-frontal",
        CANVAS_W, CANVAS_H, dims.first, dims.second,
      )
      val verts = snapshot.meshVertices!!
      assertEquals(
        "$fixtureName: drawBitmapMesh requires (meshWidth+1)*(meshHeight+1) vertices",
        (snapshot.meshWidth + 1) * (snapshot.meshHeight + 1) * 2,
        verts.size,
      )
      assertEquals(
        "$fixtureName: the vertex grid must be the manifest's own vertex grid",
        manifest.meshDefinition.width * manifest.meshDefinition.height * 2,
        verts.size,
      )
    }
  }

  /**
   * The deformed mesh must actually track the pose. A deformation that
   * silently degenerated to a rigid placement would still pass the
   * control-point conformance table (the control points are placed by a
   * different stage), so assert the surface between them moves too.
   */
  @Test
  fun theDeformedMeshTracksThePoseNotJustTheControlPoints() {
    val (cases, _) = GoldenBodyFrames.load()
    val (manifest, dims) = GoldenBodyFrames.fixture("n1b-fixture")
    fun mesh(id: String) = LiveVtoGeometryPipeline.compute(
      manifest, cases.first { it.id == id }.frame, id, CANVAS_W, CANVAS_H, dims.first, dims.second,
    ).meshVertices!!

    val neutral = mesh("neutral-frontal")
    val leftUp = mesh("left-shoulder-raised")
    val rightUp = mesh("right-shoulder-raised")

    var movedVertices = 0
    for (i in neutral.indices step 2) {
      if (kotlin.math.hypot((leftUp[i] - neutral[i]).toDouble(), (leftUp[i + 1] - neutral[i + 1]).toDouble()) > 1.0) {
        movedVertices++
      }
    }
    assertTrue("raising a shoulder moved only $movedVertices mesh vertices", movedVertices > neutral.size / 4)

    // The two raised-shoulder cases must be genuine mirrors, not the same mesh.
    var differing = 0
    for (i in leftUp.indices) if (kotlin.math.abs(leftUp[i] - rightUp[i]) > 1f) differing++
    assertTrue("the left- and right-raised meshes are indistinguishable", differing > leftUp.size / 4)
  }

  /** Deformation stays finite across every valid golden, both fixtures. */
  @Test
  fun everyGoldenProducesAFiniteMesh() {
    val (cases, _) = GoldenBodyFrames.load()
    for (fixtureName in listOf("n1b-fixture", "n1c-asym-fixture")) {
      val (manifest, dims) = GoldenBodyFrames.fixture(fixtureName)
      for (case in cases) {
        val snapshot = LiveVtoGeometryPipeline.compute(
          manifest, case.frame, case.id, CANVAS_W, CANVAS_H, dims.first, dims.second,
        )
        val verts = snapshot.meshVertices
          ?: throw AssertionError("$fixtureName/${case.id}: no mesh produced")
        for ((i, value) in verts.withIndex()) {
          assertTrue("$fixtureName/${case.id}: non-finite mesh vertex at $i", value.isFinite())
        }
      }
    }
  }
}
