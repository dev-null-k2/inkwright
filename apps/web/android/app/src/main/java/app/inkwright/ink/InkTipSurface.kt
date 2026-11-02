package app.inkwright.ink

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.os.Build
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.annotation.RequiresApi
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer
import androidx.graphics.surface.SurfaceControlCompat
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** What [NativeInkTip] needs of the overlay ([InkTipSurface], Android 10+ only). UI thread. */
internal interface InkTipOverlay : InkTipOutput {
    val view: View

    /** Whether the surface exists at a usable size, so renders reach the screen. */
    val isReady: Boolean

    /** Adds the overlay to [parent] at [index] (right after the WebView), filling it. */
    fun attach(parent: ViewGroup, index: Int)

    /** Releases the renderer and removes the view (which destroys the surface and its layers). */
    fun release()
}

/**
 * The ink tip's overlay: a transparent SurfaceView above the WebView, drawn with androidx.graphics'
 * [CanvasFrontBufferedRenderer] (Android 10+). Front-buffered means the tip is drawn into the buffer
 * the display is scanning out, not queued behind the frames the WebView is producing, so it lands
 * on the glass within a few ms of the MotionEvent.
 *
 * Above all it must never cover the app:
 *  - The surface is TRANSLUCENT and z-ordered on top of the window (setZOrderOnTop). On top, the
 *    SurfaceView punches no hole in the window and shows no opaque background layer (Android only
 *    adds that black layer for opaque surfaces placed below the window). Its own BufferQueue never
 *    gets a buffer; the renderer draws into child SurfaceControls.
 *  - Only the front-buffered layer is used. A clear is an ordinary render of nothing, whose
 *    completion hook hides the layer again (the library re-shows it after every render). The multi-buffered layer is never given a buffer (no commit, no
 *    clear, no redraw-on-resize), so no full-screen layer is composited while the pen is idle.
 *  - The first render after the surface is created or resized, and after every clear, fully clears
 *    the front buffer to [InkTipColor.CLEAR] before drawing (the library only does that once per
 *    renderer, and a resized buffer starts undefined). Other renders clear only the box the previous
 *    tail covered plus the new one.
 *  - Every surface callback the renderer registers runs inside a guard ([GuardedSurfaceHolder]); an
 *    exception there or on the render thread reports [Listener.onFailure], and the owner removes the
 *    overlay. The view never takes touches, focus or accessibility.
 *
 * UI thread, except the draw callbacks (render thread) and [Listener.onFailure] (either thread).
 */
@RequiresApi(Build.VERSION_CODES.Q)
internal class InkTipSurface(context: Context, private val listener: Listener) : InkTipOverlay {
    interface Listener {
        /** The surface is ready at a new size (created, resized, rotated, folded). UI thread. */
        fun onSurfaceChanged()

        /** The surface went away (window hidden or view detached). UI thread. */
        fun onSurfaceDestroyed()

        /** The renderer or surface threw; the overlay must be removed. Any thread. */
        fun onFailure(e: Throwable)
    }

    private val broken = AtomicBoolean(false)
    override val view = OverlayView(context) { fail(it) }

    /** The newest frame; the render thread always draws this one (stale queued frames are skipped). */
    private val latest = AtomicReference(InkTipFrame.EMPTY)
    private val fullClearPending = AtomicBoolean(true)
    private val renderer: CanvasFrontBufferedRenderer<Unit>

    override var isReady = false
        private set

