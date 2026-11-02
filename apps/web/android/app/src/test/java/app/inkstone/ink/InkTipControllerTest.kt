package app.inkstone.ink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class InkTipControllerTest {
    private sealed class Op {
        class Render(val frame: InkTipFrame) : Op() {
            val points get() = frame.xy.toList().chunked(2).map { it[0] to it[1] }
        }

        object Clear : Op()
    }

    private class Recorder : InkTipOutput {
        val ops = mutableListOf<Op>()
        val renders get() = ops.filterIsInstance<Op.Render>()
        val clears get() = ops.count { it === Op.Clear }
        val last get() = ops.last()

        override fun render(frame: InkTipFrame) {
            ops += Op.Render(frame)
        }

        override fun clear() {
            ops += Op.Clear
        }
    }

    private val out = Recorder()
    private val c = InkTipController(out)
    private val style = InkTipStyle(argb = 0xFF102030.toInt(), widthPx = 6f, tailMs = 40.0, maxPredictionPx = 50f)

    /** Pen down at [t] ms, at ([x], [y]). */
    private fun down(t: Int = 0, x: Float = 100f, y: Float = 200f, pointer: Int = POINTER) =
        c.stylusDown(pointer, x, y, t.toDouble(), t.toDouble())

    /**
     * The pen moving +1 px/ms along x (x = [x0] + t), one MotionEvent every [step] ms over
     * [from]..[until]; each event ends with present() unless [present] is false.
     */
    private fun moves(from: Int, until: Int, step: Int = 4, x0: Float = 100f, present: Boolean = true) {
        var t = from
        while (t <= until) {
            c.stylusMove(x0 + t, 200f, t.toDouble())
            if (present) c.present()
            t += step
        }
    }

    private fun lastFrame() = (out.ops.last { it is Op.Render } as Op.Render)

    // ---- Arming ----

    @Test
    fun beginWithNoStylusDownDoesNothing() {
        c.begin(style, 0.0)
        assertTrue(out.ops.isEmpty())
        assertEquals(InkTipController.Phase.IDLE, c.phase)
    }

    @Test
    fun aTapThatLiftedBeforeBeginIsLeftToTheWebInk() {
        down(0)
        moves(4, 8, present = false)
        c.stylusUp(10.0)
        c.begin(style, 20.0)
        assertTrue(out.ops.isEmpty())
        assertEquals(InkTipController.Phase.IDLE, c.phase)
        assertEquals(InkTipController.NO_DEADLINE, c.deadlineMs, 0.0)
    }

    @Test
    fun samplesBeforeBeginAreTrackedButNotDrawn() {
        down(0)
        moves(4, 16)
        assertTrue("nothing drawn until armed", out.ops.isEmpty())
        assertFalse(c.wantsPrediction)
    }

    @Test
    fun beginDrawsTheStrokeSoFarAtOnce() {
        down(0)
        moves(4, 16, present = false)
        c.begin(style, 18.0)
        val f = out.renders.single()
        assertEquals((0..16 step 4).map { 100f + it to 200f }, f.points)
        assertEquals(style.argb, f.frame.argb)
        assertEquals(style.widthPx, f.frame.widthPx, 0f)
        assertTrue(c.shown)
        assertTrue(c.wantsPrediction)
    }

    @Test
    fun beginNeverReachesIntoThePreviousStroke() {
        down(0, x = 100f)
        moves(4, 100, present = false)
        c.stylusUp(100.0)
        down(110, x = 1000f)
        c.stylusMove(1004f, 200f, 114.0)
        c.begin(style, 116.0)
        assertEquals(listOf(1000f to 200f, 1004f to 200f), out.renders.single().points)
    }

    @Test
    fun repeatedBeginTakesTheNewStyle() {
        down(0)
        c.begin(style, 5.0)
        c.begin(style.copy(argb = 0xFFFF0000.toInt(), widthPx = 9f), 6.0)
        assertEquals(0xFFFF0000.toInt(), lastFrame().frame.argb)
        assertEquals(9f, lastFrame().frame.widthPx, 0f)
    }

    // ---- Drawing ----

    @Test
    fun eachEventRedrawsTheNewestTailOnly() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 200)
        assertEquals(1 + 50, out.renders.size) // begin, then one per event
        val f = lastFrame()
        // Newest sample at 200 ms: the tail is 160..200 (no older sample, no gap).
        assertEquals((160..200 step 4).map { 100f + it to 200f }, f.points)
        // At no point did a frame reach further back than tailMs before its own newest sample.
        for (r in out.renders) {
            val xs = r.points.map { it.first }
            assertTrue(xs.last() - xs.first() <= 40f + 1e-3f)
        }
    }

    @Test
    fun samplesAreBatchedPerEvent() {
        down(0)
        c.begin(style, 1.0)
        val before = out.renders.size
        moves(4, 40, present = false) // historical samples of one event
        assertEquals(before, out.renders.size)
        c.present()
        assertEquals(before + 1, out.renders.size)
        assertEquals(140f, lastFrame().points.last().first, 0f)
    }

    @Test
    fun predictionAddsOnePointAtTheEnd() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40, present = false)
        c.present(150f, 205f)
        val p = lastFrame().points
        assertEquals(140f to 200f, p[p.size - 2])
        assertEquals(150f to 205f, p.last())
    }

    @Test
    fun predictionIsClampedToAPlausibleReach() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40, present = false)
        c.present(140f + 300f, 200f + 400f) // 500 px away; max 50
        val p = lastFrame().points.last()
        assertEquals(140f + 30f, p.first, 1e-3f)
        assertEquals(200f + 40f, p.second, 1e-3f)
    }

    @Test
    fun missingPredictionIsLeftOut() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40, present = false)
        c.present(Float.NaN, 300f)
        assertEquals(140f to 200f, lastFrame().points.last())
        c.present(Float.POSITIVE_INFINITY, 300f)
        assertEquals(140f to 200f, lastFrame().points.last())
    }

    @Test
    fun windowCoordinatesAreDrawnRelativeToTheOverlay() {
        c.setOverlayOrigin(30f, 70f)
        down(0, x = 100f, y = 200f)
        c.begin(style, 1.0)
        assertEquals(listOf(70f to 130f), lastFrame().points)
        c.stylusMove(110f, 210f, 4.0)
        c.present(120f, 220f)
        assertEquals(listOf(70f to 130f, 80f to 140f, 90f to 150f), lastFrame().points)
    }

    @Test
    fun movesOfAnotherPointerOrAfterTheLiftAreIgnored() {
        c.stylusMove(5f, 5f, 0.0) // nothing down
        down(10)
        c.begin(style, 11.0)
        c.stylusUp(20.0)
        val renders = out.renders.size
        c.stylusMove(500f, 500f, 24.0)
        c.present()
        assertEquals(renders, out.renders.size)
    }

    // ---- Ending ----

    @Test
    fun liftDropsThePredictionThenTheFailsafeClears() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40, present = false)
        c.present(160f, 200f)
        c.stylusUp(50.0)
        // Redrawn without the guess: the stroke ends where the pen did.
        assertEquals(140f to 200f, lastFrame().points.last())
        assertEquals(InkTipController.Phase.LIFTED, c.phase)
        assertEquals(50.0 + InkTipController.LIFT_FAILSAFE_MS, c.deadlineMs, 0.0)
        c.onTimer(349.0)
        assertTrue(c.shown)
        c.onTimer(350.0)
        assertSame(Op.Clear, out.last)
        assertFalse(c.shown)
        assertEquals(InkTipController.Phase.IDLE, c.phase)
        assertEquals(InkTipController.NO_DEADLINE, c.deadlineMs, 0.0)
    }

    @Test
    fun endAfterTheLiftLingersThenClears() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40)
        c.stylusUp(42.0)
        val ops = out.ops.size
        c.end(false, 60.0)
        assertEquals("nothing cleared yet", ops, out.ops.size)
        assertEquals(InkTipController.Phase.LINGER, c.phase)
        assertEquals(60.0 + InkTipController.LINGER_MS, c.deadlineMs, 0.0)
        c.onTimer(119.0)
        assertTrue(c.shown)
        c.onTimer(120.0)
        assertSame(Op.Clear, out.last)
        assertEquals(1, out.clears)
        assertEquals(InkTipController.Phase.IDLE, c.phase)
    }

    @Test
    fun endWhileThePenIsStillDownStopsExtending() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40, present = false)
        c.present(170f, 200f)
        c.end(false, 42.0)
        assertEquals(140f to 200f, lastFrame().points.last()) // guess dropped
        val renders = out.renders.size
        moves(44, 80)
        assertEquals("no longer extended", renders, out.renders.size)
        assertFalse(c.wantsPrediction)
        c.onTimer(102.0)
        assertSame(Op.Clear, out.last)
        assertEquals(InkTipController.Phase.IDLE, c.phase)
        c.stylusUp(110.0)
        assertEquals(InkTipController.NO_DEADLINE, c.deadlineMs, 0.0)
    }

    @Test
    fun cancelledEndClearsAtOnce() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40)
        c.end(true, 41.0)
        assertSame(Op.Clear, out.last)
        assertFalse(c.shown)
        assertEquals(InkTipController.Phase.IDLE, c.phase)
        val ops = out.ops.size
        moves(44, 80) // e.g. snapped to a shape while the pen keeps going
        c.stylusUp(82.0)
        c.onTimer(1000.0)
        assertEquals(ops, out.ops.size)
    }

    @Test
    fun cancelledEventClearsAtOnce() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40)
        c.stylusCancel(41.0)
        assertSame(Op.Clear, out.last)
        assertFalse(c.isStylusDown)
        assertEquals(InkTipController.Phase.IDLE, c.phase)
    }

    @Test
    fun endWithNothingDrawnTouchesNothing() {
        down(0)
        moves(4, 20)
        c.stylusUp(22.0)
        c.end(false, 30.0)
        c.end(true, 31.0)
        c.onTimer(1000.0)
        assertTrue(out.ops.isEmpty())
    }

    @Test
    fun aDuplicateEndDoesNotProlongTheLinger() {
        down(0)
        c.begin(style, 1.0)
        c.stylusUp(10.0)
        c.end(false, 20.0)
        c.end(false, 70.0)
        assertEquals(20.0 + InkTipController.LINGER_MS, c.deadlineMs, 0.0)
    }

    // ---- Failsafes ----

    @Test
    fun aRestingPenIsClearedAndDrawsAgainWhenItMoves() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 20)
        assertEquals(20.0 + InkTipController.REST_CLEAR_MS, c.deadlineMs, 0.0)
        c.onTimer(169.0)
        assertTrue(c.shown)
        c.onTimer(170.0)
        assertSame(Op.Clear, out.last)
        assertEquals("still armed", InkTipController.Phase.DRAWING, c.phase)
        assertEquals(InkTipController.NO_DEADLINE, c.deadlineMs, 0.0)
        c.stylusMove(400f, 200f, 300.0)
        c.present()
        // Only the newest 40 ms: interpolated at 260 ms on the 20 → 300 ms segment, then the new sample.
        val p = lastFrame().points
        assertEquals(2, p.size)
        assertEquals(120f + 280f * (240f / 280f), p[0].first, 1e-3f)
        assertEquals(400f to 200f, p[1])
    }

    @Test
    fun aLiftThatComesAfterTheRestClearDrawsNothingNew() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 20)
        c.onTimer(200.0)
        val ops = out.ops.size
        c.stylusUp(210.0)
        assertEquals(ops, out.ops.size)
        c.onTimer(210.0 + InkTipController.LIFT_FAILSAFE_MS)
        assertEquals(ops, out.ops.size) // nothing shown, nothing to clear
        assertEquals(InkTipController.Phase.IDLE, c.phase)
    }

    @Test
    fun aMissedLiftEndsTheOldStrokeWhenTheNextOneStarts() {
        down(0, pointer = 1)
        c.begin(style, 1.0)
        moves(4, 20)
        down(30, x = 600f, pointer = 2) // no ACTION_UP was seen for pointer 1
        assertEquals(InkTipController.Phase.LIFTED, c.phase)
        assertEquals(2, c.trackedPointerId)
        c.onTimer(30.0 + InkTipController.LIFT_FAILSAFE_MS)
        assertSame(Op.Clear, out.last)
    }

    @Test
    fun theNextStrokesBeginReplacesALingeringTail() {
        down(0)
        c.begin(style, 1.0)
        moves(4, 40)
        c.stylusUp(42.0)
        c.end(false, 50.0) // lingers until 110
        down(80, x = 1000f)
        c.stylusMove(1004f, 200f, 84.0)
        c.begin(style, 90.0)
        assertEquals(listOf(1000f to 200f, 1004f to 200f), lastFrame().points)
        val ops = out.ops.size
        c.onTimer(110.0) // the old linger deadline must not wipe the new stroke
        assertEquals(ops, out.ops.size)
        assertEquals(InkTipController.Phase.DRAWING, c.phase)
    }

    @Test
    fun aLiftOfAnUnarmedStrokeLeavesTheLingerAlone() {
        down(0)
        c.begin(style, 1.0)
        c.stylusUp(10.0)
        c.end(false, 20.0)
        down(30)
        c.stylusUp(40.0)
        assertEquals(InkTipController.Phase.LINGER, c.phase)
        assertEquals(20.0 + InkTipController.LINGER_MS, c.deadlineMs, 0.0)
    }

    @Test
    fun resetClearsAndForgetsTheStylus() {
        down(0)
        c.begin(style, 1.0)
        c.reset()
        assertSame(Op.Clear, out.last)
        assertFalse(c.isStylusDown)
        assertEquals(InkTipController.Phase.IDLE, c.phase)
        val ops = out.ops.size
        c.stylusMove(120f, 200f, 20.0)
        c.begin(style, 21.0) // the rest of that stroke is the web ink's
        c.present()
        assertEquals(ops, out.ops.size)
    }

    /**
     * Whatever order events and calls arrive in, ink is never left on the overlay: whenever anything
     * is shown a deadline is pending, IDLE means clear, and once the pen is up and time passes the
     * overlay ends up cleared.
     */
    @Test
    fun inkIsNeverLeftOnTheOverlay() {
        repeat(20) { seed ->
            val out = Recorder()
            val c = InkTipController(out, capacity = 32)
            val rnd = Random(seed)
            var now = 0.0
            var x = 0f
            repeat(4000) {
                now += rnd.nextInt(0, 12)
                when (rnd.nextInt(100)) {
                    in 0..9 -> c.stylusDown(rnd.nextInt(3), x, 0f, now, now)
                    in 10..54 -> {
                        repeat(rnd.nextInt(1, 4)) { x += rnd.nextFloat() * 5; c.stylusMove(x, 0f, now) }
                        if (rnd.nextBoolean()) c.present(x + 3f, 0f) else c.present()
                    }
                    in 55..62 -> c.stylusUp(now)
                    in 63..64 -> c.stylusCancel(now)
                    in 65..74 -> c.begin(style, now)
                    in 75..82 -> c.end(false, now)
                    in 83..86 -> c.end(true, now)
                    in 87..98 -> {
                        now += rnd.nextInt(0, 400)
                        c.onTimer(now)
                    }
                    else -> c.reset()
                }
                if (c.shown) assertTrue("seed $seed: shown without a deadline", c.deadlineMs.isFinite())
                if (c.phase == InkTipController.Phase.IDLE) assertFalse("seed $seed: idle but shown", c.shown)
                if (rnd.nextInt(50) == 0) c.setOverlayOrigin(rnd.nextFloat() * 10, rnd.nextFloat() * 10)
            }
            c.stylusUp(now)
            repeat(3) {
                now += 1000
                c.onTimer(now)
            }
            assertFalse("seed $seed: ink left on the overlay", c.shown)
            if (out.renders.isNotEmpty()) assertSame("seed $seed", Op.Clear, out.last)
            assertTrue(out.renders.all { r -> r.frame.xy.all { it.isFinite() } })
        }
    }

    private companion object {
        const val POINTER = 3
    }
}
