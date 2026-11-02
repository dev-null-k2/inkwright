package app.inkwright.feel

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioRouting
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Process
import android.util.Log
import java.util.Locale
import java.util.concurrent.locks.LockSupport
import kotlin.math.min

/**
 * The writing sound: a [ScratchSynth] rendered on a dedicated audio thread into a low-latency,
 * mono, float [AudioTrack].
 *
 * Why native: WebAudio in the WebView sits behind a large output buffer, so the sound trailed the
 * pen. This stream asks for the fast mixer (PERFORMANCE_MODE_LOW_LATENCY) and is filled only about
 * 10 ms deep (see [AudioBufferPlan]); its targets come straight from MotionEvents.
 *
 * It plays as USAGE_GAME — the media volume, like the WebAudio sound it replaces, and not muted by
 * the ringer — with CONTENT_TYPE_SONIFICATION, and never requests audio focus: it mixes over
 * whatever else is playing.
 *
 * Threads: [open], [close], [configure], [tap], [target] and [silence] are called from one thread
 * (the UI thread). They publish into @Volatile fields; the audio thread reads them once per burst
 * and is the only thread that touches the synth — no locks and no allocation in the render loop.
 *
 * Stream life (a "session" is one audio thread and the track it owns):
 * - [open] starts a session; its thread creates the track (so creating it never blocks the
 *   caller) and starts it playing silence, so the first stroke has no start-up delay.
 * - While the pen moves or the synth is still audible: render bursts.
 * - Idle for [QUIET_AFTER_NANOS] (2 s): stop synthesising and write zeros — cheap, and it keeps the
 *   output path awake so the next stroke is still instant.
 * - Idle for [PARK_AFTER_NANOS] (10 s): pause the track and park the thread (no CPU). The stream
 *   stays open; the next tap/target wakes it. If the stream isn't [prepared] (it was opened lazily
 *   outside a note) the session ends instead and frees the track.
 * - [close]: the session ends and its thread releases the track.
 * Failures are logged and never thrown: the worst case is a stroke without sound.
 */
class WritingSoundOutput(context: Context) {
    private val audioManager: AudioManager? = context.applicationContext.getSystemService(AudioManager::class.java)

    // --- Mailbox: written by the control thread, read by the audio thread once per burst. ---
    @Volatile private var profile = FeelProfile.DEFAULT
    @Volatile private var gain = 0.0
    @Volatile private var moving = false
    @Volatile private var speed = 0.0
    @Volatile private var pressure = -1.0
    @Volatile private var targetAtNanos = 0L
    @Volatile private var tapPressure = 0.0
    @Volatile private var tapSeq = 0
    /** Set from the main thread when Android moves the stream to another output. */
    @Volatile private var routeChanged = false

    /** A note is open: keep the stream open (paused) through long idle periods. */
    @Volatile var prepared = false

    private var session: Session? = null

    /** Starts the stream if it isn't running. Returns immediately. */
    fun open() {
        if (session?.alive == true) return
        session = Session().also { it.start() }
    }

    /** Stops the stream; its thread releases the track. Returns immediately. */
    fun close() {
        session?.stop()
        session = null
    }

    fun configure(profile: FeelProfile, gain: Double) {
        this.profile = profile
        this.gain = gain
    }

    fun tap(pressure: Double) {
        tapPressure = pressure
        tapSeq++ // single writer, so read-increment-write is safe; the volatile write publishes it
        session?.wake()
    }

    fun target(speedMmPerSec: Double, pressure: Double) {
        speed = speedMmPerSec
        this.pressure = pressure
        targetAtNanos = System.nanoTime()
        moving = true
        session?.wake()
    }

    fun silence() {
        moving = false
    }

