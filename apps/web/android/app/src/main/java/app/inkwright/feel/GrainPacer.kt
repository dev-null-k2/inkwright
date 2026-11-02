package app.inkwright.feel

/**
 * Keeps haptic grain honest about time. Ticks are requested from JavaScript and travel through
 * the Capacitor bridge, which can deliver them in bursts; a tick that plays late no longer lines
 * up with the pen and reads as noise, and ticks closer together than the actuator can render
 * just cancel each other. So, on the haptics thread, each tick is admitted only if it is still
 * fresh and far enough from the previous one.
 *
 * Pure (times are passed in, in nanoseconds) so it is unit-testable; not thread-safe — use from
 * the single haptics thread.
 */
class GrainPacer(
    private val minIntervalNanos: Long = 5_000_000L, // 200 Hz ceiling; JS already caps at ~140 Hz
    private val maxLatencyNanos: Long = 40_000_000L, // older than 40 ms → drop
) {
    private var lastPlayed = Long.MIN_VALUE
    private var hasPlayed = false

    /** @param requestedAt when the tick was requested; @param now when it would play. */
    fun admit(requestedAt: Long, now: Long): Boolean {
        if (now - requestedAt > maxLatencyNanos) return false
        if (hasPlayed && now - lastPlayed < minIntervalNanos) return false
        lastPlayed = now
        hasPlayed = true
        return true
    }

    fun reset() {
        hasPlayed = false
        lastPlayed = Long.MIN_VALUE
    }
}

/** Maps a 0..1 grain intensity onto a small table so haptic effects can be built once and reused. */
object GrainLevels {
    const val STEPS = 32

    fun level(intensity: Float): Int {
        if (intensity.isNaN()) return 0
        val clamped = intensity.coerceIn(0f, 1f)
        return Math.round(clamped * STEPS)
    }

    fun scale(level: Int): Float = level.coerceIn(0, STEPS).toFloat() / STEPS
}