    init {
        require(InkTipColor.isFullyTransparent(InkTipColor.CLEAR)) { "Ink tip clear colour must be transparent" }
        // Registered before ours, so in surfaceChanged the renderer has rebuilt its layers first.
        renderer = CanvasFrontBufferedRenderer(view, Painter())
        view.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {}

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                if (broken.get()) return
                isReady = width > 0 && height > 0
                clear() // new buffers start undefined: clear, and hide the front layer until drawn
                listener.onSurfaceChanged()
            }

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                isReady = false
                listener.onSurfaceDestroyed()
            }
        })
    }

    override fun attach(parent: ViewGroup, index: Int) {
        parent.addView(view, index, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    override fun render(frame: InkTipFrame) {
        if (!isReady || broken.get() || !renderer.isValid()) return
        latest.set(frame)
        renderer.renderFrontBufferedLayer(Unit)
    }

    override fun clear() {
        latest.set(InkTipFrame.EMPTY)
        fullClearPending.set(true)
        // Through the normal render path (not cancel()): the pass wipes the buffer to transparent and
        // its completion hook hides the layer, so an idle note composites nothing extra.
        if (isReady && !broken.get() && renderer.isValid()) renderer.renderFrontBufferedLayer(Unit)
    }

    override fun release() {
        isReady = false
        latest.set(InkTipFrame.EMPTY)
        try {
            renderer.release(true)
        } finally {
            (view.parent as? ViewGroup)?.removeView(view)
        }
    }

    private fun fail(e: Throwable) {
        if (broken.compareAndSet(false, true)) listener.onFailure(e)
    }

    /** Draw callbacks, on the renderer's thread. */
    private inner class Painter : CanvasFrontBufferedRenderer.Callback<Unit> {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val path = Path()
        private var drawn: InkTipFrame? = null
        private var drawnBounds = InkTipBounds.EMPTY

        override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: Unit) {
            try {
                if (fullClearPending.getAndSet(false)) {
                    canvas.drawColor(InkTipColor.CLEAR, BlendMode.SRC)
                    drawn = null
                    drawnBounds = InkTipBounds.EMPTY
                }
                val frame = latest.get()
                if (frame === drawn) return // several queued requests merged into one pass
                val bounds = frame.bounds
                val dirty = drawnBounds.union(bounds)
                if (!dirty.isEmpty) {
                    canvas.save()
                    canvas.clipRect(dirty.left, dirty.top, dirty.right, dirty.bottom)
                    canvas.drawColor(InkTipColor.CLEAR, BlendMode.SRC)
                    drawFrame(canvas, frame)
                    canvas.restore()
                }
                drawn = frame
                drawnBounds = bounds
            } catch (e: RuntimeException) {
                fail(e)
            }
        }

        /**
         * The library makes the front layer visible after every render; hide it again when what was
         * just drawn is nothing, so a cleared tip costs no composition at 120+ Hz.
         */
        override fun onFrontBufferedLayerRenderComplete(frontBufferedLayerSurfaceControl: SurfaceControlCompat, transaction: SurfaceControlCompat.Transaction) {
            try {
                val shown = drawn
                transaction.setVisibility(frontBufferedLayerSurfaceControl, shown != null && !shown.isEmpty)
            } catch (e: RuntimeException) {
                fail(e)
            }
        }

        override fun onDrawMultiBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, params: Collection<Unit>) {
            // Never requested (no commit/clear); if the library ever asks, it gets transparency.
            canvas.drawColor(InkTipColor.CLEAR, BlendMode.SRC)
        }

        private fun drawFrame(canvas: Canvas, frame: InkTipFrame) {
            if (frame.isEmpty) return
            paint.color = frame.argb
            paint.strokeWidth = frame.widthPx
            val xy = frame.xy
            if (frame.pointCount == 1) {
                canvas.drawPoint(xy[0], xy[1], paint) // a round-capped dot
                return
            }
            path.rewind()
            path.moveTo(xy[0], xy[1])
            for (i in 2 until xy.size - 1 step 2) path.lineTo(xy[i], xy[i + 1])
            canvas.drawPath(path, paint)
        }
    }

    /**
     * The SurfaceView itself: translucent, on top, and inert. It returns false from every pointer
     * dispatch so touches, stylus and hover all fall through to the WebView below it (the activity
     * reads the stylus before dispatch anyway).
     */
    @SuppressLint("ViewConstructor")
    class OverlayView(context: Context, onCallbackFailure: (Throwable) -> Unit) : SurfaceView(context) {
        /** Null only while SurfaceView's own constructor runs (should it ask for the holder). */
        private var guarded: SurfaceHolder? = null

        init {
            guarded = GuardedSurfaceHolder(super.getHolder(), onCallbackFailure)
            super.getHolder().setFormat(PixelFormat.TRANSLUCENT)
            setZOrderOnTop(true) // above the window: no hole punched in the WebView, no black backdrop
            isClickable = false
            isLongClickable = false
            isFocusable = false
            isFocusableInTouchMode = false
            isSoundEffectsEnabled = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }

        /** Everyone (the renderer included) registers surface callbacks through the guard. */
        override fun getHolder(): SurfaceHolder = guarded ?: super.getHolder()

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(event: MotionEvent): Boolean = false

        override fun dispatchTouchEvent(event: MotionEvent): Boolean = false

        override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean = false

        override fun dispatchHoverEvent(event: MotionEvent): Boolean = false
    }
}

/**
 * Wraps a SurfaceView's holder so every callback registered through it runs inside try/catch.
 * The renderer's surface callbacks build SurfaceControls and buffers on the UI thread, inside the
 * SurfaceView's own dispatch; an exception there would crash the app, where a missing ink tip is
 * merely slower ink. Failures go to [onFailure] instead.
 *
 * The wrappers are plain [SurfaceHolder.Callback]s even when the callback is a Callback2: the only
 * Callback2 work the renderer does is redraw its multi-buffered layer on resize (a full-screen
 * buffer the tip never uses), and a redraw callback that failed to report back would stall the
 * window's next draw.
 */
internal class GuardedSurfaceHolder(
    private val real: SurfaceHolder,
    private val onFailure: (Throwable) -> Unit,
) : SurfaceHolder by real {
    private val guards = HashMap<SurfaceHolder.Callback, SurfaceHolder.Callback>()

    override fun addCallback(callback: SurfaceHolder.Callback) {
        val guard = synchronized(guards) {
            if (guards.containsKey(callback)) return
            Guard(callback).also { guards[callback] = it }
        }
        real.addCallback(guard)
    }

    override fun removeCallback(callback: SurfaceHolder.Callback) {
        val guard = synchronized(guards) { guards.remove(callback) } ?: return
        real.removeCallback(guard)
    }

    // A Java default method: forwarded explicitly so it reaches the real holder.
    override fun lockHardwareCanvas(): Canvas = real.lockHardwareCanvas()

    private inner class Guard(private val inner: SurfaceHolder.Callback) : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) = guard { inner.surfaceCreated(holder) }

        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) =
            guard { inner.surfaceChanged(holder, format, width, height) }

        override fun surfaceDestroyed(holder: SurfaceHolder) = guard { inner.surfaceDestroyed(holder) }
    }

    private inline fun guard(block: () -> Unit) {
        try {
            block()
        } catch (e: RuntimeException) {
            onFailure(e)
        } catch (e: LinkageError) { // e.g. the renderer's native library failed to load
            onFailure(e)
        }
    }
}
