package app.inkwright.recognition

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The glue between ML Kit's candidates and the bridge. ML Kit itself can't run on the JVM, so the
 * inputs are fixtures shaped like what `DigitalInkRecognizer.recognize` returns for single maths
 * symbols with the English model (texts with lower-is-better scores, sometimes repeated with
 * different spacing, sometimes without scores). They are representative, not recordings: real
 * recordings come from Settings › About › Check this device › "Record handwriting samples".
 */
class CandidatesTest {
    private fun c(vararg xs: Pair<String?, Float?>) = xs.toList()

    @Test
    fun keepsMlKitOrderAndScores() {
        val plus = c("t" to 1.12f, "+" to 1.31f, "f" to 3.9f, "x" to 4.2f)
        val out = InkPayload.candidates(plus, 6)
        assertEquals(listOf("t", "+", "f", "x"), out.map { it.text })
        assertEquals(1.12f, out[0].score!!, 0f)
    }

    @Test
    fun trimsDropsEmptyAndMergesRepeatsKeepingTheBetterScore() {
        val equals = c(" = " to 2.0f, "=" to 0.4f, "" to 0.1f, "   " to 0.2f, null to 0.3f, "z" to 3.0f)
        val out = InkPayload.candidates(equals, 6)
        assertEquals(listOf("=", "z"), out.map { it.text })
        assertEquals(0.4f, out[0].score!!, 0f)
    }

    @Test
    fun missingOrNonFiniteScoresBecomeNull() {
        val out = InkPayload.candidates(c("√" to null, "V" to Float.NaN, "v" to Float.POSITIVE_INFINITY), 6)
        assertEquals(3, out.size)
        assertTrue(out.all { it.score == null })
        // A later finite score for a text seen without one fills it in.
        val filled = InkPayload.candidates(c("2" to null, "2" to 0.7f), 6)
        assertEquals(0.7f, filled.single().score!!, 0f)
    }

    @Test
    fun capsTheListAndClampsTheLimit() {
        val many = (0 until 15).map { "c$it" to it.toFloat() }
        assertEquals(3, InkPayload.candidates(many, 3).size)
        assertEquals(InkPayload.MAX_CANDIDATES, InkPayload.candidates(many, 99).size)
        assertEquals(1, InkPayload.candidates(many, 0).size)
        // Repeats beyond the cap still improve a kept candidate's score.
        val out = InkPayload.candidates(c("a" to 5f, "b" to 1f, "a" to 0.5f), 2)
        assertEquals(0.5f, out[0].score!!, 0f)
    }

    @Test
    fun emptyInputGivesNoCandidates() {
        assertTrue(InkPayload.candidates(emptyList(), 6).isEmpty())
        assertNull(InkPayload.candidates(c("" to 1f), 6).firstOrNull())
    }
}
