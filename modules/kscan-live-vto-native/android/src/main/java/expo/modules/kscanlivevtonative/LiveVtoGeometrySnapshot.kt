package expo.modules.kscanlivevtonative

/**
 * The computed geometry for one (garment, BodyFrame) pair, BEFORE any
 * rasterization.
 *
 * Amendment D8: N1-C conformance is measured on THIS, not on screenshots.
 * A screenshot proves a garment-shaped thing appeared; only the numbers
 * prove it appeared in the same place the P3-A reference oracle puts it.
 * `LiveVtoGeometryPipeline.compute` is the single code path that produces
 * one, and it is the same path `LiveVtoTestRenderView` draws from -- a
 * snapshot can never describe state the renderer did not actually receive.
 *
 * Immutable by construction: the deformation executor publishes a finished
 * snapshot into a latest-state slot and the draw call reads it (amendment
 * D10/D14). Nothing mutates a snapshot after publication.
 */
data class GeometrySnapshot(
  val fixtureId: String,
  val bodyFrameId: String,
  val activeAssetId: String,
  val assetVersion: String,
  /** Body-space canvas-pixel target for every control point the manifest declares. */
  val controlPoints: Map<String, Vec2>,
  val boundsMin: Vec2,
  val boundsMax: Vec2,
  val scale: Float,
  val rotationRadians: Float,
  val gatePassed: Boolean,
  val gateFindings: List<String>,
  val canvasWidth: Float,
  val canvasHeight: Float,
  val textureWidth: Int,
  val textureHeight: Int,
  val meshWidth: Int,
  val meshHeight: Int,
  /** Flattened (x,y) pairs, mesh row-major -- exactly what Canvas.drawBitmapMesh consumes. Null when the gate refused. */
  val meshVertices: FloatArray?,
  /** Non-null only when the pipeline refused: the snapshot then carries no geometry. */
  val failure: String?,
) {
  val boundsWidth: Float get() = boundsMax.x - boundsMin.x
  val boundsHeight: Float get() = boundsMax.y - boundsMin.y

  /**
   * The invariant every snapshot must satisfy before it is allowed to reach
   * a renderer. Amendment D12/D13: a bad BodyFrame must fail closed, never
   * produce a geometry explosion, a NaN, or a negative dimension.
   */
  fun validate(): List<String> {
    if (failure != null) return emptyList() // a refusal carries no geometry to validate
    val problems = mutableListOf<String>()
    for ((id, p) in controlPoints) {
      if (!p.isFinite) problems.add("non_finite_control_point:$id")
    }
    if (!boundsMin.isFinite || !boundsMax.isFinite) problems.add("non_finite_bounds")
    if (boundsWidth < 0f || boundsHeight < 0f) problems.add("negative_bounds")
    if (!scale.isFinite() || scale <= 0f) problems.add("invalid_scale")
    if (!rotationRadians.isFinite()) problems.add("non_finite_rotation")
    meshVertices?.forEachIndexed { i, v -> if (!v.isFinite()) problems.add("non_finite_mesh_vertex:$i") }
    // A garment whose bounds exceed this multiple of the canvas is an
    // explosion, not a large garment: the rigid gate's own scale band
    // (0.55..1.8) cannot produce it.
    val explosionLimit = 8f
    if (boundsWidth > canvasWidth * explosionLimit || boundsHeight > canvasHeight * explosionLimit) {
      problems.add("geometry_explosion")
    }
    return problems
  }

  override fun equals(other: Any?): Boolean = this === other
  override fun hashCode(): Int = System.identityHashCode(this)
}
