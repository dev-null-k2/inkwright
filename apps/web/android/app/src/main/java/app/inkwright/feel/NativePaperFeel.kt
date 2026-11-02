package app.inkwright.feel

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.MotionEvent

/**
 * The native paper-feel engine (writing sound + haptic grain) for pen strokes.
 *
 * The web path pays for every sample twice: pointer events reach JS a frame or more after the pen
 * moved, then each grain tick crosses the bridge again and the sound comes out of WebAudio's deep
 * buffer. Here [MainActivity][app.inkwright.MainActivity] hands every MotionEvent over before the
 * WebView sees it; the stylus is read straight from them (historical samples included), and the
 * sound ([WritingSoundOutput]) and grain ([HapticGrainEngine]) are driven natively. The web layer
 * only says when a pen stroke starts and ends (InkwrightNative.feelBegin / feelEnd), because it is
 * the one that knows whether the pen is drawing, erasing, or doing something else.
 *
 * Threads: MotionEvents and the activity lifecycle arrive on the UI thread; plugin calls arrive on
 * the bridge thread and are posted to the UI thread, so all decisions ([StrokeFeelController]) run
 * on one thread. Every entry point returns immediately.
 *
 * Which pointers: the one stylus pointer that is down (TOOL_TYPE_STYLUS, or TOOL_TYPE_ERASER for
 * the eraser end); fingers are left to the web path. Positions are converted to millimetres with
 * the display's physical density so grain spacing and sound match the paper, not the pixel grid.
 */
class NativePaperFeel(context: Context, private val haptics: HapticGrainEngine) {
    private val main = Handler(Looper.getMainLooper())
    private val sound = WritingSoundOutput(context)
    private val controller = StrokeFeelController(object : FeelOutput {
        override fun configureSound(profile: FeelProfile, gain: Double) = sound.configure(profile, gain)
        override fun soundTap(pressure: Double) = sound.tap(pressure)
        override fun soundTarget(speedMmPerSec: Double, pressure: Double) = sound.target(speedMmPerSec, pressure)
        override fun soundSilence() = sound.silence()
        override fun hapticTick(intensity: Double) = haptics.grain(intensity.toFloat())
    })

    // UI thread only.
    private var prepared = false
    private var hostActive = true
    private var pxPerMmX = DEFAULT_PX_PER_MM
    private var pxPerMmY = DEFAULT_PX_PER_MM

    private val previewStep = object : Runnable {
        override fun run() {
            if (controller.stepPreview(SystemClock.uptimeMillis())) main.postDelayed(this, PREVIEW_STEP_MS)
        }
    }

    // ---- Input (UI thread) ----

    /** Every MotionEvent the activity dispatches; never consumes it and never throws. */
    fun onTouchEvent(event: MotionEvent, metrics: DisplayMetrics) {
        try {
            handle(event, metrics)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Paper feel skipped a touch event", e)
        }
    }

