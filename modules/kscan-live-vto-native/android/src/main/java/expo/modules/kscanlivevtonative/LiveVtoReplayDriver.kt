package expo.modules.kscanlivevtonative

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns the replay CLOCK -- the one thing `LiveVtoReplaySession` deliberately
 * does not own, so the session stays a pure, JVM-testable state machine.
 *
 * ── Thread topology (amendment D18) ───────────────────────────────────────
 *
 *   kscan-live-vto-replay   (this class, one daemon thread)
 *       frame acquisition from the replay source
 *       BodyFrame production
 *       deformation / geometry compute (LiveVtoGeometryPipeline)
 *       publish into LatestStateSlot
 *
 *   Android UI / View draw thread
 *       LiveVtoTestRenderView.onDraw -> slot.peek() -> Canvas.drawBitmapMesh
 *
 *   Bridge / event dispatch
 *       ReplayEvent callbacks, on the replay thread; the module marshals
 *       them onward. State transitions only -- never per frame.
 *
 * NOTHING in the first group runs on the UI thread. Canvas rasterization
 * runs on the View's own draw thread, which is correct and required for the
 * Android View rendering model (amendment D10) -- what must stay off it is
 * production and deformation, and both live here.
 *
 * The scheduler uses `scheduleWithFixedDelay`, not `scheduleAtFixedRate`:
 * a slow tick must not cause the executor to fire a burst of catch-up ticks,
 * which would be a queue by another name.
 */
class LiveVtoReplayDriver(
  private val session: LiveVtoReplaySession,
  private val framePeriodMillis: Long = DEFAULT_FRAME_PERIOD_MS,
) {
  private val running = AtomicBoolean(false)
  private var executor: ScheduledExecutorService? = null
  private var task: ScheduledFuture<*>? = null

  /** Starts the clock. Idempotent -- a second call while running is a no-op. */
  fun start() {
    if (!running.compareAndSet(false, true)) return
    val exec = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, THREAD_NAME).apply { isDaemon = true }
    }
    executor = exec
    task = exec.scheduleWithFixedDelay({
      try {
        session.advance()
      } catch (t: Throwable) {
        // A production tick must never kill the executor thread: a
        // ScheduledExecutorService silently cancels a repeating task whose
        // body throws, which would look exactly like a clean stop while the
        // session still reported PLAYING.
        android.util.Log.e(THREAD_NAME, "replay tick failed", t)
      }
    }, 0L, framePeriodMillis, TimeUnit.MILLISECONDS)
  }

  /**
   * Stops the clock and waits for the in-flight tick to finish, so no
   * production can land after a caller believes the driver has stopped.
   */
  fun stop() {
    if (!running.compareAndSet(true, false)) return
    task?.cancel(false)
    task = null
    val exec = executor ?: return
    executor = null
    exec.shutdown()
    if (!exec.awaitTermination(2, TimeUnit.SECONDS)) exec.shutdownNow()
  }

  val isRunning: Boolean get() = running.get()

  companion object {
    const val THREAD_NAME = "kscan-live-vto-replay"

    /**
     * ~30 production ticks per second. Deliberately NOT tuned to any device
     * or emulator: N1-D exists to prove the architecture drops rather than
     * queues, and real cadence is re-measured against real perception and
     * camera workloads at N1-E/F (amendment D15).
     */
    const val DEFAULT_FRAME_PERIOD_MS = 33L
  }
}
