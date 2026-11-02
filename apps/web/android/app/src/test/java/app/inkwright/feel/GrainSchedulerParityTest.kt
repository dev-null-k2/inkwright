package app.inkwright.feel

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sin

/**
 * The Kotlin [GrainScheduler] must tick on exactly the samples the TypeScript reference ticks on,
 * with the same intensity and speed (1e-6 relative).
 */
class GrainSchedulerParityTest {
    private data class Tick(val i: Int, val t: Double, val intensity: Double, val speed: Double)

    @Test
    fun everyCaseMatchesTheTypeScriptReference() {
        val cases = GoldenFixtures.grain
        assertTrue(cases.size >= 3)
        for (case in cases) {
            val unitsPerMm = case.getDouble("unitsPerMm")
            val scheduler = GrainScheduler(
                GoldenFixtures.profile(case.getJSONObject("profile")),
                unitsPerMm,
                case.getDouble("maxRateHz"),
                case.getDouble("strength"),
                case.getInt("seed"),
            )
            // Fixture input: x=(speed*(0.6+0.4*sin(t/90))*t/1000)*unitsPerMm, y=sin(t/50)*3, t=0..1500 step 4
            val feed = samples { t ->
                val v = case.getDouble("speed") * (0.6 + 0.4 * sin(t / 90))
                doubleArrayOf((v * t) / 1000 * unitsPerMm, sin(t / 50) * 3)
            }
            val ticks = collect(scheduler, case.getDouble("pressure"), feed)
            assertTicks(GoldenFixtures.label(case), expected(case), ticks)
        }
    }

    /** How the native engine uses it: positions already in millimetres, unitsPerMm = 1. */
    @Test
    fun millimetreInputWithUnitScaleTicksTheSame() {
        for (case in GoldenFixtures.grain) {
            val unitsPerMm = case.getDouble("unitsPerMm")
            val scheduler = GrainScheduler(
                GoldenFixtures.profile(case.getJSONObject("profile")),
                1.0,
                case.getDouble("maxRateHz"),
                case.getDouble("strength"),
                case.getInt("seed"),
            )
            val feed = samples { t ->
                val v = case.getDouble("speed") * (0.6 + 0.4 * sin(t / 90))
                doubleArrayOf((v * t) / 1000, sin(t / 50) * 3 / unitsPerMm)
            }
            val ticks = collect(scheduler, case.getDouble("pressure"), feed)
            assertTicks(GoldenFixtures.label(case) + " (mm)", expected(case), ticks)
        }
    }

    @Test
    fun resetForgetsThePreviousStroke() {
        val g = GrainScheduler(FeelProfile.DEFAULT, unitsPerMm = 1.0)
        g.onSample(0.0, 0.0, 0.0, 0.5)
        g.onSample(1.0, 0.0, 10.0, 0.5)
        assertTrue(g.speed > 0)
        g.reset()
        assertEquals(0.0, g.speed, 0.0)
        // First sample after reset only anchors the position: no tick, however far away it is.
        assertEquals(null, g.onSample(500.0, 0.0, 20.0, 0.5))
    }

    /** (t, [x, y]) for t = 0..1500 ms in 4 ms steps, like the fixture generator. */
    private fun samples(position: (Double) -> DoubleArray): List<Pair<Double, DoubleArray>> {
        val out = ArrayList<Pair<Double, DoubleArray>>()
        var t = 0
        while (t <= 1500) {
            out += t.toDouble() to position(t.toDouble())
            t += 4
        }
        return out
    }

    private fun collect(g: GrainScheduler, pressure: Double, feed: List<Pair<Double, DoubleArray>>): List<Tick> =
        feed.mapIndexedNotNull { i, (t, xy) ->
            g.onSample(xy[0], xy[1], t, pressure)?.let { Tick(i, t, it.intensity, it.speedMmPerSec) }
        }

    private fun expected(case: JSONObject): List<Tick> {
        val a = case.getJSONArray("ticks")
        return List(a.length()) {
            val o = a.getJSONObject(it)
            Tick(o.getInt("i"), o.getDouble("t"), o.getDouble("intensity"), o.getDouble("speed"))
        }
    }

    private fun assertTicks(what: String, expected: List<Tick>, actual: List<Tick>) {
        assertEquals("$what tick indices", expected.map { it.i }, actual.map { it.i })
        for ((e, a) in expected.zip(actual)) {
            assertEquals("$what t at ${e.i}", e.t, a.t, 0.0)
            assertRelative("$what intensity at ${e.i}", e.intensity, a.intensity)
            assertRelative("$what speed at ${e.i}", e.speed, a.speed)
        }
    }

    private fun assertRelative(what: String, expected: Double, actual: Double) {
        val tolerance = 1e-6 * max(abs(expected), 1e-12)
        assertEquals(what, expected, actual, tolerance)
    }
}
