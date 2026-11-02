package app.inkwright.feel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StrokeFeelControllerTest {
    private class Recorder : FeelOutput {
        val configured = mutableListOf<Pair<FeelProfile, Double>>()
        val taps = mutableListOf<Double>()
        val targets = mutableListOf<Pair<Double, Double>>()
        var silences = 0
        val ticks = mutableListOf<Double>()

        override fun configureSound(profile: FeelProfile, gain: Double) { configured += profile to gain }
        override fun soundTap(pressure: Double) { taps += pressure }
        override fun soundTarget(speedMmPerSec: Double, pressure: Double) { targets += speedMmPerSec to pressure }
        override fun soundSilence() { silences++ }
        override fun hapticTick(intensity: Double) { ticks += intensity }
    }

    private val out = Recorder()
    private val c = StrokeFeelController(out)
    private val profile = FeelProfile.DEFAULT.copy(hapticStrength = 0.8)
    private val settings = FeelSettings(profile, sound = true, soundGain = 0.3, haptics = true, hapticStrength = 1.0)

    /** Pen down at uptime [DOWN] and t = 0, then moving along x at [speed] mm/s every 4 ms until [untilMs]. */
    private fun penDown(pressure: Double = 0.4) = c.stylusDown(POINTER, 10.0, 20.0, 0.0, pressure, DOWN)

    private fun move(fromMs: Int, untilMs: Int, speed: Double = 50.0, pressure: Double = 0.5) {
        var t = fromMs
        while (t <= untilMs) {
            c.stylusMove(10.0 + speed * t / 1000, 20.0, t.toDouble(), pressure)
            t += 4
        }
    }

    @Test
    fun speedIsTrackedBeforeTheStrokeIsArmed() {
        penDown()
        move(4, 20)
        assertTrue(out.targets.isEmpty() && out.ticks.isEmpty() && out.taps.isEmpty())
        assertEquals(50.0, c.speed, 1e-9)

        c.begin(settings, 0.5, DOWN + 20)
        assertTrue(c.armed)
        assertEquals(listOf(profile to 0.3), out.configured)
        assertEquals(listOf(0.5), out.taps)
        // The sound starts at the speed the pen already has, not from rest.
        assertEquals(50.0, out.targets.single().first, 1e-9)
    }

    @Test
    fun armedSamplesDriveSoundAndGrain() {
        penDown()
        c.begin(settings, 0.5, DOWN + 5)
        move(4, 400, speed = 40.0)
        assertEquals(1 + 100, out.targets.size) // the pen so far at begin, then one per sample
        assertEquals(0.4 to 0.4, out.targets.first().let { it.first + 0.4 to it.second }) // at rest, pen-down pressure
        assertTrue(out.targets.drop(1).all { it.second == 0.5 })
        assertTrue("grain ticks while moving", out.ticks.isNotEmpty())
    }

    @Test
    fun hapticTicksAreTheGrainSchedulersInMillimetres() {
        penDown(pressure = 0.5)
        c.begin(settings, 0.5, DOWN + 5)
        move(4, 600, speed = 40.0)

        // Same sequence the controller runs: setProfile, reset, anchor at the last position.
        val reference = GrainScheduler(FeelProfile.DEFAULT, unitsPerMm = 1.0)
        reference.setProfile(profile)
        reference.userStrength = 1.0
        reference.reset()
        reference.onSample(10.0, 20.0, 0.0, 0.5)
        val expected = mutableListOf<Double>()
        var t = 4
        while (t <= 600) {
            reference.onSample(10.0 + 40.0 * t / 1000, 20.0, t.toDouble(), 0.5)?.let { expected += it.intensity }
            t += 4
        }
        assertTrue(expected.isNotEmpty())
        assertEquals(expected, out.ticks)
    }

    @Test
    fun contactTapOnlyNearPenDown() {
        penDown()
        c.begin(settings, 0.5, DOWN + StrokeFeelController.TAP_WINDOW_MS + 1)
        assertTrue("late begin: no tap", out.taps.isEmpty())
        assertTrue(c.armed)

        c.stylusUp()
        c.stylusDown(POINTER, 0.0, 0.0, 0.0, 0.4, DOWN + 500)
        c.begin(settings, 0.5, DOWN + 500 + StrokeFeelController.TAP_WINDOW_MS)
        assertEquals(listOf(0.5), out.taps)
    }

    @Test
    fun repeatedBeginForOneStrokeTapsOnce() {
        penDown()
        c.begin(settings, 0.5, DOWN + 5)
        c.begin(settings, 0.5, DOWN + 10)
        assertEquals(1, out.taps.size)
    }

    @Test
    fun unknownPressureTapsWithThePenDownPressure() {
        penDown(pressure = 0.4)
        c.begin(settings, -1.0, DOWN + 5)
        assertEquals(listOf(0.4), out.taps)
    }

    @Test
    fun quickTapThatAlreadyLiftedPlaysOnlyTheTap() {
        penDown()
        c.stylusUp()
        c.begin(settings, 0.7, DOWN + 30)
        assertEquals(listOf(0.7), out.taps)
        assertFalse(c.armed)
        assertTrue(out.targets.isEmpty())
    }

    @Test
    fun liftDisarmsAndSilences() {
        penDown()
        c.begin(settings, 0.5, DOWN + 5)
        move(4, 40)
        c.stylusUp()
        assertFalse(c.armed)
        assertEquals(1, out.silences)
        val targets = out.targets.size
        move(44, 80) // no stylus down: ignored
        c.stylusDown(POINTER, 0.0, 0.0, 100.0, 0.5, DOWN + 100)
        move(104, 140) // a new stroke the web layer hasn't begun: tracked only
        assertEquals(targets, out.targets.size)
        assertFalse(c.armed)
    }

    @Test
    fun endDisarmsWhileThePenStaysDown() {
        penDown()
        c.begin(settings, 0.5, DOWN + 5)
        c.end()
        assertFalse(c.armed)
        assertEquals(1, out.silences)
        val targets = out.targets.size
        move(4, 40)
        assertEquals(targets, out.targets.size)
        c.end() // idempotent
        assertEquals(1, out.silences)
    }

    @Test
    fun aNewPenDownReplacesAStrokeWhoseLiftWasMissed() {
        penDown()
        c.begin(settings, 0.5, DOWN + 5)
        c.stylusDown(POINTER + 1, 0.0, 0.0, 50.0, 0.5, DOWN + 50)
        assertFalse(c.armed)
        assertEquals(1, out.silences)
        assertEquals(POINTER + 1, c.trackedPointerId)
    }

    @Test
    fun soundOffSendsNoSound() {
        val quiet = settings.copy(sound = false)
        penDown()
        c.begin(quiet, 0.5, DOWN + 5)
        move(4, 400)
        c.stylusUp()
        assertTrue(out.configured.isEmpty() && out.taps.isEmpty() && out.targets.isEmpty())
        assertEquals(0, out.silences)
        assertTrue(out.ticks.isNotEmpty())

        // soundGain 0 (slider at zero) is off too.
        c.stylusDown(POINTER, 0.0, 0.0, 0.0, 0.5, DOWN + 1000)
        c.begin(settings.copy(soundGain = 0.0), 0.5, DOWN + 1005)
        assertTrue(out.taps.isEmpty())
    }

    @Test
    fun hapticsOffSendsNoTicks() {
        penDown()
        c.begin(settings.copy(haptics = false), 0.5, DOWN + 5)
        move(4, 400)
        assertTrue(out.ticks.isEmpty())
        assertTrue(out.targets.isNotEmpty())
    }

    @Test
    fun previewIsASyntheticStroke() {
        c.startPreview(settings, 0)
        assertTrue(c.isPreviewing)
        assertEquals(listOf(StrokeFeelController.PREVIEW_PRESSURE), out.taps)
        var now = 0L
        while (c.stepPreview(now)) now += 4
        assertFalse(c.isPreviewing)
        assertTrue(now >= StrokeFeelController.PREVIEW_MS.toLong())
        val speeds = out.targets.map { it.first }
        assertEquals(0.0, speeds.first(), 1e-9)
        assertEquals(StrokeFeelController.PREVIEW_PEAK_MM_S, speeds.max(), 0.1) // ramps 0 → 80 → 0
        assertTrue(speeds.last() < 2.0)
        assertTrue(out.targets.all { it.second == StrokeFeelController.PREVIEW_PRESSURE })
        assertEquals(1, out.silences)
        assertTrue("grain during the preview", out.ticks.isNotEmpty())
    }

    @Test
    fun previewNeverTalksOverAStroke() {
        penDown()
        c.begin(settings, 0.5, DOWN + 5)
        c.startPreview(settings, DOWN + 10)
        assertFalse(c.isPreviewing)

        c.end()
        c.startPreview(settings, 0)
        assertTrue(c.isPreviewing)
        penDown()
        c.begin(settings, 0.5, DOWN + 5)
        assertFalse("a stroke stops the preview", c.isPreviewing)
    }

    @Test
    fun screenScaleUsesPhysicalDpiUnlessImplausible() {
        assertEquals(400.0 / 25.4, ScreenScale.pxPerMm(400f, 420), 1e-9)
        assertEquals(420.0 / 25.4, ScreenScale.pxPerMm(160f, 420), 1e-9) // placeholder xdpi
        assertEquals(420.0 / 25.4, ScreenScale.pxPerMm(0f, 420), 1e-9)
        assertEquals(420.0 / 25.4, ScreenScale.pxPerMm(Float.NaN, 420), 1e-9)
        assertEquals(160.0 / 25.4, ScreenScale.pxPerMm(Float.NaN, 0), 1e-9)
    }

    private companion object {
        const val POINTER = 3
        const val DOWN = 10_000L
    }
}
