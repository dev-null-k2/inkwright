package app.inkwright.ink

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Where the tip goes: the transparent front-buffered overlay above the WebView. */
interface InkTipOutput {
    /** Show [frame] (overlay px), replacing whatever the overlay shows. */
    fun render(frame: InkTipFrame)

    /** Remove all ink from the overlay (back to fully transparent). */
    fun clear()
}

/** Colours as the web layer sends them, and the one the overlay is cleared to. */
object InkTipColor {
    /**
     * What every clear of the overlay writes. The overlay covers the whole WebView, so anything but
     * fully transparent here would hide the app; [isFullyTransparent] guards it (and a unit test
     * pins it).
     */
    const val CLEAR: Int = 0x00000000

    fun isFullyTransparent(argb: Int): Boolean = argb ushr 24 == 0

    fun isOpaque(argb: Int): Boolean = argb ushr 24 == 0xFF

    /**
     * `#AARRGGBB` (or `#RRGGBB`, opaque) → ARGB, or null for anything else. The same forms
     * @inkwright/core's parseArgb reads (so the tip has the colour the web ink has), but junk is
     * rejected instead of falling back to black: a tip in the wrong colour would be visible.
     */
    fun parse(s: String?): Int? {
        if (s == null) return null
        val hex = if (s.startsWith("#")) s.substring(1) else s
        if (hex.length != 8 && hex.length != 6) return null
        if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        val v = hex.toLong(16).toInt()
        return if (hex.length == 6) v or OPAQUE_ALPHA else v
    }

    private const val OPAQUE_ALPHA = 0xFF shl 24
}

/** How the armed stroke's tip is drawn (inkTipBegin), already in physical px. */
data class InkTipStyle(
    val argb: Int,
    val widthPx: Float,
    val tailMs: Double,
    /** The predicted point is never drawn further than this from the newest real sample. */
    val maxPredictionPx: Float,
) {
    companion object {
        const val DEFAULT_TAIL_MS = 40.0
        const val MAX_TAIL_MS = 120.0
        const val MIN_WIDTH_PX = 1f
        const val MAX_WIDTH_PX = 1024f

        /**
         * A prediction runs at most ~32 ms ahead (the predictor's cap); at a brisk 150 mm/s that is
         * under 5 mm, about 32 dp. Anything further is a bad guess the web ink would never cover.
         */
        const val MAX_PREDICTION_DP = 32f

        /**
         * inkTipBegin's arguments → style, or null when there is nothing safe to draw: an unparseable
         * colour, a width that is not a positive number, or a colour that is not fully opaque (the
         * tip overlaps the web ink for a moment, and over see-through ink that overlap would show
         * as a darker band; the web layer only arms opaque pens, this makes sure of it).
         *
         * [widthCssPx] is CSS px; [density] is physical px per CSS px (DisplayMetrics.density for
         * Capacitor's WebView at initial-scale 1). A missing or junk [tailMs] falls back to
         * [DEFAULT_TAIL_MS]; it is capped at [MAX_TAIL_MS], well within what [InkTipSamples] holds.
         */
        fun from(color: String?, widthCssPx: Double, tailMs: Double, density: Float): InkTipStyle? {
            val argb = InkTipColor.parse(color) ?: return null
            if (!InkTipColor.isOpaque(argb)) return null
            val scale = if (density.isFinite() && density > 0f) density else 1f
            val width = cssToPx(widthCssPx, scale) ?: return null
            val tail = if (tailMs.isFinite() && tailMs > 0) min(tailMs, MAX_TAIL_MS) else DEFAULT_TAIL_MS
            return InkTipStyle(argb, width, tail, MAX_PREDICTION_DP * scale)
        }

        /** CSS px → physical px, clamped to a drawable range; null unless a positive finite width. */
        fun cssToPx(widthCssPx: Double, density: Float): Float? {
            if (!widthCssPx.isFinite() || widthCssPx <= 0) return null
            return (widthCssPx * density).toFloat().coerceIn(MIN_WIDTH_PX, MAX_WIDTH_PX)
        }
    }
}

/** An axis-aligned box in overlay px. */
data class InkTipBounds(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val isEmpty: Boolean get() = !(right > left && bottom > top)

    fun union(o: InkTipBounds): InkTipBounds = when {
        isEmpty -> o
        o.isEmpty -> this
        else -> InkTipBounds(min(left, o.left), min(top, o.top), max(right, o.right), max(bottom, o.bottom))
    }

    companion object {
        val EMPTY = InkTipBounds(0f, 0f, 0f, 0f)
    }
}

/**
 * One immutable picture of the tip: a round-capped polyline through [xy] (x,y pairs, overlay px),
 * oldest first, in [argb] at [widthPx]. Handed from the UI thread to the render thread as is.
 */
class InkTipFrame(val xy: FloatArray, val argb: Int, val widthPx: Float) {
    val pointCount: Int get() = xy.size / 2
    val isEmpty: Boolean get() = xy.size < 2

