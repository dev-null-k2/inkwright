package app.inkwright.feel

import app.inkwright.feel.GoldenFixtures.doubles
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** The Kotlin [ScratchSynth] must render what the TypeScript reference renders (within 1e-4). */
class ScratchSynthParityTest {
    @Test
    fun fixturesCoverTheInterestingCases() {
        val cases = GoldenFixtures.synth
        assertTrue(cases.size >= 4)
        assertTrue("a case with the contact tap", cases.any { it.getBoolean("tap") })
        assertTrue("a case with unknown pressure", cases.any { it.getDouble("pressure") < 0 })
    }

    @Test
    fun everyCaseMatchesTheTypeScriptReference() {
        for (case in GoldenFixtures.synth) checkCase(case)
    }

    private fun checkCase(case: JSONObject) {
        val name = GoldenFixtures.label(case)
        val speed = case.getDouble("speed")
        val pressure = case.getDouble("pressure")
        val synth = ScratchSynth(case.getInt("sampleRate"), GoldenFixtures.profile(case.getJSONObject("profile")))
        synth.userVolume = case.getDouble("userVolume")

        // block1: optional touch, then a target, 1024 frames.
        if (case.getBoolean("tap")) synth.touch(pressure)
        synth.setTarget(speed, pressure)
        val a = FloatArray(1024)
        synth.render(a)
        assertBlock("$name block1", case.getJSONArray("block1").doubles(), a)
        assertTrue("$name block1 is not silent", a.any { abs(it) > 1e-3f })

        // block2: half speed, rendered at offset 256 for 512 frames into a zeroed buffer.
        synth.setTarget(speed * 0.5, pressure)
        val b = FloatArray(1024)
        synth.render(b, 256, 512)
        assertBlock("$name block2", case.getJSONArray("block2").doubles(), b)
        assertTrue("$name block2 leaves the frames outside the range alone", (0 until 256).all { b[it] == 0f } && (768 until 1024).all { b[it] == 0f })

        // block3: the release tail after silence().
        synth.silence()
        val c = FloatArray(512)
        synth.render(c)
        assertBlock("$name block3", case.getJSONArray("block3").doubles(), c)
    }

    @Test
    fun silencedSynthBecomesInaudible() {
        val synth = ScratchSynth(48_000, FeelProfile.DEFAULT)
        assertFalse(synth.isAudible)
        synth.touch(0.5)
        synth.setTarget(60.0, 0.5)
        assertTrue(synth.isAudible)
        val buf = FloatArray(4800)
        synth.render(buf)
        synth.silence()
        repeat(10) { synth.render(buf) } // 1 s: the 60 ms release is long gone
        assertFalse(synth.isAudible)
        assertTrue(buf.all { it == 0f })
    }

    private fun assertBlock(what: String, expected: DoubleArray, actual: FloatArray) {
        assertEquals("$what length", expected.size, actual.size)
        for (i in expected.indices) {
            assertEquals("$what[$i]", expected[i], actual[i].toDouble(), TOLERANCE)
        }
    }

    private companion object {
        const val TOLERANCE = 1e-4
    }
}
