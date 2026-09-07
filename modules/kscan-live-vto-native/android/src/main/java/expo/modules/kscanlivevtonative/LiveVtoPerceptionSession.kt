package expo.modules.kscanlivevtonative

import java.util.concurrent.atomic.AtomicLong

/**
 * N1-E: drives NATIVE_REPLAY FRAME -> REAL PERCEPTION -> BodyFrame ->
 * existing native deformation -> existing native renderer (mission
 * section 0/13).
 *
 * Reuses `LatestStateSlot` from N1-D (`LiveVtoReplayRuntime.kt`) for BOTH
 * boundaries this session has to be bounded across:
 *
 *   frame producer -> [inputSlot: PerceptionInputFrame] -> perception step
 *   perception step -> [geometrySlot: GeometrySnapshot]  -> Canvas draw
 *
 * Two independent slots, two independent drop counters -- mission section
 * 24 explicitly forbids merging "replay drops" (a produced frame that was
 * never even submitted to perception because a newer one overwrote it)
 * with "inference drops" (a computed geometry snapshot the renderer never
 * consumed). `inputSlot.droppedCount` and `geometrySlot.droppedCount` are
 * that separation, for free, from an already-tested class.
 *
 * This session owns no threads of its own, exactly like
 * `LiveVtoReplaySession` -- `submitFrame` is called by whatever produces
 * frames, `runOneInferenceStep` by whatever runs the perception loop
 * (`LiveVtoPerceptionDriver`), so the whole state machine and its
 * bounded-drop accounting is testable on the JVM against a fake
 * `PerceptionProvider`, independent of whether a real device can execute
 * the real model.
 */
data class PerceptionStats(
  val produced: Long,
  val submittedToPerception: Long,
  val inferred: Long,
  val droppedBeforePerception: Long,
  val refused: Long,
  val rendered: Long,
  val droppedBeforeRender: Long,
  val maxInputSlotDepth: Int,
  val maxGeometrySlotDepth: Int,
)

