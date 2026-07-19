package com.kscan.glasses.privacy

import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies the strict sanitizer's wiring of the real re-encode boundary:
 * mask stage output -> compressor -> Success/Error mapping. No raw fallback.
 */
class StrictPrivacyImageSanitizerTest {

    private fun maskerReturning(result: MaskResult): FaceMasker = mockk {
        every { maskFaces(any(), any()) } returns result
    }

    @Test
    fun `masked image is re-encoded and only new bytes are returned`() = runTest {
        val compressor = mockk<ImageCompressor> {
            every { compressJpeg(any(), any()) } returns CompressResult.Success("NEW-ENCODED", "image/jpeg")
        }
        val sanitizer = StrictPrivacyImageSanitizer(
            faceMasker = maskerReturning(MaskResult.Success("MASKED", "image/jpeg")),
            compressor = compressor,
        )

        val result = sanitizer.sanitize("raw-input", "image/jpeg")

        assertTrue(result is SanitizeResult.Success)
        assertEquals("NEW-ENCODED", (result as SanitizeResult.Success).sanitizedBase64)
        assertEquals("image/jpeg", result.mimeType)
        // The compressor received the masked payload, not the raw input.
        verify(exactly = 1) { compressor.compressJpeg("MASKED", any()) }
    }

    @Test
    fun `no-faces image still passes through the re-encode boundary`() = runTest {
        val compressor = mockk<ImageCompressor> {
            every { compressJpeg(any(), any()) } returns CompressResult.Success("NEW-ENCODED", "image/jpeg")
        }
        val sanitizer = StrictPrivacyImageSanitizer(
            faceMasker = maskerReturning(MaskResult.NoFaces("UNMASKED", "image/jpeg")),
            compressor = compressor,
        )

        val result = sanitizer.sanitize("raw-input", "image/jpeg")

        assertTrue(result is SanitizeResult.Success)
        verify(exactly = 1) { compressor.compressJpeg("UNMASKED", any()) }
    }

    @Test
    fun `compressor failure becomes sanitizer error never raw passthrough`() = runTest {
        val compressor = mockk<ImageCompressor> {
            every { compressJpeg(any(), any()) } returns CompressResult.Failure(CompressFailure.ENCODE_FAILED)
        }
        val sanitizer = StrictPrivacyImageSanitizer(
            faceMasker = maskerReturning(MaskResult.NoFaces("UNMASKED", "image/jpeg")),
            compressor = compressor,
        )

        val result = sanitizer.sanitize("raw-input", "image/jpeg")

        assertTrue(result is SanitizeResult.Error)
        val message = (result as SanitizeResult.Error).message
        // Deterministic classification surfaces; payload never does.
        assertTrue(message.contains("ENCODE_FAILED"))
        assertFalse(message.contains("UNMASKED"))
        assertFalse(message.contains("raw-input"))
    }

    @Test
    fun `blank input is blocked before mask or encode stages`() = runTest {
        val compressor = mockk<ImageCompressor>()
        val sanitizer = StrictPrivacyImageSanitizer(
            faceMasker = maskerReturning(MaskResult.NoFaces("x", "image/jpeg")),
            compressor = compressor,
        )

        val result = sanitizer.sanitize("", "image/jpeg")

        assertTrue(result is SanitizeResult.Blocked)
        verify(exactly = 0) { compressor.compressJpeg(any(), any()) }
    }

    @Test
    fun `masker error stays blocked and never reaches the encoder`() = runTest {
        val compressor = mockk<ImageCompressor>()
        val sanitizer = StrictPrivacyImageSanitizer(
            faceMasker = maskerReturning(MaskResult.Error("detector crashed")),
            compressor = compressor,
        )

        val result = sanitizer.sanitize("raw-input", "image/jpeg")

        assertTrue(result is SanitizeResult.Blocked)
        verify(exactly = 0) { compressor.compressJpeg(any(), any()) }
    }
}
