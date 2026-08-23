package com.kscan.glasses.privacy

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivacyImageSanitizerFactoryTest {

    @Test
    fun `debug mock profile injects mock sanitizer`() {
        val sanitizer = PrivacyImageSanitizerFactory.create(
            mode = SanitizerMode.MOCK,
            isDebugBuild = true,
        )
        assertTrue(sanitizer is MockPrivacyImageSanitizer)
    }

    @Test
    fun `debug strict profile injects strict sanitizer`() {
        val sanitizer = PrivacyImageSanitizerFactory.create(
            mode = SanitizerMode.PRODUCTION,
            isDebugBuild = true,
        )
        assertTrue(sanitizer is StrictPrivacyImageSanitizer)
    }

    @Test
    fun `release profile injects strict sanitizer only`() {
        val sanitizer = PrivacyImageSanitizerFactory.create(
            mode = SanitizerMode.PRODUCTION,
            isDebugBuild = false,
        )
        assertTrue(sanitizer is StrictPrivacyImageSanitizer)
        assertFalse(sanitizer is MockPrivacyImageSanitizer)
    }

    @Test(expected = IllegalStateException::class)
    fun `release cannot inject mock sanitizer`() {
        PrivacyImageSanitizerFactory.create(
            mode = SanitizerMode.MOCK,
            isDebugBuild = false,
        )
    }

    @Test
    fun `strict sanitizer reports masking available in this build`() {
        // FaceMasker is now implemented with ML Kit; the strict sanitizer
        // must expose that runtime state and UI can proceed with privacy.
        val sanitizer = StrictPrivacyImageSanitizer()
        assertTrue(sanitizer.isMaskingAvailable)
    }
}