    private fun handle(e: MotionEvent, metrics: DisplayMetrics) {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                // ACTION_DOWN starts a new gesture: anything still tracked lost its lift.
                if (e.actionMasked == MotionEvent.ACTION_DOWN) controller.stylusUp()
                if (controller.isStylusDown) return // one stylus at a time
                val i = e.actionIndex
                if (!isStylus(e.getToolType(i))) return
                // Read per stroke: a fold/unfold or display move changes the panel under the pen.
                pxPerMmX = ScreenScale.pxPerMm(metrics.xdpi, metrics.densityDpi)
                pxPerMmY = ScreenScale.pxPerMm(metrics.ydpi, metrics.densityDpi)
                val downTime = if (e.actionMasked == MotionEvent.ACTION_DOWN) e.downTime else e.eventTime
                controller.stylusDown(e.getPointerId(i), e.getX(i) / pxPerMmX, e.getY(i) / pxPerMmY, timeMs(e), pressure(e.getPressure(i)), downTime)
            }
            MotionEvent.ACTION_MOVE -> feed(e)
            MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP -> {
                // Not fed: the stroke goes silent now anyway, and a pointer lifted by palm
                // rejection (FLAG_CANCELED) may carry a meaningless last position.
                if (e.getPointerId(e.actionIndex) == controller.trackedPointerId) controller.stylusUp()
            }
            MotionEvent.ACTION_CANCEL -> controller.stylusUp()
        }
    }

    /** Feeds the tracked stylus's samples in [e], historical (batched) ones first. */
    private fun feed(e: MotionEvent) {
        val id = controller.trackedPointerId
        if (id == StrokeFeelController.NO_POINTER) return
        val i = e.findPointerIndex(id)
        if (i < 0) return
        for (h in 0 until e.historySize) {
            controller.stylusMove(
                e.getHistoricalX(i, h) / pxPerMmX,
                e.getHistoricalY(i, h) / pxPerMmY,
                historicalTimeMs(e, h),
                pressure(e.getHistoricalPressure(i, h)),
            )
        }
        controller.stylusMove(e.getX(i) / pxPerMmX, e.getY(i) / pxPerMmY, timeMs(e), pressure(e.getPressure(i)))
    }

    // ---- Plugin calls (any thread; work is posted to the UI thread) ----

    fun begin(settings: FeelSettings, pressure: Double) = post {
        if (settings.soundOn && hostActive) sound.open() // lazily, if paused or never prepared
        controller.begin(settings, pressure, SystemClock.uptimeMillis())
    }

    fun end() = post { controller.end() }

    /** A note opened (true: open the stream now so the first stroke is instant) or closed (false). */
    fun prepare(active: Boolean) = post {
        prepared = active
        sound.prepared = active
        if (!active) {
            stopPreview()
            controller.end() // a note closed mid-stroke: no more grain or sound for that stroke
            sound.close()
        } else if (hostActive) {
            sound.open()
        }
    }

    fun preview(settings: FeelSettings) = post {
        if (settings.soundOn && hostActive) sound.open()
        main.removeCallbacks(previewStep)
        controller.startPreview(settings, SystemClock.uptimeMillis())
        if (controller.isPreviewing) main.postDelayed(previewStep, PREVIEW_STEP_MS)
    }

    // ---- Activity lifecycle (UI thread) ----

    /** Background: release the stream (another app may want the audio path); remember [prepared]. */
    fun onHostPause() {
        hostActive = false
        stopPreview()
        controller.end()
        sound.close()
    }

    fun onHostResume() {
        hostActive = true
        if (prepared) sound.open()
    }

    fun release() {
        main.removeCallbacksAndMessages(null)
        sound.close()
    }

    private fun stopPreview() {
        main.removeCallbacks(previewStep)
        controller.stopPreview()
    }

    private fun post(block: () -> Unit) {
        main.post {
            try {
                block()
            } catch (e: RuntimeException) {
                Log.w(TAG, "Paper feel call failed", e)
            }
        }
    }

    private companion object {
        const val TAG = "InkwrightFeel"
        const val PREVIEW_STEP_MS = 4L
        const val DEFAULT_PX_PER_MM = 160 / 25.4

        fun isStylus(toolType: Int) =
            toolType == MotionEvent.TOOL_TYPE_STYLUS || toolType == MotionEvent.TOOL_TYPE_ERASER

        fun pressure(p: Float): Double = if (p.isNaN()) -1.0 else p.toDouble().coerceIn(0.0, 1.0)

        /** Sample times in ms; nanosecond-based where available (API 34) so fast digitizers keep their spacing. */
        fun timeMs(e: MotionEvent): Double =
            if (Build.VERSION.SDK_INT >= 34) e.eventTimeNanos / 1e6 else e.eventTime.toDouble()

        fun historicalTimeMs(e: MotionEvent, h: Int): Double =
            if (Build.VERSION.SDK_INT >= 34) e.getHistoricalEventTimeNanos(h) / 1e6 else e.getHistoricalEventTime(h).toDouble()
    }
}