    private inner class Session : Runnable {
        @Volatile var alive = true
        @Volatile private var running = true
        @Volatile private var parked = false
        private val thread = Thread(this, "inkwright-sound").apply { isDaemon = true }

        /** Taps requested before this session existed are not replayed. */
        private var seenTap = tapSeq

        fun start() = thread.start()

        fun stop() {
            running = false
            LockSupport.unpark(thread)
        }

        fun wake() {
            if (parked) LockSupport.unpark(thread)
        }

        override fun run() {
            try {
                try {
                    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
                } catch (e: RuntimeException) {
                    Log.w(TAG, "Could not raise the audio thread's priority", e)
                }
                var failures = 0
                while (running && failures < MAX_FAILURES) {
                    val plan = plan()
                    val track = openTrack(plan)
                    if (track == null) {
                        failures++
                    } else {
                        val finished = try {
                            stream(track, plan)
                        } catch (e: Exception) {
                            Log.w(TAG, "Writing-sound stream failed", e)
                            false
                        } finally {
                            releaseTrack(track)
                        }
                        if (finished) break
                        failures++
                    }
                    if (running && failures < MAX_FAILURES) Thread.sleep(RETRY_DELAY_MS)
                }
                if (failures >= MAX_FAILURES) Log.w(TAG, "Writing sound unavailable; will retry on the next stroke")
            } catch (_: InterruptedException) {
                // Daemon thread being torn down.
            } catch (e: Throwable) {
                Log.w(TAG, "Writing-sound thread died", e)
            } finally {
                alive = false
            }
        }

        /** Plays [track] until the session stops (true) or the stream breaks and should be reopened (false). */
        private fun stream(track: AudioTrack, plan: AudioBufferPlan): Boolean {
            val synth = ScratchSynth(track.sampleRate, profile)
            val burst = plan.burstFrames
            val buffer = FloatArray(burst)
            val zeros = FloatArray(burst)
            var bufferFrames = track.bufferSizeInFrames
            // Fast mixer: stay within a few bursts. Normal mixer (not granted, or a route change such
            // as Bluetooth connecting mid-session): allow the whole capacity.
            var limit = if (track.performanceMode == AudioTrack.PERFORMANCE_MODE_LOW_LATENCY) plan.maxBufferFrames else track.bufferCapacityInFrames
            routeChanged = false
            val routing = AudioRouting.OnRoutingChangedListener { routeChanged = true }
            try { track.addOnRoutingChangedListener(routing, null) } catch (e: RuntimeException) { Log.w(TAG, "No routing updates", e) }
            var sinceCheck = 0
            var underruns = -1
            track.play()
            var lastBusy = System.nanoTime()
            while (running) {
                val now = System.nanoTime()
                pull(synth, now)
                if (synth.isAudible || (moving && now - targetAtNanos < QUIET_AFTER_NANOS)) lastBusy = now
                val idle = now - lastBusy
                if (idle >= PARK_AFTER_NANOS) {
                    if (!prepared) return true // opened lazily (no note open): free the track
                    track.pause()
                    track.flush()
                    parkUntilNeeded(now)
                    if (!running) return true
                    track.play()
                    lastBusy = System.nanoTime()
                    sinceCheck = 0
                    underruns = -1 // a restart may underrun once; take a fresh baseline
                    continue
                }
                val out = if (idle >= QUIET_AFTER_NANOS) {
                    zeros
                } else {
                    synth.render(buffer, 0, burst)
                    buffer
                }
                val written = track.write(out, 0, burst, AudioTrack.WRITE_BLOCKING)
                if (written < 0) {
                    Log.w(TAG, "Writing-sound stream write failed ($written); reopening")
                    return false
                }
                if (routeChanged) {
                    routeChanged = false
                    limit = track.bufferCapacityInFrames
                    if (isWireless(track.routedDevice)) {
                        // Bluetooth can never be low latency; queue enough that it never runs dry.
                        val size = track.setBufferSizeInFrames(limit)
                        if (size > 0) bufferFrames = size
                    }
                    Log.i(TAG, "Writing sound rerouted; buffer $bufferFrames frames, up to $limit")
                }
                // Underrun tuner: grow the buffer a burst at a time if this device can't keep up.
                if (++sinceCheck >= TUNE_EVERY_WRITES) {
                    sinceCheck = 0
                    val count = track.underrunCount
                    if (underruns in 0 until count && bufferFrames < limit) {
                        val size = track.setBufferSizeInFrames(min(limit, bufferFrames + burst))
                        if (size > 0) bufferFrames = size
                        Log.i(TAG, "Writing sound underran; buffer now $bufferFrames frames (${ms(bufferFrames, track.sampleRate)} ms)")
                    }
                    underruns = count
                }
            }
            try { track.removeOnRoutingChangedListener(routing) } catch (_: RuntimeException) { }
            return true
        }

        private fun isWireless(device: AudioDeviceInfo?): Boolean = when (device?.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_HEARING_AID -> true
            else -> false
        }

        /** Applies the mailbox to the synth. The tap sequence is read first: it was written last. */
        private fun pull(synth: ScratchSynth, now: Long) {
            val seq = tapSeq
            val p = profile
            if (synth.profile !== p) synth.profile = p
            synth.userVolume = gain
            if (seq != seenTap) {
                seenTap = seq
                synth.touch(tapPressure)
            }
            if (moving) {
                // A pen resting on the glass may stop reporting samples; don't keep scratching then.
                val v = if (now - targetAtNanos > STALE_TARGET_NANOS) 0.0 else speed
                synth.setTarget(v, pressure)
            } else {
                synth.silence()
            }
        }

        private fun parkUntilNeeded(since: Long) {
            parked = true
            // Lost-wakeup safe: writers publish, then read `parked`; we publish `parked`, then re-check.
            while (running && tapSeq == seenTap && !(moving && targetAtNanos > since)) {
                LockSupport.parkNanos(this, PARK_POLL_NANOS)
            }
            parked = false
        }
    }

