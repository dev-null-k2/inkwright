package app.inkwright.feel

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

/**
 * How the writing-sound stream is buffered. Every frame queued ahead of the DAC is latency between
 * the pen and its sound, so the stream is filled only [bufferFrames] deep: a whole number of the
 * device's native bursts (PROPERTY_OUTPUT_FRAMES_PER_BUFFER, the size the low-latency mixer pulls
 * at a time), aiming at ≤ [TARGET_MILLIS] in total but never fewer than two bursts — with one, the
 * mixer would find the buffer empty whenever the audio thread is a hair late, and the sound would
 * crackle.
 *
 * [capacityFrames] (what the stream allocates) is larger: on the fast path, if underruns show up the
 * buffer grows a burst at a time up to [maxBufferFrames]; when Android does not grant the fast
 * mixer (Bluetooth, some output effects, USB) or the route changes mid-session, the stream needs a
 * normal mixer period or more queued, so it uses up to the whole capacity — at least
 * [NORMAL_PATH_MILLIS] and twice the system minimum — without reopening the stream.
 * Pure, so the sizing is unit-tested.
 */
data class AudioBufferPlan(
    val sampleRate: Int,
    val burstFrames: Int,
    val bufferFrames: Int,
    val maxBufferFrames: Int,
    val capacityFrames: Int,
) {
    val bufferMillis: Double get() = bufferFrames * 1000.0 / sampleRate

    companion object {
        const val TARGET_MILLIS = 10.0
        const val NORMAL_PATH_MILLIS = 60.0
        const val DEFAULT_SAMPLE_RATE = 48_000

        /**
         * @param sampleRate PROPERTY_OUTPUT_SAMPLE_RATE (null or implausible → 48 kHz)
         * @param framesPerBurst PROPERTY_OUTPUT_FRAMES_PER_BUFFER (null or implausible → 5 ms)
         * @param minBufferFrames AudioTrack.getMinBufferSize in frames (≤ 0 when unknown)
         */
        fun plan(sampleRate: Int?, framesPerBurst: Int?, minBufferFrames: Int): AudioBufferPlan {
            val sr = resolveSampleRate(sampleRate)
            val burst = framesPerBurst?.takeIf { it in 16..8192 } ?: (sr / 200)
            val bursts = max(2, floor(TARGET_MILLIS * sr / 1000.0 / burst).toInt())
            val buffer = bursts * burst
            val maxBuffer = buffer + 2 * burst
            val minRounded = if (minBufferFrames > 0) (minBufferFrames + burst - 1) / burst * burst else 0
            val normalPath = (ceil(NORMAL_PATH_MILLIS * sr / 1000.0 / burst).toInt()) * burst
            return AudioBufferPlan(sr, burst, buffer, maxBuffer, maxOf(maxBuffer, 2 * minRounded, normalPath))
        }

        /** PROPERTY_OUTPUT_SAMPLE_RATE, or 48 kHz when it is missing or implausible. */
        fun resolveSampleRate(sampleRate: Int?): Int = sampleRate?.takeIf { it in 8_000..192_000 } ?: DEFAULT_SAMPLE_RATE
    }
}
