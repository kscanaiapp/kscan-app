package com.kscan.glasses.analyze

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DebugAnalyzeCredentialProviderTest {

    @Test
    fun `read returns empty when no token files exist`() {
        val context = RuntimeEnvironment.getApplication()
        File(context.filesDir, DebugAnalyzeCredentialProvider.APP_TOKEN_FILE_NAME).delete()
        assertEquals("", DebugAnalyzeCredentialProvider.read(context))
    }

    @Test
    fun `read prefers app-private token file`() {
        val context = RuntimeEnvironment.getApplication()
        val file = File(context.filesDir, DebugAnalyzeCredentialProvider.APP_TOKEN_FILE_NAME)
        file.writeText("  app-token-value  ")
        try {
            assertEquals("app-token-value", DebugAnalyzeCredentialProvider.read(context))
        } finally {
            file.delete()
        }
    }

    @Test
    fun `mergeInto copies non-blank runtime token`() {
        val base = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "",
        )
        val merged = DebugAnalyzeCredentialProvider.mergeInto(base, " runtime-token ")
        assertEquals("runtime-token", merged.authToken)
        assertTrue(merged.isPresent)
    }

    @Test
    fun `mergeInto leaves blank token unchanged`() {
        val base = DebugAnalyzeConfig(authToken = "")
        val merged = DebugAnalyzeCredentialProvider.mergeInto(base, "   ")
        assertEquals("", merged.authToken)
    }
}
