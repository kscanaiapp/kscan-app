package expo.modules.kscanpiinative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import java.io.File

sealed class VerificationResult {
    data class Success(
        val outputWidth: Int,
        val outputHeight: Int,
        val outputChecksum: String,
        val durationMs: Long,
    ) : VerificationResult()

    data class Failure(
        val errorCode: NativePrivacyErrorCode,
        val reason: String,
    ) : VerificationResult()
}

object AndroidOutputVerifier {
    fun verify(
        outputFile: File,
        expectedWidth: Int,
        expectedHeight: Int,
        regions: List<NormalizedFaceBox>,
    ): VerificationResult {
        val startedAt = System.currentTimeMillis()

        if (!outputFile.exists() || outputFile.length() == 0L) {
            return VerificationResult.Failure(
                NativePrivacyErrorCode.VERIFICATION_FAILED,
                "Output file is missing or empty: ${outputFile.absolutePath}",
            )
        }

        val bitmap = BitmapFactory.decodeFile(outputFile.absolutePath)
            ?: return VerificationResult.Failure(
                NativePrivacyErrorCode.VERIFICATION_FAILED,
                "Failed to re-decode persisted output.",
            )

        if (bitmap.width != expectedWidth || bitmap.height != expectedHeight) {
            bitmap.recycle()
            return VerificationResult.Failure(
                NativePrivacyErrorCode.VERIFICATION_FAILED,
                "Output dimensions ${bitmap.width}x${bitmap.height} do not match expected ${expectedWidth}x$expectedHeight.",
            )
        }

        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        bitmap.recycle()

        val opaqueBlack = Color.argb(255, 0, 0, 0)
        for (region in regions) {
            val x1 = region.x.coerceIn(0, bitmap.width)
            val y1 = region.y.coerceIn(0, bitmap.height)
            val x2 = (region.x + region.width).coerceIn(0, bitmap.width)
            val y2 = (region.y + region.height).coerceIn(0, bitmap.height)

            if (x2 <= x1 || y2 <= y1) continue

            for (y in y1 until y2) {
                for (x in x1 until x2) {
                    if (pixels[y * bitmap.width + x] != opaqueBlack) {
                        return VerificationResult.Failure(
                            NativePrivacyErrorCode.VERIFICATION_FAILED,
                            "Redacted region at ($x1,$y1,${x2 - x1},${y2 - y1}) is not opaque black.",
                        )
                    }
                }
            }
        }

        val argbBytes = intArrayToRgbaBytes(pixels)
        val checksum = checksumBuffer(argbBytes)

        return VerificationResult.Success(
            outputWidth = bitmap.width,
            outputHeight = bitmap.height,
            outputChecksum = checksum,
            durationMs = System.currentTimeMillis() - startedAt,
        )
    }

    private fun intArrayToRgbaBytes(pixels: IntArray): ByteArray {
        val bytes = ByteArray(pixels.size * 4)
        for (i in pixels.indices) {
            val pixel = pixels[i]
            bytes[i * 4] = Color.red(pixel).toByte()
            bytes[i * 4 + 1] = Color.green(pixel).toByte()
            bytes[i * 4 + 2] = Color.blue(pixel).toByte()
            bytes[i * 4 + 3] = Color.alpha(pixel).toByte()
        }
        return bytes
    }

    /**
     * Deterministic, dependency-free 64-bit FNV-1a dual-lane checksum.
     *
     * Mirrors the audited TypeScript implementation in
     * services/privacy/onDeviceMasking/rgbaMasking.ts.
     */
    fun checksumBuffer(bytes: ByteArray): String {
        var h1 = 0x811c9dc5.toInt()
        var h2 = 0x9e3779b9.toInt()

        for (byte in bytes) {
            val unsigned = byte.toInt() and 0xFF
            h1 = h1 xor unsigned
            h1 = (h1 * 0x01000193) // FNV-1a prime
            h2 = (h2 xor unsigned) + ((h2 shl 6) + (h2 ushr 2))
            h2 = h2 // unsigned 32-bit handled by Int overflow
        }

        val hex1 = (h1.toLong() and 0xffffffffL).toString(16).padStart(8, '0')
        val hex2 = (h2.toLong() and 0xffffffffL).toString(16).padStart(8, '0')
        val lengthHex = (bytes.size.toLong() and 0xffffffffL).toString(16).padStart(8, '0')
        return "$hex1$hex2$lengthHex"
    }
}
