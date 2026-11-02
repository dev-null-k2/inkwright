package app.inkstone.ink

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.input.motionprediction.MotionEventPredictor
import kotlin.math.ceil

/**
 * The instant ink tip (InkstoneNative.inkTip*): while a pen stroke is down, its newest ~40 ms are
 * drawn natively on a transparent front-buffered overlay above the WebView, straight from the
 * stylus's MotionEvents, so the ink keeps up with the nib although the WebView presents its wet ink
 * a frame or two late. The web ink catches up underneath and covers it.
 *
 * Split like the paper feel: [InkTipController] makes every decision (JVM-tested); this class adapts
 * Android around it. [MainActivity][app.inkstone.MainActivity] hands every MotionEvent over before
 * the WebView sees it (read-only, never consumed); stylus samples (TOOL_TYPE_STYLUS only, between
 * its down and up, historical samples included) go into the controller's ring buffer whether or
 * not a tip is armed, so inkTipBegin can draw at once. One point predicted by androidx.input's
 * [MotionEventPredictor] (the platform predictor on Android 14+, a Kalman filter before) extends
 * the tip to where the nib is about to be.
 *
 * The overlay ([InkTipSurface]) exists only while a note is open (inkTipPrepare) and the activity
 * is in front; it is released on pause and comes back on resume. Android 10+ only (the front-
 * buffered renderer needs SurfaceControl); below that, or after the overlay failed once, every call
 * is a no-op and [isSupported] is false, so the web layer stops asking.
 *
 * Threads: MotionEvents, the lifecycle and the overlay's surface callbacks arrive on the UI thread;
 * plugin calls arrive on the bridge thread and are posted to it, so the controller runs on one
 * thread. Every entry point returns immediately and never throws.
 */
class NativeInkTip(private val webView: () -> View?) {
    private val main = Handler(Looper.getMainLooper())
    private val controller = InkTipController(object : InkTipOutput {
        override fun render(frame: InkTipFrame) {
            overlay?.render(frame)
        }

        override fun clear() {
            overlay?.clear()
        }
    })

    // UI thread only.
    private var overlay: InkTipOverlay? = null
    private var wanted = false // a note is open (inkTipPrepare(true))
    private var hostActive = true
    private var predictor: MotionEventPredictor? = null
    private var predictorInSync = false // fed every event since an ACTION_DOWN, without error
    private var predictedX = Float.NaN
    private var predictedY = Float.NaN
    private val location = IntArray(2)
    private val waiters = ArrayList<(Boolean) -> Unit>()
    private var tickAt = InkTipController.NO_DEADLINE

    /** Set once the overlay failed; read by capabilities() on the bridge thread. */
    @Volatile private var failed = false

    /** Android 10+ and the overlay has not failed on this device. */
    val isSupported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !failed

    private val tick = Runnable {
        tickAt = InkTipController.NO_DEADLINE
        try {
            controller.onTimer(now())
        } catch (e: RuntimeException) {
            Log.w(TAG, "Ink tip timer failed", e)
        }
        reschedule()
    }

    private val settleWaitersRunnable = Runnable { settleWaiters() }

    private val surfaceListener = object : InkTipSurface.Listener {
        override fun onSurfaceChanged() {
            // Created, resized, rotated or folded: a stroke in progress is left to the web ink.
            controller.reset()
            reschedule()
            settleWaiters()
        }

        override fun onSurfaceDestroyed() {
            controller.reset()
        }

        override fun onFailure(e: Throwable) {
            main.post { fail(e) }
        }
    }

