package expo.modules.kscanpiinative

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint

sealed class RedactionResult {
    data class Success(
        val output: Bitmap,
        val regionsChanged: Int,
        val regionsAlreadyRedacted: Int,
        val pixelsChanged: Boolean,
        val durationMs: Long,
    ) : RedactionResult()

    data class Failure(
        val errorCode: NativePrivacyErrorCode,
        val reason: String,
    ) : RedactionResult()
}

object AndroidFaceRedactor {
    fun redactRegions(
        input: Bitmap,
        regions: List<NormalizedFaceBox>,
    ): RedactionResult {
        val startedAt = System.currentTimeMillis()

        val output = try {
            input.copy(Bitmap.Config.ARGB_8888, true)
        } catch (e: OutOfMemoryError) {
            return RedactionResult.Failure(
                NativePrivacyErrorCode.MASKING_FAILED,
                "Out of memory while creating mutable bitmap copy: ${e.message}",
            )
        } catch (e: Exception) {
            return RedactionResult.Failure(
                NativePrivacyErrorCode.MASKING_FAILED,
                "Failed to create mutable bitmap copy: ${e.message}",
            )
        }

        val canvas = Canvas(output)
        val paint = Paint().apply {
            color = Color.argb(
                NativePrivacyConstants.REDACTION_COLOR_A,
                NativePrivacyConstants.REDACTION_COLOR_R,
                NativePrivacyConstants.REDACTION_COLOR_G,
                NativePrivacyConstants.REDACTION_COLOR_B,
            )
            style = Paint.Style.FILL
        }

        var regionsChanged = 0
        var regionsAlreadyRedacted = 0
        val inputPixels = IntArray(input.width * input.height)
        val outputPixels = IntArray(output.width * output.height)

        input.getPixels(inputPixels, 0, input.width, 0, 0, input.width, input.height)

        for (region in regions) {
            val isAlreadyBlack = isRegionAlreadyBlack(inputPixels, input.width, input.height, region)
            canvas.drawRect(
                region.x.toFloat(),
                region.y.toFloat(),
                (region.x + region.width).toFloat(),
                (region.y + region.height).toFloat(),
                paint,
            )
            if (isAlreadyBlack) {
                regionsAlreadyRedacted += 1
            } else {
                regionsChanged += 1
            }
        }

        output.getPixels(outputPixels, 0, output.width, 0, 0, output.width, output.height)
        val pixelsChanged = !inputPixels.contentEquals(outputPixels)

        // An accepted region that was already fully opaque black is a valid
        // masked state -- it must not fail just because its own bytes did
        // not change. Only regions that actually needed a change
        // (regionsChanged) are required to have produced a byte difference.
        if (regionsChanged > 0 && !pixelsChanged) {
            output.recycle()
            return RedactionResult.Failure(
                NativePrivacyErrorCode.MASKING_FAILED,
                "Masking invariant violated: $regionsChanged regions needed changes but no pixels changed.",
            )
        }

        return RedactionResult.Success(
            output = output,
            regionsChanged = regionsChanged,
            regionsAlreadyRedacted = regionsAlreadyRedacted,
            pixelsChanged = pixelsChanged,
            durationMs = System.currentTimeMillis() - startedAt,
        )
    }

    private fun isRegionAlreadyBlack(
        pixels: IntArray,
        width: Int,
        height: Int,
        region: NormalizedFaceBox,
    ): Boolean {
        val x1 = region.x.coerceIn(0, width)
        val y1 = region.y.coerceIn(0, height)
        val x2 = (region.x + region.width).coerceIn(0, width)
        val y2 = (region.y + region.height).coerceIn(0, height)

        if (x2 <= x1 || y2 <= y1) return false

        val opaqueBlack = Color.argb(255, 0, 0, 0)
        for (y in y1 until y2) {
            for (x in x1 until x2) {
                if (pixels[y * width + x] != opaqueBlack) {
                    return false
                }
            }
        }
        return true
    }
}
