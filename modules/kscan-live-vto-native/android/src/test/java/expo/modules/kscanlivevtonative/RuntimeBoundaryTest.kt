package expo.modules.kscanlivevtonative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Structural guards for the two boundaries this runtime's guarantees rest
 * on. Both are properties of the SOURCE, so they are checked against the
 * source rather than inferred from behaviour -- a behavioural test would
 * pass right up until the moment someone added the import that breaks the
 * guarantee.
 */
class RuntimeBoundaryTest {

  private fun mainSources(): List<File> =
    File(GoldenBodyFrames.moduleRoot(), "android/src/main/java/expo/modules/kscanlivevtonative")
      .listFiles { f -> f.isFile && f.name.endsWith(".kt") }!!
      .sortedBy { it.name }

  /**
   * The geometry and replay stack must have ZERO Android dependencies.
   *
   * This is what makes the conformance goldens runnable off-device, and it
   * is what makes it structurally impossible for deformation compute to
   * touch a Canvas, a View, or the UI thread (amendment D10). Only the view
   * and the Expo module -- the two files whose job IS the Android boundary
   * -- may import android.* or expo.*.
   */
  @Test
  fun theGeometryAndReplayStackHasNoAndroidDependencies() {
    val androidBoundaryFiles = setOf(
      "LiveVtoTestRenderView.kt",   // owns Canvas / Bitmap / ExpoView
      "KScanLiveVtoNativeModule.kt", // owns the Expo module definition
      "LiveVtoReplayDriver.kt",      // owns the executor; logs via android.util.Log
    )
    val offenders = mutableListOf<String>()
    for (file in mainSources()) {
      if (file.name in androidBoundaryFiles) continue
      for ((i, line) in file.readLines().withIndex()) {
        val trimmed = line.trim()
        if (trimmed.startsWith("import android.") || trimmed.startsWith("import expo.")) {
          offenders.add(file.name + ":" + (i + 1) + " " + trimmed)
        }
        // A fully-qualified reference bypasses the import check entirely.
        if (Regex("(^|[^\\w.])android\\.[a-z]").containsMatchIn(line) && !trimmed.startsWith("*") && !trimmed.startsWith("//")) {
          offenders.add(file.name + ":" + (i + 1) + " (qualified) " + trimmed)
        }
      }
    }
    assertEquals(
      "these files must stay free of Android types so geometry runs off-device:\n" + offenders.joinToString("\n"),
      emptyList<String>(),
      offenders,
    )
  }

  /**
   * Amendment D25 / mission section 25: the replay and render pipeline
   * performs no network or file I/O of its own. It reads committed APK
   * assets and computes. Nothing it produces leaves the device.
   */
  @Test
  fun theNativeRuntimeHasNoNetworkSurface() {
    val forbidden = listOf(
      "okhttp", "retrofit", "HttpURLConnection", "URLConnection", "java.net.",
      "Socket(", "WebSocket", "MediaRecorder", "ContentResolver",
    )
    val offenders = mutableListOf<String>()
    for (file in mainSources()) {
      for ((i, line) in file.readLines().withIndex()) {
        val trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue
        for (token in forbidden) {
          if (line.contains(token)) offenders.add(file.name + ":" + (i + 1) + " " + token + " -> " + trimmed)
        }
      }
    }
    assertEquals(
      "the native Live VTO runtime must have no network surface:\n" + offenders.joinToString("\n"),
      emptyList<String>(),
      offenders,
    )
  }

  /**
   * The bridge must expose only bounded commands and bounded reads. A new
   * `Function`/`AsyncFunction`/`Prop` on the module is a new hole in the
   * privacy boundary until it is reviewed, so the surface is pinned.
   */
  @Test
  fun theBridgeSurfaceIsPinned() {
    val module = File(
      GoldenBodyFrames.moduleRoot(),
      "android/src/main/java/expo/modules/kscanlivevtonative/KScanLiveVtoNativeModule.kt",
    ).readText()

    val declared = Regex("""(?:Async)?Function\("([^"]+)"\)|Prop\("([^"]+)"\)""")
      .findAll(module)
      .map { it.groupValues[1].ifEmpty { it.groupValues[2] } }
      .toSortedSet()

    assertEquals(
      "the native bridge surface changed -- review the privacy boundary before updating this list",
      sortedSetOf("active", "getCapability", "getGeometrySnapshotJson", "getReplayStatsJson", "replay"),
      declared,
    )

    // No member may be named in a way that suggests it carries frame data.
    for (name in declared) {
      val lowered = name.lowercase()
      for (banned in listOf("frame", "bitmap", "image", "pixel", "mask", "landmark", "mesh", "texture", "buffer")) {
        assertTrue(
          "bridge member '" + name + "' suggests it carries frame data",
          !lowered.contains(banned),
        )
      }
    }
  }
}
