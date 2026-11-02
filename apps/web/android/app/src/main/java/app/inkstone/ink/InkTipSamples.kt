package app.inkstone.ink

/**
 * The newest stylus samples (window px, uptime ms), kept in a fixed ring whether or not a tip is
 * armed. inkTipBegin travels through the WebView and the bridge and lands 10–20 ms after the pen
 * touched down; by then the samples it needs are already here, so the first tip frame is drawn at
 * once instead of waiting for the next MotionEvent.
 *
 * Each sample is tagged with the stylus stroke (one pen-down … lift) it belongs to, so a tail never
 * reaches back across a lift into the previous stroke. No Android types: JVM-tested. Not
 * thread-safe (UI thread only in the app).
 */
class InkTipSamples(val capacity: Int = DEFAULT_CAPACITY) {
    init {
        require(capacity >= 2) { "capacity must be at least 2" }
    }

    private val xs = FloatArray(capacity)
    private val ys = FloatArray(capacity)
    private val ts = DoubleArray(capacity)
    private val strokes = IntArray(capacity)
    private var next = 0 // slot the next sample goes into

    /** Samples held (at most [capacity]; the oldest are overwritten). */
    var size = 0
        private set

    fun add(stroke: Int, x: Float, y: Float, tMs: Double) {
        xs[next] = x
        ys[next] = y
        ts[next] = tMs
        strokes[next] = stroke
        next = (next + 1) % capacity
        if (size < capacity) size++
    }

    fun clear() {
        size = 0
        next = 0
    }

    /**
     * The tail of [stroke] as x,y pairs, oldest first: its samples within [tailMs] of its newest one
     * (never one from before that stroke's pen-down). When the stroke has an older sample outside the
     * window, the window's start is interpolated on the segment that crosses it, so the tail's length
     * glides with time instead of jumping by a whole sample spacing. Empty if [stroke] has no samples.
     */
    fun tail(stroke: Int, tailMs: Double): FloatArray {
        // Newest sample of the stroke (a newer stroke may already have started after it).
        var newest = -1
        var seen = 0
        var i = slotBefore(next)
        while (seen < size) {
            if (strokes[i] == stroke) {
                newest = i
                break
            }
            i = slotBefore(i)
            seen++
        }
        if (newest < 0) return EMPTY
        val cutoff = ts[newest] - tailMs

        // Walk back over the stroke's samples that are inside the window.
        var count = 0
        var boundary = -1 // the stroke's newest sample older than the window, if held
        i = newest
        while (seen < size && strokes[i] == stroke) {
            if (ts[i] < cutoff) {
                boundary = i
                break
            }
            count++
            seen++
            i = slotBefore(i)
        }

        var j = slotAfter(newest, -(count - 1)) // oldest sample inside the window
        val interpolate = boundary >= 0 && ts[j] > cutoff // a sample right on the cutoff needs no twin
        val out = FloatArray((count + if (interpolate) 1 else 0) * 2)
        var o = 0
        if (interpolate) {
            // ts[j] > cutoff > ts[boundary], so the span is positive.
            val f = ((cutoff - ts[boundary]) / (ts[j] - ts[boundary])).toFloat()
            out[o++] = xs[boundary] + (xs[j] - xs[boundary]) * f
            out[o++] = ys[boundary] + (ys[j] - ys[boundary]) * f
        }
        repeat(count) {
            out[o++] = xs[j]
            out[o++] = ys[j]
            j = slotAfter(j, 1)
        }
        return out
    }

    private fun slotBefore(slot: Int) = (slot - 1 + capacity) % capacity

    private fun slotAfter(slot: Int, steps: Int) = ((slot + steps) % capacity + capacity) % capacity

    companion object {
        /** ~0.5 s of a 500 Hz digitizer: far more than the longest tail ([InkTipStyle.MAX_TAIL_MS]). */
        const val DEFAULT_CAPACITY = 256

        private val EMPTY = FloatArray(0)
    }
}
