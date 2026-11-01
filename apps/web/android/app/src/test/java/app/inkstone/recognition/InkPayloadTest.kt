package app.inkstone.recognition

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class InkPayloadTest {
    @Test
    fun strokeKeepsAlignedArrays() {
        val s = InkPayload.stroke(doubleArrayOf(1.0, 2.0, 3.0), doubleArrayOf(4.0, 5.0, 6.0), doubleArrayOf(100.0, 108.0, 116.0))!!
        assertArrayEquals(floatArrayOf(1f, 2f, 3f), s.x, 0f)
        assertArrayEquals(floatArrayOf(4f, 5f, 6f), s.y, 0f)
        assertArrayEquals(longArrayOf(100, 108, 116), s.t)
    }

    @Test
    fun strokeTrimsToShortestCoordinateArray() {
        val s = InkPayload.stroke(doubleArrayOf(1.0, 2.0, 3.0), doubleArrayOf(4.0, 5.0), doubleArrayOf(1.0, 2.0, 3.0))!!
        assertEquals(2, s.size)
        assertEquals(2, s.t!!.size)
    }

    @Test
    fun strokeDropsTimestampsWhenTooFew() {
        val s = InkPayload.stroke(doubleArrayOf(1.0, 2.0), doubleArrayOf(3.0, 4.0), doubleArrayOf(1.0))!!
        assertNull(s.t)
        assertNull(InkPayload.stroke(doubleArrayOf(1.0), doubleArrayOf(2.0), null)!!.t)
    }

    @Test
    fun strokeSkipsNonFinitePointsAndRejectsEmpty() {
        val s = InkPayload.stroke(doubleArrayOf(1.0, Double.NaN, 3.0), doubleArrayOf(1.0, 2.0, 3.0), null)!!
        assertArrayEquals(floatArrayOf(1f, 3f), s.x, 0f)
        assertNull(InkPayload.stroke(doubleArrayOf(), doubleArrayOf(), null))
        assertNull(InkPayload.stroke(doubleArrayOf(Double.NaN), doubleArrayOf(1.0), null))
    }

    @Test
    fun timestampsNeverGoBackwards() {
        val s = InkPayload.stroke(doubleArrayOf(0.0, 1.0, 2.0), doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(10.0, 5.0, 20.0))!!
        assertArrayEquals(longArrayOf(10, 10, 20), s.t)
    }

    @Test
    fun preContextChainsPreviousLineWithAWordBreak() {
        assertEquals("", InkPayload.preContext("", ""))
        assertEquals("Hello ", InkPayload.preContext("", "Hello"))
        assertEquals("Hello ", InkPayload.preContext("", "Hello "))
        assertEquals("", InkPayload.preContext("", "   "))
    }

    @Test
    fun explicitPreContextWins() {
        assertEquals("machine lear", InkPayload.preContext("machine lear", "previous line"))
    }

    @Test
    fun preContextIsTrimmedToLast20Chars() {
        val long = "The quick brown fox jumps over"
        val pre = InkPayload.preContext("", long)
        assertEquals(InkPayload.MAX_PRE_CONTEXT, pre.length)
        assertEquals("ck brown fox jumps over ".takeLast(20), pre)
        assertEquals(20, InkPayload.preContext(long, "").length)
    }

    @Test
    fun writingAreaUsesGivenSizeOrFallsBackToInkExtent() {
        assertEquals(Pair(300f, 40f), InkPayload.writingArea(300f, 40f, emptyList()))
        val stroke = InkPayload.stroke(doubleArrayOf(10.0, 110.0), doubleArrayOf(5.0, 25.0), null)!!
        assertEquals(Pair(100f, 20f), InkPayload.writingArea(0f, Float.NaN, listOf(stroke)))
        // A dot: zero extent is clamped to the 1-unit minimum ML Kit accepts.
        val dot = InkPayload.stroke(doubleArrayOf(3.0), doubleArrayOf(3.0), null)!!
        assertEquals(Pair(1f, 1f), InkPayload.writingArea(0f, 0f, listOf(dot)))
        assertEquals(Pair(1f, 1f), InkPayload.writingArea(-5f, -5f, emptyList()))
    }

    @Test
    fun languageResolutionFallsBackToBaseLanguage() {
        val known = setOf("en-US", "de", "pt-BR")
        val supported: (String) -> Boolean = { it in known }
        assertEquals("en-US", InkPayload.resolveLanguage("en-US", supported))
        assertEquals("en-US", InkPayload.resolveLanguage("en_US", supported))
        assertEquals("de", InkPayload.resolveLanguage("de-AT", supported))
        assertEquals("pt-BR", InkPayload.resolveLanguage(" pt-BR ", supported))
        assertNull(InkPayload.resolveLanguage("xx-YY", supported))
        assertNull(InkPayload.resolveLanguage("", supported))
        assertNotNull(InkPayload.resolveLanguage("de", supported))
    }
}
