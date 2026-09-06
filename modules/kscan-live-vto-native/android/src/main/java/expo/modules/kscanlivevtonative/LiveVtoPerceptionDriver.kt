package expo.modules.kscanlivevtonative

import android.graphics.Bitmap
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "KScanLiveVtoPerception"

/**
 * Owns BOTH clocks N1-E needs, on two threads independent of the UI thread
 * and independent of EACH OTHER (mission section 23):
 *
 *   FRAME PRODUCER  (fixed-cadence clock, like N1-D's replay clock)
 *          |
 *          v  submitFrame() -> LatestStateSlot<PerceptionInputFrame>
 *          |
 *   PERCEPTION LOOP  (runs as fast as REAL inference allows -- NOT a fixed
 *                      period; real MediaPipe inference latency is what
 *                      creates genuine backpressure here, not a simulated
 *                      delay)
 *          |
 *          v  publish() -> LatestStateSlot<GeometrySnapshot>
 *          |
 *   UI / View draw thread (consumes geometrySlot, unrelated to either clock)
 *
 * Neither thread is the UI thread. Canvas rasterization stays on the
 * View's own draw thread, per the same reasoning as N1-D's `LiveVtoReplayDriver`.
 */
class LiveVtoPerceptionDriver(
  private val session: LiveVtoPerceptionSession,
  private val frameSource: () -> PerceptionInputFrame,
  private val producerPeriodMillis: Long = DEFAULT_PRODUCER_PERIOD_MS,
) {
  private val running = AtomicBoolean(false)
  private var producerExecutor: ScheduledExecutorService? = null
  private var producerTask: ScheduledFuture<*>? = null
  private var perceptionExecutor: java.util.concurrent.ExecutorService? = null
  private val perceptionLoopRunning = AtomicBoolean(false)

  fun start() {
    if (!running.compareAndSet(false, true)) return

    val pExec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, PRODUCER_THREAD_NAME).apply { isDaemon = true } }
    producerExecutor = pExec
    producerTask = pExec.scheduleWithFixedDelay({
      try {
        session.submitFrame(frameSource())
      } catch (t: Throwable) {
        Log.e(TAG, "frame producer tick failed", t)
      }
    }, 0L, producerPeriodMillis, TimeUnit.MILLISECONDS)

    val infExec = Executors.newSingleThreadExecutor { r -> Thread(r, PERCEPTION_THREAD_NAME).apply { isDaemon = true } }
    perceptionExecutor = infExec
    perceptionLoopRunning.set(true)
    infExec.execute {
      // A tight loop, not a fixed-period schedule: real inference latency
      // IS the pacing. When there is nothing new to process, back off
      // briefly rather than busy-spinning.
      while (perceptionLoopRunning.get()) {
        try {
          val didWork = session.runOneInferenceStep()
          if (!didWork) Thread.sleep(5)
        } catch (t: Throwable) {
          Log.e(TAG, "perception step failed", t)
        }
      }
    }
  }

  fun stop() {
    if (!running.compareAndSet(true, false)) return
    producerTask?.cancel(false)
    producerTask = null
    producerExecutor?.let { exec ->
      exec.shutdown()
      if (!exec.awaitTermination(2, TimeUnit.SECONDS)) exec.shutdownNow()
    }
    producerExecutor = null

    perceptionLoopRunning.set(false)
    perceptionExecutor?.let { exec ->
      exec.shutdown()
      if (!exec.awaitTermination(3, TimeUnit.SECONDS)) exec.shutdownNow()
    }
    perceptionExecutor = null
  }

  val isRunning: Boolean get() = running.get()

  companion object {
    const val PRODUCER_THREAD_NAME = "kscan-live-vto-perception-producer"
    const val PERCEPTION_THREAD_NAME = "kscan-live-vto-perception-infer"

    /** Same nominal cadence as N1-D's replay clock; not tuned to any device. */
    const val DEFAULT_PRODUCER_PERIOD_MS = 33L
  }
}

/** Repeats one bundled synthetic bitmap. See docs for provenance -- procedurally generated, zero person imagery. */
class StaticBitmapFrameSource(private val bitmap: Bitmap) : () -> PerceptionInputFrame {
  override fun invoke(): PerceptionInputFrame = BitmapPerceptionInputFrame(bitmap)
}
