package expo.modules.kscanlivevtonative

/**
 * The single geometry entry point: (garment manifest, BodyFrame) -> GeometrySnapshot.
 *
 * Every consumer goes through here -- the diagnostic render view, the
 * conformance unit tests, and (from N1-D) the replay pipeline's deformation
 * executor. One code path means a snapshot captured in a test is, by
 * construction, the geometry the renderer would draw (amendment D8), and a
 * later renderer-backend change cannot silently diverge from what the
 * goldens measured.
 *
 * Pure: no Android types, no I/O, no clock, no thread affinity. Safe to run
 * on a background executor (amendment D10) and safe to run 10,000 times in
 * a JVM test.
 *
 * FAIL-CLOSED CONTRACT. Every refusal path returns a snapshot whose
 * `failure` is set and whose geometry is empty. It never throws, never
 * returns half-computed geometry, and never invents a landmark it was not
 * given -- see `refusal` below for the enumerated reasons, which mirror the
 * P3-A reference's own `AnchorFailure` set plus the finite-ness guards the
 * reference gets for free from JS number semantics and Kotlin does not.
 */
object LiveVtoGeometryPipeline {

  /** Reasons the pipeline refuses. Stable strings -- goldens assert on them. */
  object Refusal {
    const val MISSING_SHOULDERS = "missing_shoulders"
    const val MISSING_HIPS = "missing_hips"
    const val DEGENERATE_SHOULDER_SPAN = "degenerate_shoulder_span"
    const val DEGENERATE_BODY_AXIS = "degenerate_body_axis"
    const val NON_FINITE_LANDMARK = "non_finite_landmark"
    const val MISSING_GARMENT_CONTROL_POINTS = "missing_garment_control_points"
    const val DEGENERATE_GARMENT_SPAN = "degenerate_garment_span"
    const val NON_FINITE_GEOMETRY = "non_finite_geometry"
  }

  fun compute(
    manifest: KsgarmentManifest,
    frame: BodyFrame,
    bodyFrameId: String,
    canvasWidth: Float,
    canvasHeight: Float,
    textureWidth: Int,
    textureHeight: Int,
  ): GeometrySnapshot {
    fun refuse(reason: String) = GeometrySnapshot(
      fixtureId = manifest.productId,
      bodyFrameId = bodyFrameId,
      activeAssetId = manifest.productId,
      assetVersion = manifest.assetVersion,
      controlPoints = emptyMap(),
      boundsMin = Vec2(0f, 0f),
      boundsMax = Vec2(0f, 0f),
      scale = 0f,
      rotationRadians = 0f,
      gatePassed = false,
      gateFindings = emptyList(),
      canvasWidth = canvasWidth,
      canvasHeight = canvasHeight,
      textureWidth = textureWidth,
      textureHeight = textureHeight,
      meshWidth = manifest.meshDefinition.width,
      meshHeight = manifest.meshDefinition.height,
      meshVertices = null,
      failure = reason,
    )

    val anchors = when (val extracted = extractBodyAnchors(frame, canvasWidth, canvasHeight)) {
      is AnchorResult.Failure -> return refuse(extracted.reason)
      is AnchorResult.Success -> extracted.anchors
    }

    val targets = try {
      computeControlPointTargets(anchors, manifest, textureWidth, textureHeight)
    } catch (e: LiveVtoGeometryRefusal) {
      return refuse(e.reason)
    }

    val placement = fitRigidPlacement(manifest, targets, textureWidth, textureHeight)
      ?: return refuse(Refusal.MISSING_GARMENT_CONTROL_POINTS)
    val gate = evaluateRigidGate(anchors, manifest, placement, textureWidth, textureHeight)

    // Deformation only runs behind a passing rigid gate: "deformation cannot
    // repair incorrect semantic anchoring" (P3-A attachment.ts).
    val meshVertices = if (gate.passed) buildDeformedMeshVertices(manifest, targets.targets) else null

    var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
    var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
    for (p in targets.targets.values) {
      if (!p.isFinite) return refuse(Refusal.NON_FINITE_GEOMETRY)
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y
    }
    if (targets.targets.isEmpty()) return refuse(Refusal.MISSING_GARMENT_CONTROL_POINTS)
    if (!placement.scale.isFinite() || !placement.rotationRadians.isFinite()) return refuse(Refusal.NON_FINITE_GEOMETRY)
    if (meshVertices != null && meshVertices.any { !it.isFinite() }) return refuse(Refusal.NON_FINITE_GEOMETRY)

    return GeometrySnapshot(
      fixtureId = manifest.productId,
      bodyFrameId = bodyFrameId,
      activeAssetId = manifest.productId,
      assetVersion = manifest.assetVersion,
      controlPoints = targets.targets.mapKeys { it.key.id },
      boundsMin = Vec2(minX, minY),
      boundsMax = Vec2(maxX, maxY),
      scale = placement.scale,
      rotationRadians = placement.rotationRadians,
      gatePassed = gate.passed,
      gateFindings = gate.findings,
      canvasWidth = canvasWidth,
      canvasHeight = canvasHeight,
      textureWidth = textureWidth,
      textureHeight = textureHeight,
      meshWidth = manifest.meshDefinition.width,
      meshHeight = manifest.meshDefinition.height,
      meshVertices = meshVertices,
      failure = null,
    )
  }
}

/** Internal signal from a geometry stage that it cannot proceed. Never escapes `compute`. */
class LiveVtoGeometryRefusal(val reason: String) : Exception(reason)
