package expo.modules.kscanlivevtonative

import kotlin.math.hypot

/**
 * A plain 2D float vector.
 *
 * Deliberately NOT `android.graphics.PointF`. Every geometry stage of this
 * runtime -- anchors, control-point targets, rigid fit, rigid gate, mesh
 * deformation -- runs on this type and therefore has zero Android
 * dependencies, which buys two things the mission requires directly:
 *
 *  1. The whole geometry pipeline runs in a plain JVM unit test
 *     (`:kscan-live-vto-native:testDebugUnitTest`), so cross-runtime
 *     conformance against the P3-A reference oracle is measured
 *     numerically, deterministically, and repeatably -- not read off a
 *     screenshot and not gated on an emulator being healthy
 *     (amendment D8: "numerical geometry evidence is authoritative for
 *     geometry; screenshots are supplementary").
 *
 *  2. Deformation compute is structurally incapable of touching a Canvas,
 *     a View, or the UI thread (amendment D10) -- it consumes a BodyFrame
 *     and produces an immutable snapshot, and the only Android type in the
 *     render path lives in LiveVtoTestRenderView's draw call.
 *
 * Values are immutable; every operation returns a new instance.
 */
data class Vec2(val x: Float, val y: Float) {
  operator fun plus(o: Vec2) = Vec2(x + o.x, y + o.y)
  operator fun minus(o: Vec2) = Vec2(x - o.x, y - o.y)
  operator fun times(s: Float) = Vec2(x * s, y * s)
  fun length(): Float = hypot(x.toDouble(), y.toDouble()).toFloat()
  fun normalized(): Vec2 { val l = length(); return if (l < 1e-6f) Vec2(0f, 0f) else Vec2(x / l, y / l) }

  /** True when either component is NaN or infinite -- the finite-ness guard every stage boundary checks. */
  val isFinite: Boolean get() = x.isFinite() && y.isFinite()
}

fun dot(a: Vec2, b: Vec2): Float = a.x * b.x + a.y * b.y