    private fun plan(): AudioBufferPlan {
        val sampleRate = AudioBufferPlan.resolveSampleRate(property(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE))
        val minBytes = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        return AudioBufferPlan.plan(
            sampleRate,
            property(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER),
            if (minBytes > 0) minBytes / BYTES_PER_FRAME else 0,
        )
    }

    private fun property(key: String): Int? = audioManager?.getProperty(key)?.toIntOrNull()

    private fun openTrack(plan: AudioBufferPlan): AudioTrack? = try {
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_GAME)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(plan.sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(plan.capacityFrames * BYTES_PER_FRAME)
            .build()
        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            Log.w(TAG, "Writing-sound stream did not initialise")
            null
        } else {
            // Capacity is allocated generously; this is how deep we actually fill (the latency). Without
            // the fast mixer a few-ms buffer would run dry every mixer period and crackle, so use it all.
            val lowLatency = track.performanceMode == AudioTrack.PERFORMANCE_MODE_LOW_LATENCY
            track.setBufferSizeInFrames(if (lowLatency) plan.bufferFrames else track.bufferCapacityInFrames)
            val frames = track.bufferSizeInFrames
            Log.i(
                TAG,
                "Writing sound: ${track.sampleRate} Hz, burst ${plan.burstFrames}, buffer $frames frames " +
                    "(${ms(frames, track.sampleRate)} ms) of ${track.bufferCapacityInFrames}, " +
                    if (lowLatency) "low-latency path" else "normal path (low latency not granted)",
            )
            track
        }
    } catch (e: Exception) {
        Log.w(TAG, "Could not open the writing-sound stream", e)
        null
    }

    private fun releaseTrack(track: AudioTrack) {
        try {
            track.pause()
            track.flush()
        } catch (_: IllegalStateException) {
            // Never started or already dead; release anyway.
        }
        track.release()
    }

    private companion object {
        const val TAG = "InkwrightFeel"
        const val BYTES_PER_FRAME = 4 // mono float
        const val QUIET_AFTER_NANOS = 2_000_000_000L
        const val PARK_AFTER_NANOS = 10_000_000_000L
        const val PARK_POLL_NANOS = 1_000_000_000L
        /** No pen sample for this long while the pen is down = it is resting, so silence. */
        const val STALE_TARGET_NANOS = 60_000_000L
        const val TUNE_EVERY_WRITES = 64
        const val MAX_FAILURES = 3
        const val RETRY_DELAY_MS = 100L

        fun ms(frames: Int, sampleRate: Int): String = String.format(Locale.US, "%.1f", frames * 1000.0 / sampleRate)
    }
}
