package app.inkwright.feel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GrainPacerTest {
    private val ms = 1_000_000L

    @Test
    fun firstTickPlays() {
        assertTrue(GrainPacer().admit(requestedAt = 0, now = 1 * ms))
    }

    @Test
    fun ticksCloserThanMinIntervalAreDropped() {
        val p = GrainPacer(minIntervalNanos = 5 * ms)
        assertTrue(p.admit(0, 0))
        assertFalse(p.admit(1 * ms, 2 * ms))
        assertFalse(p.admit(3 * ms, 4 * ms))
        assertTrue(p.admit(5 * ms, 5 * ms))
    }

    @Test
    fun staleTicksAreDropped() {
        val p = GrainPacer(maxLatencyNanos = 40 * ms)
        assertFalse(p.admit(requestedAt = 0, now = 41 * ms))
        assertTrue(p.admit(requestedAt = 10 * ms, now = 41 * ms))
    }

    @Test
    fun droppedTicksDoNotResetTheInterval() {
        val p = GrainPacer(minIntervalNanos = 5 * ms)
        assertTrue(p.admit(0, 0))
        assertFalse(p.admit(2 * ms, 2 * ms))
        // 5 ms after the last *played* tick, not the dropped one.
        assertTrue(p.admit(5 * ms, 5 * ms))
    }

    @Test
    fun resetAllowsImmediateTick() {
        val p = GrainPacer(minIntervalNanos = 5 * ms)
        assertTrue(p.admit(0, 0))
        p.reset()
        assertTrue(p.admit(1 * ms, 1 * ms))
    }

    @Test
    fun levelsQuantizeAndClamp() {
        assertEquals(0, GrainLevels.level(0f))
        assertEquals(0, GrainLevels.level(-1f))
        assertEquals(0, GrainLevels.level(Float.NaN))
        assertEquals(GrainLevels.STEPS, GrainLevels.level(1f))
        assertEquals(GrainLevels.STEPS, GrainLevels.level(7f))
        assertEquals(16, GrainLevels.level(0.5f))
        assertEquals(1f, GrainLevels.scale(GrainLevels.STEPS), 0f)
        assertEquals(0.5f, GrainLevels.scale(16), 1e-6f)
        assertEquals(0f, GrainLevels.scale(-3), 0f)
    }
}
