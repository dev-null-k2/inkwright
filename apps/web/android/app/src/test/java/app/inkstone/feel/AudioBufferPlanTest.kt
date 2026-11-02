package app.inkstone.feel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioBufferPlanTest {
    @Test
    fun wholeBurstsUpToTenMilliseconds() {
        val p = AudioBufferPlan.plan(48_000, 96, 0)
        assertEquals(96, p.burstFrames)
        assertEquals(480, p.bufferFrames) // 5 bursts
        assertEquals(10.0, p.bufferMillis, 1e-9)
        assertEquals(480 + 2 * 96, p.maxBufferFrames)
    }

    @Test
    fun neverFewerThanTwoBursts() {
        assertEquals(384, AudioBufferPlan.plan(48_000, 192, 0).bufferFrames) // 2 × 4 ms
        assertEquals(512, AudioBufferPlan.plan(48_000, 256, 0).bufferFrames) // 2 × 5.3 ms > 10 ms
        assertEquals(960, AudioBufferPlan.plan(48_000, 480, 0).bufferFrames) // 2 × 10 ms
    }

    @Test
    fun capacityCoversTheTunerTheNormalMixerAndTheSystemMinimum() {
        val small = AudioBufferPlan.plan(48_000, 192, 100)
        assertEquals(2880, small.capacityFrames) // 60 ms for the normal (non-fast) mixer path
        assertTrue(small.capacityFrames >= small.maxBufferFrames)
        val big = AudioBufferPlan.plan(48_000, 192, 2000)
        assertEquals(2 * 2112, big.capacityFrames) // twice the system minimum, rounded up to whole bursts
        assertEquals(0, big.capacityFrames % 192)
    }

    @Test
    fun missingOrImplausiblePropertiesFallBack() {
        val p = AudioBufferPlan.plan(null, null, -2)
        assertEquals(48_000, p.sampleRate)
        assertEquals(240, p.burstFrames) // 5 ms
        assertEquals(480, p.bufferFrames)
        assertEquals(48_000, AudioBufferPlan.plan(0, 0, 0).sampleRate)
        assertEquals(44_100, AudioBufferPlan.plan(44_100, 1_000_000, 0).sampleRate)
        assertEquals(220, AudioBufferPlan.plan(44_100, 1_000_000, 0).burstFrames)
    }
}