    private val layoutListener = View.OnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
        if (l != ol || t != ot || r != or || b != ob) {
            controller.reset() // the tail would no longer line up with the ink under it
            reschedule()
        }
    }

    // ---- Input (UI thread) ----

    /** Every MotionEvent the activity dispatches; never consumes it and never throws. */
    fun onTouchEvent(event: MotionEvent) {
        if (overlay == null) return
        try {
            handle(event)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Ink tip skipped a touch event", e)
        }
    }

    private fun handle(e: MotionEvent) {
        record(e)
        val now = now()
        try {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                    // ACTION_DOWN starts a new gesture: anything still tracked lost its lift.
                    if (e.actionMasked == MotionEvent.ACTION_DOWN) controller.stylusUp(now)
                    val i = e.actionIndex
                    // One stylus at a time; the eraser end, fingers and mice are not ink.
                    if (!controller.isStylusDown && e.getToolType(i) == MotionEvent.TOOL_TYPE_STYLUS) {
                        updateOrigin()
                        controller.stylusDown(e.getPointerId(i), e.getX(i), e.getY(i), timeMs(e), now)
                    }
                }
                MotionEvent.ACTION_MOVE -> if (feed(e)) present()
                MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP -> {
                    // Not fed: a pointer lifted by palm rejection may carry a meaningless last position.
                    if (e.getPointerId(e.actionIndex) == controller.trackedPointerId) {
                        if (isCanceled(e)) controller.stylusCancel(now) else controller.stylusUp(now)
                    }
                }
                MotionEvent.ACTION_CANCEL -> controller.stylusCancel(now)
            }
        } finally {
            reschedule()
        }
    }

    /** Feeds the tracked stylus's samples in [e], historical (batched) ones first; false if it has none. */
    private fun feed(e: MotionEvent): Boolean {
        val id = controller.trackedPointerId
        if (id == InkTipController.NO_POINTER) return false
        val i = e.findPointerIndex(id)
        if (i < 0) return false
        for (h in 0 until e.historySize) {
            controller.stylusMove(e.getHistoricalX(i, h), e.getHistoricalY(i, h), historicalTimeMs(e, h))
        }
        controller.stylusMove(e.getX(i), e.getY(i), timeMs(e))
        return true
    }

    private fun present() {
        if (!controller.wantsPrediction) return
        predict()
        controller.present(predictedX, predictedY)
    }

    /** Event coordinates are window px; the overlay draws relative to its own top-left. */
    private fun updateOrigin() {
        val v = overlay?.view ?: return
        v.getLocationInWindow(location)
        controller.setOverlayOrigin(location[0].toFloat(), location[1].toFloat())
    }

    // ---- Motion prediction (UI thread) ----

    /** Every event goes to the predictor (it needs a consistent stream), from an ACTION_DOWN on. */
    private fun record(e: MotionEvent) {
        val p = predictor ?: return
        if (e.actionMasked == MotionEvent.ACTION_DOWN) predictorInSync = true
        if (!predictorInSync) return
        try {
            p.record(e)
        } catch (ex: RuntimeException) {
            // An inconsistent stream (e.g. attached mid-gesture): no prediction until the next gesture.
            predictorInSync = false
        }
    }

    /** One predicted position of the tracked stylus (window px) into [predictedX]/[predictedY], or NaN. */
    private fun predict() {
        predictedX = Float.NaN
        predictedY = Float.NaN
        val p = predictor ?: return
        val id = controller.trackedPointerId
        if (!predictorInSync || id == InkTipController.NO_POINTER) return
        val ev = try {
            p.predict()
        } catch (ex: RuntimeException) {
            null
        } ?: return
        try {
            val i = ev.findPointerIndex(id)
            if (i >= 0) {
                predictedX = ev.getX(i)
                predictedY = ev.getY(i)
            }
        } finally {
            ev.recycle()
        }
    }

    // ---- Plugin calls (any thread; work is posted to the UI thread) ----

    /**
     * A note opened (true: attach the overlay) or closed (false: release it). [onResult] gets whether
     * the tip is supported, once the overlay's surface is ready, has failed, or [READY_TIMEOUT_MS]
     * passed, whichever comes first. It is always called.
     */
    fun prepare(active: Boolean, onResult: (Boolean) -> Unit) {
        main.post {
            try {
                wanted = active
                if (!active) {
                    detach()
                    onResult(isSupported)
                    return@post
                }
                if (hostActive) attach()
                val o = overlay
                when {
                    !isSupported -> onResult(false)
                    !hostActive || o?.isReady == true -> onResult(true) // in the background it attaches on resume
                    o == null -> onResult(false) // no WebView to sit above
                    else -> {
                        waiters += onResult
                        main.removeCallbacks(settleWaitersRunnable)
                        main.postDelayed(settleWaitersRunnable, READY_TIMEOUT_MS)
                    }
                }
            } catch (e: RuntimeException) {
                Log.w(TAG, "inkTipPrepare failed", e)
                onResult(false)
            }
        }
    }

    /** inkTipBegin: [color] "#AARRGGBB", [widthCssPx] CSS px, [tailMs] the window of samples to draw. */
    fun begin(color: String?, widthCssPx: Double, tailMs: Double) = post {
        val o = overlay ?: return@post
        if (!o.isReady) return@post
        // CSS px → physical px: Capacitor's WebView is at initial-scale 1, so the scale is the density.
        val density = o.view.resources.displayMetrics.density
        val style = InkTipStyle.from(color, widthCssPx, tailMs, density)
        if (style == null) {
            Log.w(TAG, "inkTipBegin ignored: color=$color widthPx=$widthCssPx")
            return@post
        }
        if (controller.isStylusDown) predict()
        controller.begin(style, now(), predictedX, predictedY)
        reschedule()
    }

    /** inkTipEnd: [cancelled] clears now; otherwise the final tail lingers briefly, then clears. */
    fun end(cancelled: Boolean) = post {
        controller.end(cancelled, now())
        reschedule()
    }

    // ---- Activity lifecycle (UI thread) ----

    /** Background: release the overlay (and its surface and render thread); [wanted] is kept. */
    fun onHostPause() {
        hostActive = false
        detach()
    }

    fun onHostResume() {
        hostActive = true
        if (wanted) attach()
    }

    fun release() {
        wanted = false
        detach()
        main.removeCallbacksAndMessages(null)
    }

    // ---- Overlay ----

    private fun attach() {
        if (overlay != null || !isSupported || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val web = webView() ?: return
        val parent = web.parent as? ViewGroup ?: return
        try {
            val o = InkTipSurface(web.context, surfaceListener)
            overlay = o
            o.attach(parent, parent.indexOfChild(web) + 1) // after the WebView: drawn above it
            o.view.addOnLayoutChangeListener(layoutListener)
        } catch (e: RuntimeException) {
            fail(e)
            return
        } catch (e: LinkageError) {
            fail(e)
            return
        }
        predictor = try {
            MotionEventPredictor.newInstance(web)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Motion prediction unavailable", e)
            null
        }
        predictorInSync = false
    }

    private fun detach() {
        controller.reset()
        main.removeCallbacks(tick)
        tickAt = InkTipController.NO_DEADLINE
        predictor = null
        predictorInSync = false
        val o = overlay
        overlay = null
        if (o != null) {
            o.view.removeOnLayoutChangeListener(layoutListener)
            try {
                o.release()
            } catch (e: RuntimeException) {
                Log.w(TAG, "Ink tip overlay release failed", e)
            }
        }
        settleWaiters()
    }

    /** The overlay threw: remove it for good (ink stays on the web path) and report unsupported. */
    private fun fail(e: Throwable) {
        Log.e(TAG, "Ink tip overlay failed; removing it", e)
        failed = true
        detach()
    }

    private fun settleWaiters() {
        main.removeCallbacks(settleWaitersRunnable)
        if (waiters.isEmpty()) return
        val supported = isSupported
        val pending = waiters.toList()
        waiters.clear()
        pending.forEach { it(supported) }
    }

    /**
     * Keeps one timer posted for the controller's next deadline. Deadlines move later with every
     * sample while drawing, so the timer is only moved earlier; when it fires late it re-arms.
     */
    private fun reschedule() {
        val d = controller.deadlineMs
        if (d == InkTipController.NO_DEADLINE) return
        if (tickAt != InkTipController.NO_DEADLINE && tickAt <= d) return
        main.removeCallbacks(tick)
        tickAt = d
        main.postAtTime(tick, ceil(d).toLong())
    }

    private fun post(block: () -> Unit) {
        main.post {
            try {
                block()
            } catch (e: RuntimeException) {
                Log.w(TAG, "Ink tip call failed", e)
            }
        }
    }

    private companion object {
        const val TAG = "InkstoneInkTip"

        /** inkTipPrepare answers by then even if the surface has not been created yet. */
        const val READY_TIMEOUT_MS = 500L

        fun now(): Double = SystemClock.uptimeMillis().toDouble()

        /** Lifted as cancelled (palm rejection, Android 13+): the stroke is void. */
        fun isCanceled(e: MotionEvent): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && (e.flags and MotionEvent.FLAG_CANCELED) != 0

        /** Sample times in uptime ms; nanosecond-based where available (API 34) so fast digitizers keep their spacing. */
        fun timeMs(e: MotionEvent): Double =
            if (Build.VERSION.SDK_INT >= 34) e.eventTimeNanos / 1e6 else e.eventTime.toDouble()

        fun historicalTimeMs(e: MotionEvent, h: Int): Double =
            if (Build.VERSION.SDK_INT >= 34) e.getHistoricalEventTimeNanos(h) / 1e6 else e.getHistoricalEventTime(h).toDouble()
    }
}
