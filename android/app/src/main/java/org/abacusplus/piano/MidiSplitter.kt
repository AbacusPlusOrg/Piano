package org.abacusplus.piano

/**
 * Splits a raw MIDI byte stream into whole messages, one per [emit] call,
 * because Android may batch several messages (or use running status) in one send.
 * The page parses one message at a time. SysEx and system common are dropped.
 */
class MidiSplitter(private val emit: (IntArray) -> Unit) {
    private var status = 0
    private val data = IntArray(2)
    private var count = 0

    fun feed(bytes: ByteArray, offset: Int, length: Int) {
        for (i in offset until offset + length) {
            val b = bytes[i].toInt() and 0xFF
            when {
                b >= 0xF8 -> emit(intArrayOf(b)) // real-time may interleave anywhere
                b >= 0xF0 -> { status = 0; count = 0 }
                b >= 0x80 -> { status = b; count = 0 }
                status != 0 -> {
                    data[count++] = b
                    val need = if (status and 0xE0 == 0xC0) 1 else 2 // program change, channel pressure
                    if (count == need) {
                        emit(if (need == 1) intArrayOf(status, data[0]) else intArrayOf(status, data[0], data[1]))
                        count = 0
                    }
                }
            }
        }
    }
}
