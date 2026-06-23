package com.kscan.glasses.analyze

import com.kscan.glasses.config.BetaConfig
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassesDebugEndpointClientFactoryTest {

    @Test
    fun `returns mock when enableRealAnalyze is false`() {
        val beta = BetaConfig(
            enableRealAnalyze = false,
            enableRealFaceMasking = true,
        )
        val debug = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "token",
        )
        val client = GlassesDebugEndpointClientFactory.create(beta, debug)
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `returns mock when enableRealFaceMasking is false`() {
        val beta = BetaConfig(
            enableRealAnalyze = true,
            enableRealFaceMasking = false,
        )
        val debug = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "token",
        )
        val client = GlassesDebugEndpointClientFactory.create(beta, debug)
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `returns mock when debug config enabled is false`() {
        val beta = BetaConfig(
            enableRealAnalyze = true,
            enableRealFaceMasking = true,
        )
        val debug = DebugAnalyzeConfig(
            enabled = false,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "token",
        )
        val client = GlassesDebugEndpointClientFactory.create(beta, debug)
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `returns mock when backendUrl is blank`() {
        val beta = BetaConfig(
            enableRealAnalyze = true,
            enableRealFaceMasking = true,
        )
        val debug = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "",
            authToken = "token",
        )
        val client = GlassesDebugEndpointClientFactory.create(beta, debug)
        assertTrue(client is MockAnalyzeClient)
    }

    @Test
    fun `returns GlassesDebugEndpointClient when all gates pass`() {
        val beta = BetaConfig(
            enableRealAnalyze = true,
            enableRealFaceMasking = true,
        )
        val debug = DebugAnalyzeConfig(
            enabled = true,
            backendUrl = "http://10.0.2.2:3002/api/glasses/analyze-debug",
            authToken = "token",
        )
        val client = GlassesDebugEndpointClientFactory.create(beta, debug)
        assertTrue(client is GlassesDebugEndpointClient)
    }

    @Test
    fun `returns mock when all configs are default`() {
        val beta = BetaConfig.DEFAULT
        val debug = DebugAnalyzeConfig.DEFAULT
        val client = GlassesDebugEndpointClientFactory.create(beta, debug)
        assertTrue(client is MockAnalyzeClient)
    }
}