    /**
     * Everything drawing this frame can touch: the points' box grown by half the width (round caps
     * and joins) plus [AA_MARGIN_PX] for anti-aliasing. The renderer clears this box when the next
     * frame replaces this one.
     */
    val bounds: InkTipBounds by lazy(LazyThreadSafetyMode.PUBLICATION) {
        if (isEmpty) return@lazy InkTipBounds.EMPTY
        var l = xy[0]; var t = xy[1]; var r = xy[0]; var b = xy[1]
        for (i in 2 until xy.size - 1 step 2) {
            l = min(l, xy[i]); r = max(r, xy[i])
            t = min(t, xy[i + 1]); b = max(b, xy[i + 1])
        }
        val g = widthPx / 2 + AA_MARGIN_PX
        InkTipBounds(l - g, t - g, r + g, b + g)
    }

    companion object {
        const val AA_MARGIN_PX = 2f
        val EMPTY = InkTipFrame(FloatArray(0), InkTipColor.CLEAR, 0f)
    }
}

/**
 * The decisions of the instant ink tip, kept free of Android types so they are unit tested on the
 * JVM ([NativeInkTip] adapts MotionEvents, the plugin calls, timers and the overlay around it).
 *
 * The WebView draws wet ink as soon as pointer events reach it, but presents it a frame or two
 * late. While a pen stroke is down, the newest [InkTipStyle.tailMs] of it (plus one predicted
 * point) is drawn natively on a front-buffered overlay straight from the stylus; the web ink
 * catches up underneath and covers it. The tip only ever shows those last few milliseconds, so a
 * small difference in shape from the web outline does not show.
 *
 * Phases:
 *  - [Phase.IDLE]: nothing armed; the overlay is clear.
 *  - [Phase.DRAWING]: armed (inkTipBegin) for the stroke that is down; each event redraws the tail.
 *  - [Phase.LIFTED]: the stylus lifted (final tail, no prediction) and inkTipEnd has not arrived;
 *    cleared anyway after [LIFT_FAILSAFE_MS].
 *  - [Phase.LINGER]: inkTipEnd(cancelled = false): the final tail stays [LINGER_MS] (the web ink is
 *    on screen by then), then clears.
 * inkTipEnd(cancelled = true) and ACTION_CANCEL clear at once. While drawing, a pen that stops
 * reporting for [REST_CLEAR_MS] has its tail cleared too (the next sample draws again), so ink is
 * never left on the overlay: whenever anything is shown, [deadlineMs] is finite.
 *
 * Coordinates come in as window px (Activity.dispatchTouchEvent) and go out as overlay px, offset by
 * [setOverlayOrigin]. Times are uptime ms (MotionEvent times and SystemClock.uptimeMillis share that
 * clock). Not thread-safe: use from one thread (the UI thread in the app).
 */
class InkTipController(private val out: InkTipOutput, capacity: Int = InkTipSamples.DEFAULT_CAPACITY) {
    enum class Phase { IDLE, DRAWING, LIFTED, LINGER }

    var phase = Phase.IDLE
        private set

    // --- The stylus pointer currently down (tracked whether or not a tip is armed). ---
    private val samples = InkTipSamples(capacity)
    var trackedPointerId = NO_POINTER
        private set
    val isStylusDown: Boolean get() = trackedPointerId != NO_POINTER
    private var stroke = 0 // the current (or last) stylus stroke; samples are tagged with it
    private var lastSampleMs = 0.0

    // --- The armed tip. ---
    private var armedStroke = NO_STROKE
    private var style: InkTipStyle? = null
    private var phaseSinceMs = 0.0

    /** Whether the overlay currently has ink on it (a render since the last clear). */
    var shown = false
        private set

    private var originX = 0f
    private var originY = 0f

    /** Whether the adapter should compute a prediction for [present] (only while drawing). */
    val wantsPrediction: Boolean get() = phase == Phase.DRAWING && isStylusDown

    /** The overlay's top-left in window px; samples and predictions are drawn relative to it. */
    fun setOverlayOrigin(x: Float, y: Float) {
        originX = x
        originY = y
    }

    /** A stylus pointer touched down (window px). */
    fun stylusDown(pointerId: Int, x: Float, y: Float, tMs: Double, nowMs: Double) {
        if (isStylusDown) stylusUp(nowMs) // a lift we never saw
        stroke++
        trackedPointerId = pointerId
        addSample(x, y, tMs)
    }

    /** One sample of the tracked stylus (window px); call for historical samples too, oldest first. */
    fun stylusMove(x: Float, y: Float, tMs: Double) {
        if (isStylusDown) addSample(x, y, tMs)
    }

    /**
     * The samples of one MotionEvent are in: redraw the tail if drawing. [predictedX]/[predictedY]
     * (window px, NaN for none) add one predicted point at the nib's end.
     */
    fun present(predictedX: Float = Float.NaN, predictedY: Float = Float.NaN) {
        if (wantsPrediction) draw(predictedX, predictedY)
    }

    /** The tracked stylus lifted: stop extending and drop the guess (the stroke ends where the pen did). */
    fun stylusUp(nowMs: Double) {
        if (!isStylusDown) return
        trackedPointerId = NO_POINTER
        if (phase != Phase.DRAWING) return
        if (shown) draw()
        enter(Phase.LIFTED, nowMs)
    }

