package org.abacusplus.piano

import org.junit.Assert.assertEquals
import org.junit.Test

class MidiSplitterTest {
    private fun split(vararg b: Int): List<List<Int>> {
        val out = mutableListOf<List<Int>>()
        val s = MidiSplitter { out.add(it.toList()) }
        val bytes = ByteArray(b.size) { b[it].toByte() }
        s.feed(bytes, 0, 2) // split across two sends
        s.feed(bytes, 2, bytes.size - 2)
        return out
    }

    @Test
    fun splitsBatchesRunningStatusRealTimeAndSysex() {
        assertEquals(
            listOf(
                listOf(0x90, 60, 100),
                listOf(0xF8),           // clock inside the next message passes straight through
                listOf(0x90, 64, 90),   // running status
                listOf(0xB0, 64, 127),  // sustain
                listOf(0xC0, 5),        // 1 data byte; the SysEx after it is dropped
                listOf(0x80, 60, 0)
            ),
            split(0x90, 60, 100, 64, 0xF8, 90, 0xB0, 64, 127, 0xC0, 5,
                0xF0, 0x7E, 0x01, 0xF7, 0x80, 60, 0)
        )
    }
}
