package expo.modules.kscanlivevtonative

import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * N1-D: the deterministic native replay runtime.
 *
 * Drives the SAME native pipeline that camera input will drive later
 * (mission section 15), with a synthetic frame source standing in for the
 * camera. Nothing here decodes frames in JS, sends frames to JS, or sends
 * BodyFrames to JS at frame rate -- JS issues bounded commands and receives
 * bounded state events (amendments D24, section 16).
 *
 * ── Why production is decoupled from render (amendment D14) ────────────────
 *
 * The producer advances on its own clock and publishes each finished
 * GeometrySnapshot into a single-slot `LatestStateSlot`. The renderer reads
 * whatever is currently in that slot. The producer NEVER waits for a render.
 *
 *     REPLAY CLOCK -> frame + BodyFrame -> geometry compute -> [latest slot] -> renderer
 *
 * A produce-then-await-render loop would make backpressure untestable by
 * construction: nothing could ever be dropped, and a "0 dropped frames"
 * result would prove nothing at all. Here, a renderer slower than the
 * producer provably drops stale frames and the slot stays depth-1.
 *
 * ── Threading ─────────────────────────────────────────────────────────────
 *
 * This class owns no threads. It exposes `advance()` as the single unit of
 * production work, and a driver decides what runs it: a real executor on
 * device, a deterministic loop in tests. That keeps the state machine and
 * the backpressure accounting fully testable on the JVM while the real
 * runtime still executes production and deformation off the UI thread (the
 * frozen topology is in docs/vto-live-native-runtime-n1.md).
 */
enum class ReplayState {
  IDLE,
  LOADING,
  READY,
  PLAYING,
  PAUSED,
  EOF,
  STOPPED,
  ERROR,
  DISPOSED,
}

/**
 * A single-slot latest-value holder with drop accounting.
 *
 * Bounded by construction: it holds at most one value, so no producer can
 * grow an unbounded backlog and no consumer can drain stale frames after the
 * fact. Overwriting an unconsumed value is a DROP, counted, not a silent
 * loss (mission section 23).
 */
class LatestStateSlot<T> {
  private val slot = AtomicReference<T?>(null)
  private val dropped = AtomicLong(0)
  private val published = AtomicLong(0)
  private val consumed = AtomicLong(0)

  fun publish(value: T) {
    val previous = slot.getAndSet(value)
    published.incrementAndGet()
    if (previous != null) dropped.incrementAndGet()
  }

  /** Takes the current value if there is one, leaving the slot empty. */
  fun consume(): T? {
    val value = slot.getAndSet(null)
    if (value != null) consumed.incrementAndGet()
    return value
  }

  /** Reads without consuming -- the draw path, which must be able to redraw the same state. */
  fun peek(): T? = slot.get()

  fun clear() { slot.set(null) }

  val publishedCount: Long get() = published.get()
  val consumedCount: Long get() = consumed.get()
  val droppedCount: Long get() = dropped.get()

  /** Always 0 or 1. Asserted in tests: the architecture cannot queue. */
  val depth: Int get() = if (slot.get() == null) 0 else 1
}

/** One replay frame: an index into the source plus the pose observed at it. */
data class ReplayFrame(val index: Int, val frame: BodyFrame)

/**
 * A deterministic native frame source (mission section 17). Synthetic:
 * a committed pose sequence, no person imagery, no licensed media.
 */
interface ReplayFrameSource {
  val frameCount: Int
  val id: String
  fun frameAt(index: Int): ReplayFrame
}

/** Bounded state event. Amendment D24: no frames, no landmarks, no per-frame geometry. */
data class ReplayEvent(
  val state: ReplayState,
  val fixtureId: String?,
  val sourceId: String?,
  val error: String?,
) {
  /**
   * The COMPLETE set of keys this event may ever carry across the bridge.
   * Asserted mechanically by the privacy test -- adding a field to this class
   * without adding it here fails the build rather than silently widening the
   * boundary.
   */
  companion object {
    val ALLOWED_PAYLOAD_KEYS = setOf("state", "fixtureId", "sourceId", "error")
  }

  fun toPayload(): Map<String, Any?> = mapOf(
    "state" to state.name,
    "fixtureId" to fixtureId,
    "sourceId" to sourceId,
    "error" to error,
  )
}

