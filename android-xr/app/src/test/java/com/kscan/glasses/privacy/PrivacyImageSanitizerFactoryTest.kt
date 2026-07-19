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
    fun `strict sanitizer reports masking unavailable in this build`() {
        // FaceMasker is NotImplemented; the strict sanitizer must expose that
        // so runtime state and UI never imply privacy readiness.
        val sanitizer = StrictPrivacyImageSanitizer()
        assertFalse(sanitizer.isMaskingAvailable)
    }
}
