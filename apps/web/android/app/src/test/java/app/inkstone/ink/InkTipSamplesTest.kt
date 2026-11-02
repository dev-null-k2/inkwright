package app.inkstone.ink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InkTipSamplesTest {
    /** x,y pairs → points, for readable assertions. */
    private fun points(xy: FloatArray) = xy.toList().chunked(2).map { it[0] to it[1] }

    /** Stroke [stroke] moving +1 px per ms along x from [x0], a sample every [step] ms over [from]..[until]. */
    private fun InkTipSamples.line(stroke: Int, from: Int, until: Int, step: Int = 4, x0: Float = 0f, y: Float = 0f) {
        var t = from
        while (t <= until) {
            add(stroke, x0 + t, y, t.toDouble())
            t += step
        }
    }

    @Test
    fun emptyBufferHasNoTail() {
        assertEquals(0, InkTipSamples().tail(1, 40.0).size)
    }

    @Test
    fun unknownStrokeHasNoTail() {
        val s = InkTipSamples()
        s.line(1, 0, 20)
        assertEquals(0, s.tail(2, 40.0).size)
    }

    @Test
    fun singleSampleIsOnePoint() {
        val s = InkTipSamples()
        s.add(7, 12f, 34f, 1000.0)
        assertEquals(listOf(12f to 34f), points(s.tail(7, 40.0)))
    }

    @Test
    fun tailKeepsTheNewestTailMsAndInterpolatesItsStart() {
        val s = InkTipSamples()
        s.line(1, 0, 100) // newest at t = 100
        // Window [62, 100]: samples 64..100, plus the start interpolated between 60 and 64 at 62.
        val expected = listOf(62f to 0f) + (64..100 step 4).map { it.toFloat() to 0f }
        assertEquals(expected, points(s.tail(1, 38.0)))
    }

    @Test
    fun sampleExactlyOnTheCutoffIsNotDoubled() {
        val s = InkTipSamples()
        s.line(1, 0, 100)
        val expected = (60..100 step 4).map { it.toFloat() to 0f }
        assertEquals(expected, points(s.tail(1, 40.0)))
    }

    @Test
    fun interpolationFollowsBothAxes() {
        val s = InkTipSamples()
        s.add(1, 0f, 0f, 0.0)
        s.add(1, 10f, 20f, 10.0)
        s.add(1, 20f, 40f, 50.0)
        // Window [10, 50] starts exactly on the 10 ms sample; [20, 50] starts a quarter of the way along 10→50.
        assertEquals(listOf(10f to 20f, 20f to 40f), points(s.tail(1, 40.0)))
        assertEquals(listOf(12.5f to 25f, 20f to 40f), points(s.tail(1, 30.0)))
    }

    @Test
    fun tailNeverReachesBackAcrossPenDown() {
        val s = InkTipSamples()
        s.line(1, 0, 100) // a stroke that lifted at t = 100
        s.line(2, 110, 118, x0 = 500f) // the next one, down for 8 ms
        val tail = points(s.tail(2, 40.0))
        assertEquals(listOf(610f to 0f, 614f to 0f, 618f to 0f), tail) // no interpolation into stroke 1
    }

    @Test
    fun anEarlierStrokesTailIsStillItsOwn() {
        val s = InkTipSamples()
        s.line(1, 0, 100)
        s.line(2, 110, 130, x0 = 500f)
        assertEquals((60..100 step 4).map { it.toFloat() to 0f }, points(s.tail(1, 40.0)))
    }

    @Test
    fun ringOverwritesTheOldestSamples() {
        val s = InkTipSamples(capacity = 8)
        s.line(1, 0, 76) // 20 samples into 8 slots
        assertEquals(8, s.size)
        // Asking for more than is held gives what is held, oldest first, without a boundary point.
        assertEquals((48..76 step 4).map { it.toFloat() to 0f }, points(s.tail(1, 1000.0)))
        // A window inside what is held still interpolates its start (66, between 64 and 68).
        assertEquals(listOf(66f to 0f, 68f to 0f, 72f to 0f, 76f to 0f), points(s.tail(1, 10.0)))
    }

    @Test
    fun ringWrapsAcrossStrokes() {
        val s = InkTipSamples(capacity = 5)
        s.line(1, 0, 12) // 4 samples
        s.line(2, 20, 32, x0 = 100f) // 4 more: stroke 1 keeps only its newest sample
        assertEquals(listOf(12f to 0f), points(s.tail(1, 40.0)))
        assertEquals((20..32 step 4).map { 100f + it to 0f }, points(s.tail(2, 40.0)))
    }

    @Test
    fun repeatedTimestampsStayFinite() {
        val s = InkTipSamples()
        s.add(1, 0f, 0f, 0.0)
        s.add(1, 5f, 0f, 10.0)
        s.add(1, 6f, 0f, 10.0) // coalesced samples share a time
        s.add(1, 9f, 0f, 60.0)
        val tail = s.tail(1, 49.0) // cutoff 11: interpolate between the second 10 ms sample and 60
        assertTrue(tail.all { it.isFinite() })
        assertEquals(6f + 3f * (1f / 50f), tail[0], 1e-5f)
        assertEquals(2, tail.size / 2)
        // Cutoff 10: both 10 ms samples are inside and the oldest sits on the cutoff, so no twin.
        assertEquals(listOf(5f to 0f, 6f to 0f, 9f to 0f), points(s.tail(1, 50.0)))
    }

    @Test
    fun zeroTailIsJustTheNewestSample() {
        val s = InkTipSamples()
        s.line(1, 0, 20)
        assertEquals(listOf(20f to 0f), points(s.tail(1, 0.0)))
    }

    @Test
    fun clearForgetsEverything() {
        val s = InkTipSamples()
        s.line(1, 0, 20)
        s.clear()
        assertEquals(0, s.size)
        assertEquals(0, s.tail(1, 40.0).size)
        s.add(1, 3f, 4f, 30.0)
        assertEquals(listOf(3f to 4f), points(s.tail(1, 40.0)))
    }

    @Test(expected = IllegalArgumentException::class)
    fun capacityMustHoldASegment() {
        InkTipSamples(capacity = 1)
    }
}
