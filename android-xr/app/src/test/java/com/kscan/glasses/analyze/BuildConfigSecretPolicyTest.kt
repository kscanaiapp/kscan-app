package com.kscan.glasses.analyze

import com.kscan.glasses.BuildConfig
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression test that enforces a no-secrets policy in generated BuildConfig fields.
 *
 * BuildConfig values are compiled into the APK. Credentials, tokens, or secrets
 * must never be emitted into BuildConfig. This test should fail if a future
 * change reintroduces a secret-like build config field.
 */
class BuildConfigSecretPolicyTest {

    private val forbiddenNameParts = listOf(
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "API_KEY",
        "APIKEY",
        "BEARER",
        "PRIVATE_KEY",
        "CLIENT_SECRET",
    )

    @Test
    fun `BuildConfig must not expose secret-like fields`() {
        val forbiddenFields = BuildConfig::class.java.declaredFields
            .map { it.name.uppercase() }
            .filter { fieldName ->
                forbiddenNameParts.any { forbidden -> fieldName.contains(forbidden) }
            }

        assertTrue(
            "BuildConfig must not expose secret-like fields: $forbiddenFields",
            forbiddenFields.isEmpty(),
        )
    }

    @Test
    fun `BuildConfig does not declare KSCAN_DEBUG_ANALYZE_AUTH_TOKEN`() {
        val fieldNames = BuildConfig::class.java.declaredFields.map { it.name }
        assertTrue(
            "KSCAN_DEBUG_ANALYZE_AUTH_TOKEN must not exist in BuildConfig",
            "KSCAN_DEBUG_ANALYZE_AUTH_TOKEN" !in fieldNames,
        )
    }

    @Test
    fun `BuildConfig contains expected non-secret debug fields`() {
        val fieldNames = BuildConfig::class.java.declaredFields.map { it.name }
        // These are the only allowed BuildConfig fields for debug analyze configuration.
        assertTrue(
            "KSCAN_DEBUG_ANALYZE_ENABLED should exist in BuildConfig",
            "KSCAN_DEBUG_ANALYZE_ENABLED" in fieldNames,
        )
        assertTrue(
            "KSCAN_DEBUG_ANALYZE_URL should exist in BuildConfig",
            "KSCAN_DEBUG_ANALYZE_URL" in fieldNames,
        )
        assertTrue(
            "KSCAN_DEBUG_ANALYZE_DRY_RUN should exist in BuildConfig",
            "KSCAN_DEBUG_ANALYZE_DRY_RUN" in fieldNames,
        )
    }
}