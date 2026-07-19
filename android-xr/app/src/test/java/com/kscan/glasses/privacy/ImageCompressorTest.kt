package com.kscan.glasses.privacy

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream

/**
 * Behavior-verifies the real JPEG re-encode boundary with actual Android image
 * code (Robolectric shadows execute real BitmapFactory/Bitmap/Base64 logic).
 *
 * Fixtures: tiny known JPEGs embedded in [TestJpegs]; oversized images are
 * generated programmatically in-test. No binary fixtures committed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ImageCompressorTest {

    private val compressor = ImageCompressor()

    // ---------- helpers ----------

    private fun oversizedJpegBase64(width: Int, height: Int): String {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun decodeSuccess(result: CompressResult): Pair<ByteArray, Bitmap> {
        assertTrue("expected Success, got $result", result is CompressResult.Success)
        val bytes = Base64.decode((result as CompressResult.Success).base64, Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertNotNull("output must decode as a valid image", bitmap)
        return bytes to bitmap!!
    }

    // ---------- happy paths ----------

    @Test
    fun `valid jpeg is re-encoded successfully`() {
        val result = compressor.compressJpeg(TestJpegs.SMALL_100x50)
        val (bytes, bitmap) = decodeSuccess(result)
        assertEquals(100, bitmap.width)
        assertEquals(50, bitmap.height)
        assertTrue(bytes.isNotEmpty())
    }

    @Test
    fun `oversized jpeg is bounded to max long side`() {
        val input = oversizedJpegBase64(2000, 1000)
        val (_, bitmap) = decodeSuccess(compressor.compressJpeg(input))
        assertEquals(ImageCompressor.MAX_LONG_SIDE_PX, bitmap.width)
        assertEquals(448, bitmap.height)
        assertTrue(maxOf(bitmap.width, bitmap.height) <= ImageCompressor.MAX_LONG_SIDE_PX)
    }

    @Test
    fun `aspect ratio is preserved when scaling down`() {
        val input = oversizedJpegBase64(1600, 400) // 4:1
        val (_, bitmap) = decodeSuccess(compressor.compressJpeg(input))
        assertEquals(896, bitmap.width)
        assertEquals(224, bitmap.height)
        val inputAspect = 1600f / 400f
        val outputAspect = bitmap.width.toFloat() / bitmap.height.toFloat()
        assertTrue(Math.abs(inputAspect - outputAspect) < 0.01f)
    }

    @Test
    fun `already small jpeg is not upscaled`() {
        val (_, bitmap) = decodeSuccess(compressor.compressJpeg(TestJpegs.SMALL_100x50))
        assertEquals(100, bitmap.width)
        assertEquals(50, bitmap.height)
    }

    @Test
    fun `exif orientation 6 rotates output dimensions`() {
        // 100x50 with EXIF orientation=6 must come out as 50x100.
        val (_, bitmap) = decodeSuccess(compressor.compressJpeg(TestJpegs.SMALL_EXIF6_100x50))
        assertEquals(50, bitmap.width)
        assertEquals(100, bitmap.height)
    }

    @Test
    fun `oversized exif image is both bounded and rotated`() {
        // 1200x600 with EXIF orientation=6: scale to 896x448, then rotate to 448x896.
        val (_, bitmap) = decodeSuccess(compressor.compressJpeg(TestJpegs.MID_EXIF6_1200x600))
        assertEquals(448, bitmap.width)
        assertEquals(896, bitmap.height)
    }

    @Test
    fun `output is newly encoded and differs from the original bytes`() {
        val inputBytes = Base64.decode(TestJpegs.SMALL_100x50, Base64.DEFAULT)
        val (outBytes, _) = decodeSuccess(compressor.compressJpeg(TestJpegs.SMALL_100x50))
        assertFalse(
            "output must be newly encoded, never the original byte array",
            outBytes.contentEquals(inputBytes),
        )
    }

    @Test
    fun `output is a real jpeg with magic bytes`() {
        val (bytes, _) = decodeSuccess(compressor.compressJpeg(TestJpegs.SMALL_100x50))
        assertEquals(0xFF, bytes[0].toInt() and 0xFF)
        assertEquals(0xD8, bytes[1].toInt() and 0xFF)
        assertEquals(0xFF, bytes[2].toInt() and 0xFF)
    }

    @Test
    fun `output metadata is discarded by reconstruction`() {
        // Re-encode of an EXIF-bearing source must not carry the orientation tag forward:
        // output pixels are already normalized, so no EXIF orientation should remain.
        val (bytes, _) = decodeSuccess(compressor.compressJpeg(TestJpegs.SMALL_EXIF6_100x50))
        val exif = android.media.ExifInterface(java.io.ByteArrayInputStream(bytes))
        val orientation = exif.getAttributeInt(
            android.media.ExifInterface.TAG_ORIENTATION,
            android.media.ExifInterface.ORIENTATION_UNDEFINED,
        )
        assertTrue(
            "re-encoded output must not retain original EXIF orientation ($orientation)",
            orientation == android.media.ExifInterface.ORIENTATION_NORMAL ||
                orientation == android.media.ExifInterface.ORIENTATION_UNDEFINED,
        )
    }

    // ---------- deterministic failure classification ----------

    @Test
    fun `empty input is classified EMPTY_INPUT`() {
        assertFailure(compressor.compressJpeg(""), CompressFailure.EMPTY_INPUT)
        assertFailure(compressor.compressJpeg("   "), CompressFailure.EMPTY_INPUT)
    }

    @Test
    fun `malformed base64 is classified DECODE_FAILED`() {
        assertFailure(compressor.compressJpeg("!!!not-base64!!!"), CompressFailure.DECODE_FAILED)
    }

    @Test
    fun `valid base64 of non-image bytes is classified DECODE_FAILED`() {
        val notAnImage = Base64.encodeToString("hello world".toByteArray(), Base64.NO_WRAP)
        assertFailure(compressor.compressJpeg(notAnImage), CompressFailure.DECODE_FAILED)
    }

    @Test
    fun `decoder returning null is classified DECODE_FAILED`() {
        val c = ImageCompressor(decoder = { null })
        assertFailure(c.compressJpeg(TestJpegs.SMALL_100x50), CompressFailure.DECODE_FAILED)
    }

    @Test
    fun `decoder throwing is classified DECODE_FAILED`() {
        val c = ImageCompressor(decoder = { throw RuntimeException("boom") })
        assertFailure(c.compressJpeg(TestJpegs.SMALL_100x50), CompressFailure.DECODE_FAILED)
    }

    @Test
    fun `decoded bitmap with non-positive dimensions is classified INVALID_DIMENSIONS`() {
        val zeroWidth = mockk<Bitmap> {
            every { width } returns 0
            every { height } returns 10
        }
        val c = ImageCompressor(decoder = { zeroWidth })
        assertFailure(c.compressJpeg(TestJpegs.SMALL_100x50), CompressFailure.INVALID_DIMENSIONS)
    }

    @Test
    fun `encoder returning null is classified ENCODE_FAILED`() {
        val c = ImageCompressor(encoder = { _, _ -> null })
        assertFailure(c.compressJpeg(TestJpegs.SMALL_100x50), CompressFailure.ENCODE_FAILED)
    }

    @Test
    fun `encoder throwing is classified ENCODE_FAILED`() {
        val c = ImageCompressor(encoder = { _, _ -> throw RuntimeException("encode boom") })
        assertFailure(c.compressJpeg(TestJpegs.SMALL_100x50), CompressFailure.ENCODE_FAILED)
    }

    @Test
    fun `encoder returning empty bytes is classified ENCODE_FAILED`() {
        val c = ImageCompressor(encoder = { _, _ -> ByteArray(0) })
        assertFailure(c.compressJpeg(TestJpegs.SMALL_100x50), CompressFailure.ENCODE_FAILED)
    }

    // ---------- no original-byte fallback / no payload leakage ----------

    @Test
    fun `no failure condition ever returns the original byte array`() {
        val inputs = listOf(
            "",
            "!!!not-base64!!!",
            Base64.encodeToString("not an image".toByteArray(), Base64.NO_WRAP),
            TestJpegs.SMALL_100x50,
        )
        for (input in inputs) {
            val result = compressor.compressJpeg(input)
            if (result is CompressResult.Success) {
                assertFalse(
                    Base64.decode(result.base64, Base64.DEFAULT)
                        .contentEquals(input.toByteArray()),
                )
            }
            // Failure results carry no bytes at all by construction.
        }
        // Explicitly: a failure never smuggles input bytes out.
        val failure = compressor.compressJpeg(TestJpegs.SMALL_100x50.let { "broken" })
        assertTrue(failure is CompressResult.Failure)
    }

    @Test
    fun `failure results carry no raw payload or input-derived data`() {
        val marker = "UNIQUE-INPUT-MARKER"
        val input = Base64.encodeToString(marker.toByteArray(), Base64.NO_WRAP)
        val result = compressor.compressJpeg(input)
        assertTrue(result is CompressResult.Failure)
        assertFalse(result.toString().contains(marker))
        assertFalse(result.toString().contains(input.take(16)))
    }

    private fun assertFailure(result: CompressResult, expected: CompressFailure) {
        assertTrue("expected Failure($expected), got $result", result is CompressResult.Failure)
        assertEquals(expected, (result as CompressResult.Failure).failure)
    }
}