    /** ACTION_CANCEL, or a pointer lifted as cancelled (palm rejection): this stroke's tip goes now. */
    fun stylusCancel(nowMs: Double) {
        if (!isStylusDown) return
        trackedPointerId = NO_POINTER
        if (phase != Phase.DRAWING) return
        clearNow()
        enter(Phase.IDLE, nowMs)
    }

    /**
     * inkTipBegin: draw the stroke that is down with [style], starting right away from the samples
     * already seen since its pen-down. Ignored when no stylus is down (a quick tap that lifted before
     * the call got here: the web layer draws it whole).
     */
    fun begin(style: InkTipStyle, nowMs: Double, predictedX: Float = Float.NaN, predictedY: Float = Float.NaN) {
        if (!isStylusDown) return
        this.style = style
        armedStroke = stroke
        enter(Phase.DRAWING, nowMs)
        draw(predictedX, predictedY)
    }

    /** inkTipEnd: [cancelled] clears now; otherwise the final tail lingers [LINGER_MS], then clears. */
    fun end(cancelled: Boolean, nowMs: Double) {
        if (cancelled) {
            clearNow()
            enter(Phase.IDLE, nowMs)
            return
        }
        when (phase) {
            Phase.DRAWING -> {
                // Ended while the pen is still down (a gesture took over): stop extending, drop the guess.
                if (shown) draw()
                enter(Phase.LINGER, nowMs)
            }
            Phase.LIFTED -> enter(Phase.LINGER, nowMs)
            Phase.LINGER, Phase.IDLE -> {}
        }
    }

    /** When [onTimer] must next run, uptime ms; [NO_DEADLINE] if nothing is pending. */
    val deadlineMs: Double
        get() = when (phase) {
            Phase.IDLE -> NO_DEADLINE
            Phase.DRAWING -> if (shown) lastSampleMs + REST_CLEAR_MS else NO_DEADLINE
            Phase.LIFTED -> phaseSinceMs + LIFT_FAILSAFE_MS
            Phase.LINGER -> phaseSinceMs + LINGER_MS
        }

    /** Timer tick: clears whatever has outstayed its time. Harmless to call early or often. */
    fun onTimer(nowMs: Double) {
        if (nowMs < deadlineMs) return
        when (phase) {
            Phase.DRAWING -> clearNow() // the pen rests; the next sample draws again
            Phase.LIFTED, Phase.LINGER -> {
                clearNow()
                enter(Phase.IDLE, nowMs)
            }
            Phase.IDLE -> {}
        }
    }

    /**
     * Forget everything (overlay detached, resized or moved): clears the overlay if needed, disarms,
     * and stops tracking the stylus, so the rest of a stroke in progress is left to the web ink.
     */
    fun reset() {
        clearNow()
        phase = Phase.IDLE
        armedStroke = NO_STROKE
        style = null
        trackedPointerId = NO_POINTER
        samples.clear()
    }

    private fun addSample(x: Float, y: Float, tMs: Double) {
        samples.add(stroke, x, y, tMs)
        lastSampleMs = tMs
    }

    private fun enter(p: Phase, nowMs: Double) {
        phase = p
        phaseSinceMs = nowMs
        if (p == Phase.IDLE) {
            armedStroke = NO_STROKE
            style = null
        }
    }

    private fun clearNow() {
        if (!shown) return
        shown = false
        out.clear()
    }

    private fun draw(predictedX: Float = Float.NaN, predictedY: Float = Float.NaN) {
        val s = style ?: return
        val tail = samples.tail(armedStroke, s.tailMs)
        if (tail.size < 2) return
        val predicted = predictedX.isFinite() && predictedY.isFinite()
        val xy = if (predicted) tail.copyOf(tail.size + 2) else tail
        if (predicted) {
            // Clamp the guess to a plausible reach from the newest real sample.
            val nx = tail[tail.size - 2]
            val ny = tail[tail.size - 1]
            var dx = predictedX - nx
            var dy = predictedY - ny
            val d = hypot(dx, dy)
            if (d > s.maxPredictionPx) {
                val k = s.maxPredictionPx / d
                dx *= k
                dy *= k
            }
            xy[xy.size - 2] = nx + dx
            xy[xy.size - 1] = ny + dy
        }
        for (i in xy.indices step 2) {
            xy[i] -= originX
            xy[i + 1] -= originY
        }
        out.render(InkTipFrame(xy, s.argb, s.widthPx))
        shown = true
    }

    companion object {
        const val NO_POINTER = -1
        private const val NO_STROKE = -1
        const val NO_DEADLINE = Double.POSITIVE_INFINITY

        /** After a non-cancelled end, the final tail stays this long: the web ink is on screen by then. */
        const val LINGER_MS = 60.0

        /** The stylus lifted and no inkTipEnd came: clear anyway after this. */
        const val LIFT_FAILSAFE_MS = 300.0

        /** While down, a pen that reports nothing for this long has its (long covered) tail cleared. */
        const val REST_CLEAR_MS = 150.0
    }
}