class LiveVtoPerceptionSession(
  private val provider: PerceptionProvider,
  private val canvasWidth: Float,
  private val canvasHeight: Float,
  private val onEvent: (ReplayEvent) -> Unit = {},
  /** Diagnostic-only observer, fired synchronously on the perception thread right after a geometry snapshot is computed (whether or not its rigid gate passed). Never used to leak data across the JS bridge -- Android-side logging only. */
  private val onSnapshotComputed: (GeometrySnapshot) -> Unit = {},
) {
  private val lock = Any()

  @Volatile private var state: ReplayState = ReplayState.IDLE
  @Volatile private var garment: KsgarmentManifest? = null
  @Volatile private var textureWidth: Int = 0
  @Volatile private var textureHeight: Int = 0
  @Volatile private var lastError: String? = null

  val inputSlot = LatestStateSlot<PerceptionInputFrame>()
  val geometrySlot = LatestStateSlot<GeometrySnapshot>()

  private val producedCount = AtomicLong(0)
  private val inferredCount = AtomicLong(0)
  private val refusedCount = AtomicLong(0)
  @Volatile private var maxInputDepth = 0
  @Volatile private var maxGeometryDepth = 0

  fun currentState(): ReplayState = state

  fun stats(): PerceptionStats = PerceptionStats(
    produced = producedCount.get(),
    submittedToPerception = inputSlot.publishedCount,
    inferred = inferredCount.get(),
    droppedBeforePerception = inputSlot.droppedCount,
    refused = refusedCount.get(),
    rendered = geometrySlot.consumedCount,
    droppedBeforeRender = geometrySlot.droppedCount,
    maxInputSlotDepth = maxInputDepth,
    maxGeometrySlotDepth = maxGeometryDepth,
  )

  private fun emit() = onEvent(ReplayEvent(state, garment?.productId, provider.getCapability().providerName, lastError))
  private fun transition(next: ReplayState) {
    if (next == ReplayState.ERROR) {
      inputSlot.clear()
      geometrySlot.clear()
    }
    state = next
    emit()
  }

  /**
   * Loads a garment and initializes the real perception provider. This is
   * the ONLY place `provider.initialize()` is called -- a real model load,
   * on whatever thread calls `load()` (the driver calls it from the
   * perception thread, never the UI thread; see amendment/mission section
   * 23).
   */
  fun load(manifest: KsgarmentManifest, texWidth: Int, texHeight: Int): Boolean = synchronized(lock) {
    if (state == ReplayState.DISPOSED) return false
    if (state == ReplayState.PLAYING || state == ReplayState.PAUSED) return false
    transition(ReplayState.LOADING)
    if (texWidth <= 0 || texHeight <= 0) {
      lastError = "invalid texture dimensions"
      transition(ReplayState.ERROR)
      return false
    }
    val ok = try {
      provider.initialize()
    } catch (t: Throwable) {
      lastError = t.message ?: t.toString()
      false
    }
    if (!ok) {
      lastError = lastError ?: "provider.initialize() returned false"
      transition(ReplayState.ERROR)
      return false
    }
    garment = manifest
    textureWidth = texWidth
    textureHeight = texHeight
    lastError = null
    inputSlot.clear()
    geometrySlot.clear()
    transition(ReplayState.READY)
    return true
  }

  fun start(): Boolean = synchronized(lock) {
    if (state != ReplayState.READY && state != ReplayState.STOPPED) return false
    transition(ReplayState.PLAYING)
    return true
  }

  fun stop(): Boolean = synchronized(lock) {
    if (state != ReplayState.PLAYING && state != ReplayState.PAUSED) return false
    inputSlot.clear()
    geometrySlot.clear()
    transition(ReplayState.STOPPED)
    return true
  }

  fun dispose(): Boolean = synchronized(lock) {
    if (state == ReplayState.DISPOSED) return false
    inputSlot.clear()
    geometrySlot.clear()
    try {
      provider.dispose()
    } catch (t: Throwable) {
      lastError = t.message ?: t.toString()
    }
    state = ReplayState.DISPOSED
    onEvent(ReplayEvent(ReplayState.DISPOSED, null, provider.getCapability().providerName, lastError))
    return true
  }

  /** Called by the (fast) frame-producer clock. Bounded: publish overwrites, never queues. */
  fun submitFrame(frame: PerceptionInputFrame): Boolean {
    if (state != ReplayState.PLAYING) return false
    producedCount.incrementAndGet()
    inputSlot.publish(frame)
    if (inputSlot.depth > maxInputDepth) maxInputDepth = inputSlot.depth
    return true
  }

  /**
   * Called by the (slower, real-inference-bound) perception loop. Runs
   * REAL provider inference -- never throws, per mission section 22: a
   * provider exception is caught, counted as refused, and the session
   * stays alive for the next frame.
   */
  fun runOneInferenceStep(): Boolean {
    if (state != ReplayState.PLAYING) return false
    val activeGarment = garment ?: return false
    val input = inputSlot.consume() ?: return false

    val result = try {
      provider.processFrame(input)
    } catch (t: Throwable) {
      PerceptionResult.Failure(t.message ?: t.toString())
    }
    inferredCount.incrementAndGet()

    when (result) {
      is PerceptionResult.Success -> {
        when (val adapted = LiveVtoBodyFrameAdapter.adapt(result.frame)) {
          is LiveVtoBodyFrameAdapter.Result.Mapped -> {
            val snapshot = LiveVtoGeometryPipeline.compute(
              manifest = activeGarment,
              frame = adapted.frame,
              bodyFrameId = "perception#${inferredCount.get()}",
              canvasWidth = canvasWidth,
              canvasHeight = canvasHeight,
              textureWidth = textureWidth,
              textureHeight = textureHeight,
            )
            onSnapshotComputed(snapshot)
            synchronized(lock) {
              if (state != ReplayState.PLAYING || garment !== activeGarment) return true
              geometrySlot.publish(snapshot)
              if (geometrySlot.depth > maxGeometryDepth) maxGeometryDepth = geometrySlot.depth
            }
          }
          is LiveVtoBodyFrameAdapter.Result.NoUsablePose, is LiveVtoBodyFrameAdapter.Result.InvalidProviderOutput -> {
            refusedCount.incrementAndGet()
          }
        }
      }
      is PerceptionResult.NoPose, is PerceptionResult.Failure -> refusedCount.incrementAndGet()
    }
    return true
  }

  fun consumeForRender(): GeometrySnapshot? = geometrySlot.consume()
}
