package com.kscan.glasses.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCommandParserTest {

    @Test
    fun `K Scan returns WAKE`() {
        assertEquals(VoiceCommandType.WAKE, VoiceCommandParser.parse("K Scan"))
    }

    @Test
    fun `K Scan scan this returns SCAN`() {
        assertEquals(VoiceCommandType.SCAN, VoiceCommandParser.parse("K Scan scan this"))
    }

    @Test
    fun `K Scan save this returns SAVE`() {
        assertEquals(VoiceCommandType.SAVE, VoiceCommandParser.parse("K Scan save this"))
    }

    @Test
    fun `K Scan open on phone returns OPEN_ON_PHONE`() {
        assertEquals(VoiceCommandType.OPEN_ON_PHONE, VoiceCommandParser.parse("K Scan open on phone"))
    }

    @Test
    fun `K Scan go back returns GO_BACK`() {
        assertEquals(VoiceCommandType.GO_BACK, VoiceCommandParser.parse("K Scan go back"))
    }

    @Test
    fun `K Scan next returns NEXT`() {
        assertEquals(VoiceCommandType.NEXT, VoiceCommandParser.parse("K Scan next"))
    }

    @Test
    fun `K Scan previous returns PREVIOUS`() {
        assertEquals(VoiceCommandType.PREVIOUS, VoiceCommandParser.parse("K Scan previous"))
    }

    @Test
    fun `K Scan prev returns PREVIOUS`() {
        assertEquals(VoiceCommandType.PREVIOUS, VoiceCommandParser.parse("K Scan prev"))
    }

    @Test
    fun `unrelated phrase returns UNKNOWN`() {
        assertEquals(VoiceCommandType.UNKNOWN, VoiceCommandParser.parse("What is the weather"))
    }

    @Test
    fun `phrase without wake prefix returns UNKNOWN`() {
        assertEquals(VoiceCommandType.UNKNOWN, VoiceCommandParser.parse("scan this"))
    }
}