/** Counters for a replay run. Bounded, aggregate -- never per-frame data. */
data class ReplayStats(
  val produced: Long,
  val rendered: Long,
  val dropped: Long,
  val maxSlotDepth: Int,
  val refused: Long,
)

/**
 * The replay state machine and production loop.
 *
 * Every transition is explicit; there is no implicit state. An operation
 * that is not legal from the current state is a no-op that returns false,
 * never an exception and never a silent transition.
 */
class LiveVtoReplaySession(
  private val canvasWidth: Float,
  private val canvasHeight: Float,
  private val onEvent: (ReplayEvent) -> Unit = {},
) {
  private val lock = Any()

  @Volatile private var state: ReplayState = ReplayState.IDLE
  @Volatile private var source: ReplayFrameSource? = null
  @Volatile private var garment: KsgarmentManifest? = null
  @Volatile private var textureWidth: Int = 0
  @Volatile private var textureHeight: Int = 0
  @Volatile private var cursor: Int = 0
  @Volatile private var lastError: String? = null

  private val producedCount = AtomicLong(0)
  private val refusedCount = AtomicLong(0)
  @Volatile private var maxDepth = 0

  val slot = LatestStateSlot<GeometrySnapshot>()

  fun currentState(): ReplayState = state
  fun currentFixtureId(): String? = garment?.productId
  fun stats(): ReplayStats = ReplayStats(
    produced = producedCount.get(),
    rendered = slot.consumedCount,
    dropped = slot.droppedCount,
    maxSlotDepth = maxDepth,
    refused = refusedCount.get(),
  )

  private fun emit() = onEvent(ReplayEvent(state, garment?.productId, source?.id, lastError))

  private fun transition(next: ReplayState) {
    // ERROR must drop whatever geometry is still sitting in the slot.
    // Without this, a session that has just errored still has a readable
    // snapshot, and a renderer that peeks rather than consumes keeps drawing
    // the last good frame while the session behind it is broken -- a stale
    // render indistinguishable from a working one. Found by the
    // invalid-garment test, which is what that test exists for.
    //
    // EOF deliberately does NOT clear (documented resource contract, mission
    // section 20): the sequence ended normally, and the final frame is the
    // correct thing to leave on screen until the caller stops, restarts, or
    // disposes. STOPPED does not clear here either -- stop() clears
    // explicitly, and routing it through here as well would double-count.
    if (next == ReplayState.ERROR) {
      slot.clear()
    }
    state = next
    emit()
  }

  /** Loads a source and a garment. Legal from IDLE, READY, STOPPED, EOF. */
  fun load(newSource: ReplayFrameSource, manifest: KsgarmentManifest, texWidth: Int, texHeight: Int): Boolean =
    synchronized(lock) {
      if (state == ReplayState.DISPOSED) return false
      if (state == ReplayState.PLAYING || state == ReplayState.PAUSED) return false
      transition(ReplayState.LOADING)
      return try {
        require(newSource.frameCount > 0) { "replay source has no frames" }
        require(texWidth > 0 && texHeight > 0) { "invalid texture dimensions" }
        source = newSource
        garment = manifest
        textureWidth = texWidth
        textureHeight = texHeight
        cursor = 0
        lastError = null
        slot.clear()
        transition(ReplayState.READY)
        true
      } catch (t: Throwable) {
        lastError = t.message ?: t.toString()
        transition(ReplayState.ERROR)
        false
      }
    }

  /**
   * Swaps the active garment WITHOUT restarting replay (amendment D16).
   *
   * The swap takes effect at the next frame boundary -- production is
   * single-threaded through `advance()`, so a frame is either entirely the
   * old garment or entirely the new one. There is no window in which one
   * snapshot could carry A's geometry and B's texture. The stale snapshot is
   * dropped rather than left for the renderer to pick up under the new id.
   */
  fun selectGarment(manifest: KsgarmentManifest, texWidth: Int, texHeight: Int): Boolean = synchronized(lock) {
    if (state == ReplayState.DISPOSED || state == ReplayState.ERROR) return false
    if (texWidth <= 0 || texHeight <= 0) {
      lastError = "invalid texture dimensions for ${manifest.productId}"
      transition(ReplayState.ERROR)
      return false
    }
    garment = manifest
    textureWidth = texWidth
    textureHeight = texHeight
    slot.clear() // never let A's geometry be drawn while B is the active asset
    emit()
    return true
  }

  fun start(): Boolean = synchronized(lock) {
    if (state != ReplayState.READY && state != ReplayState.STOPPED && state != ReplayState.EOF) return false
    if (source == null || garment == null) return false
    if (state == ReplayState.EOF || state == ReplayState.STOPPED) cursor = 0
    transition(ReplayState.PLAYING)
    return true
  }

  fun pause(): Boolean = synchronized(lock) {
    if (state != ReplayState.PLAYING) return false
    transition(ReplayState.PAUSED)
    return true
  }

  fun resume(): Boolean = synchronized(lock) {
    if (state != ReplayState.PAUSED) return false
    transition(ReplayState.PLAYING)
    return true
  }

  fun stop(): Boolean = synchronized(lock) {
    if (state != ReplayState.PLAYING && state != ReplayState.PAUSED && state != ReplayState.EOF) return false
    cursor = 0
    slot.clear()
    transition(ReplayState.STOPPED)
    return true
  }

  /** Restart from EOF or STOPPED without reloading the source. */
  fun restart(): Boolean = synchronized(lock) {
    if (state != ReplayState.EOF && state != ReplayState.STOPPED && state != ReplayState.PAUSED) return false
    cursor = 0
    slot.clear()
    transition(ReplayState.PLAYING)
    return true
  }

  fun seek(index: Int): Boolean = synchronized(lock) {
    val total = source?.frameCount ?: return false
    if (state == ReplayState.DISPOSED || state == ReplayState.ERROR) return false
    if (index < 0 || index >= total) return false
    cursor = index
    slot.clear()
    return true
  }

  /**
   * Terminal. After this, production stops, the slot is emptied, and no
   * further event fires except this one (amendment D17). Idempotent.
   */
  fun dispose(): Boolean = synchronized(lock) {
    if (state == ReplayState.DISPOSED) return false
    cursor = 0
    source = null
    garment = null
    slot.clear()
    state = ReplayState.DISPOSED
    onEvent(ReplayEvent(ReplayState.DISPOSED, null, null, lastError))
    return true
  }

  /**
   * One unit of production work: take the next replay frame, compute its
   * geometry, publish it. Returns true if a frame was produced.
   *
   * Never blocks on the renderer. Never throws: a geometry refusal is
   * published as a refusal snapshot and counted, because a runtime that
   * throws on a bad frame cannot survive a bad perception provider.
   */
  fun advance(): Boolean {
    val activeSource: ReplayFrameSource
    val activeGarment: KsgarmentManifest
    val texW: Int
    val texH: Int
    val index: Int
    synchronized(lock) {
      if (state != ReplayState.PLAYING) return false
      activeSource = source ?: return false
      activeGarment = garment ?: return false
      texW = textureWidth
      texH = textureHeight
      if (cursor >= activeSource.frameCount) {
        transition(ReplayState.EOF)
        return false
      }
      index = cursor
      cursor = index + 1
    }

    val replayFrame = activeSource.frameAt(index)
    val snapshot = LiveVtoGeometryPipeline.compute(
      manifest = activeGarment,
      frame = replayFrame.frame,
      bodyFrameId = "${activeSource.id}#${replayFrame.index}",
      canvasWidth = canvasWidth,
      canvasHeight = canvasHeight,
      textureWidth = texW,
      textureHeight = texH,
    )
    if (snapshot.failure != null) refusedCount.incrementAndGet()

    // Publish only if this session still owns the frame: a dispose() or a
    // garment switch that landed while geometry was computing must not have
    // a stale snapshot appear after it.
    synchronized(lock) {
      if (state != ReplayState.PLAYING) return false
      if (garment !== activeGarment) return false
      slot.publish(snapshot)
      if (slot.depth > maxDepth) maxDepth = slot.depth
    }
    producedCount.incrementAndGet()

    synchronized(lock) {
      if (state == ReplayState.PLAYING && cursor >= activeSource.frameCount) {
        transition(ReplayState.EOF)
      }
    }
    return true
  }

  /** What the renderer calls. Consuming is what makes the next publish a non-drop. */
  fun consumeForRender(): GeometrySnapshot? = slot.consume()
}
