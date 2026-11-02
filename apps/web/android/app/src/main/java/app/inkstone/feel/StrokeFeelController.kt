package app.inkstone.feel

import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

/** Where a stroke's paper feel goes: the writing-sound stream and the haptic actuator. */
interface FeelOutput {
    /** Profile and linear gain for the sound that follows. */
    fun configureSound(profile: FeelProfile, gain: Double)

    /** The nib meeting paper ([ScratchSynth.touch]). */
    fun soundTap(pressure: Double)

    /** Pen speed and pressure ([ScratchSynth.setTarget]); called for every pen sample. */
    fun soundTarget(speedMmPerSec: Double, pressure: Double)

    /** The pen left the paper: fade out ([ScratchSynth.silence]). */
    fun soundSilence()

    /** One haptic grain tick, intensity 0..1. */
    fun hapticTick(intensity: Double)
}

/** What the web layer asked for with feelBegin / feelPreview. */
data class FeelSettings(
    val profile: FeelProfile,
    val sound: Boolean,
    /** Linear output gain, already tapered (volumeToGain) on the web side. */
    val soundGain: Double,
    val haptics: Boolean,
    /** The user's grain-strength slider, multiplies [FeelProfile.hapticStrength]. */
    val hapticStrength: Double,
) {
    val soundOn: Boolean get() = sound && soundGain > 0
}

/**
 * The decisions of the native paper-feel engine, kept free of Android types so they are unit
 * tested on the JVM ([NativePaperFeel] adapts MotionEvents, threads and outputs around it).
 *
 * The stylus is tracked all the time (cheap: last position, time and a smoothed speed), whether or
 * not a stroke is armed. The web layer's feelBegin travels through the WebView and the bridge and
 * arrives some milliseconds after ACTION_DOWN; by then this already knows how fast the pen is
 * moving, so the sound starts at the right level instead of ramping up from silence.
 *
 * Once armed, every sample (historical ones included) drives the synth target and the
 * [GrainScheduler]; the stroke disarms itself when the tracked pointer lifts or is cancelled, or
 * on [end]. Positions are millimetres, times milliseconds. Not thread-safe: use from one thread
 * (the UI thread in the app).
 */
class StrokeFeelController(private val out: FeelOutput) {
    // --- The stylus pointer currently down (tracked whether or not a stroke is armed). ---
    var trackedPointerId = NO_POINTER
        private set
    val isStylusDown: Boolean get() = trackedPointerId != NO_POINTER
    private var downTimeMs = 0L
    private var downPressure = -1.0
    private var hasSample = false
    private var lastX = 0.0
    private var lastY = 0.0
    private var lastT = 0.0
    private var lastPressure = -1.0

    /** Smoothed pen speed, mm/s: the same estimator as [GrainScheduler], so sound and grain agree. */
    var speed = 0.0
        private set

    /** Down time of the stroke whose contact tap already played, so a repeated feelBegin can't tap twice. */
    private var tappedDownTimeMs = Long.MIN_VALUE

    // --- The armed stroke. ---
    private var settings: FeelSettings? = null
    var armed = false
        private set
    private val scheduler = GrainScheduler(FeelProfile.DEFAULT, unitsPerMm = 1.0)

    // --- The settings preview (a synthetic stroke). ---
    private var preview: FeelSettings? = null
    private var previewStartMs = 0L
    private var previewLastMs = 0L
    private var previewX = 0.0
    val isPreviewing: Boolean get() = preview != null

    /** A stylus pointer touched down. [downTimeMs] is on the uptime clock, like [begin]'s `nowMs`. */
    fun stylusDown(pointerId: Int, xMm: Double, yMm: Double, tMs: Double, pressure: Double, downTimeMs: Long) {
        if (isStylusDown) stylusUp() // a lift we never saw; don't let the old stroke stay armed
        trackedPointerId = pointerId
        this.downTimeMs = downTimeMs
        downPressure = pressure
        hasSample = false
        speed = 0.0
        sample(xMm, yMm, tMs, pressure)
    }

    /** One sample of the tracked stylus (call for every historical sample too, oldest first). */
    fun stylusMove(xMm: Double, yMm: Double, tMs: Double, pressure: Double) {
        if (isStylusDown) sample(xMm, yMm, tMs, pressure)
    }

    /** The tracked stylus lifted or was cancelled. */
    fun stylusUp() {
        if (!isStylusDown) return
        trackedPointerId = NO_POINTER
        hasSample = false
        speed = 0.0
        disarm()
    }

    /**
     * Arms the engine for the stroke that has just started. [pressure] is the pen-down pressure the
     * web layer saw (negative if unknown; the tracked pen-down pressure is used then).
     */
    fun begin(settings: FeelSettings, pressure: Double, nowMs: Long) {
        stopPreview() // a real stroke wins over a settings preview
        this.settings = settings
        if (settings.soundOn) out.configureSound(settings.profile, settings.soundGain)
        scheduler.setProfile(settings.profile)
        scheduler.userStrength = settings.hapticStrength
        scheduler.reset()
        if (!isStylusDown) {
            // A quick tap that lifted before the bridge call got here: the tap is all there is to play.
            armed = false
            if (settings.soundOn) out.soundTap(pressure)
            return
        }
        if (nowMs - downTimeMs <= TAP_WINDOW_MS && tappedDownTimeMs != downTimeMs) {
            tappedDownTimeMs = downTimeMs
            if (settings.soundOn) out.soundTap(if (pressure >= 0) pressure else downPressure)
        }
        armed = true
        if (hasSample) {
            // Grain counts distance from where the pen is now; the sound picks up the speed so far.
            scheduler.onSample(lastX, lastY, lastT, lastPressure)
            if (settings.soundOn) out.soundTarget(speed, lastPressure)
        }
    }

    /** The web layer ended the stroke (it may still be down, e.g. a gesture took over). */
    fun end() = disarm()

    /** Starts a ~700 ms synthetic stroke (0→80→0 mm/s, pressure 0.6) at [settings]. */
    fun startPreview(settings: FeelSettings, nowMs: Long) {
        if (armed) return // never talk over a real stroke
        stopPreview()
        if (!settings.soundOn && !settings.haptics) return
        preview = settings
        previewStartMs = nowMs
        previewLastMs = nowMs
        previewX = 0.0
        scheduler.setProfile(settings.profile)
        scheduler.userStrength = settings.hapticStrength
        scheduler.reset()
        scheduler.onSample(0.0, 0.0, 0.0, PREVIEW_PRESSURE)
        if (settings.soundOn) {
            out.configureSound(settings.profile, settings.soundGain)
            out.soundTap(PREVIEW_PRESSURE)
            out.soundTarget(0.0, PREVIEW_PRESSURE)
        }
    }

    /** Advances the preview to [nowMs]; returns true while it still needs stepping. */
    fun stepPreview(nowMs: Long): Boolean {
        val s = preview ?: return false
        val elapsed = (nowMs - previewStartMs).toDouble()
        val f = elapsed / PREVIEW_MS
        if (f >= 1) {
            stopPreview()
            return false
        }
        val v = PREVIEW_PEAK_MM_S * sin(PI * f)
        previewX += v * (nowMs - previewLastMs) / 1000.0
        previewLastMs = nowMs
        if (s.soundOn) out.soundTarget(v, PREVIEW_PRESSURE)
        if (s.haptics) scheduler.onSample(previewX, 0.0, elapsed, PREVIEW_PRESSURE)?.let { out.hapticTick(it.intensity) }
        return true
    }

    fun stopPreview() {
        val s = preview ?: return
        preview = null
        if (s.soundOn) out.soundSilence()
    }

    private fun disarm() {
        if (!armed) return
        armed = false
        if (settings?.soundOn == true) out.soundSilence()
    }

    private fun sample(x: Double, y: Double, t: Double, pressure: Double) {
        if (hasSample) {
            val dt = max(1.0, t - lastT)
            val inst = hypot(x - lastX, y - lastY) / (dt / 1000)
            val a = 1 - exp(-dt / 12)
            speed = if (speed == 0.0) inst else speed + (inst - speed) * a
        }
        lastX = x; lastY = y; lastT = t; lastPressure = pressure
        hasSample = true
        if (!armed) return
        val s = settings ?: return
        if (s.soundOn) out.soundTarget(speed, pressure)
        val tick = scheduler.onSample(x, y, t, pressure)
        if (tick != null && s.haptics) out.hapticTick(tick.intensity)
    }

    companion object {
        const val NO_POINTER = -1

        /** feelBegin this soon after pen-down still plays the contact tap; later it would sound detached. */
        const val TAP_WINDOW_MS = 60L

        const val PREVIEW_MS = 700.0
        const val PREVIEW_PEAK_MM_S = 80.0
        const val PREVIEW_PRESSURE = 0.6
    }
}

/** Pixels → millimetres for pen input. */
object ScreenScale {
    /**
     * Pixels per millimetre from the display's physical density ([physicalDpi], DisplayMetrics
     * xdpi/ydpi). Some devices report a placeholder there (0, or 160 on a 400+ dpi panel); when it
     * is implausible next to the logical [densityDpi] (more than 2× off — the user's display-size
     * setting moves densityDpi much less than that), densityDpi is the better estimate.
     */
    fun pxPerMm(physicalDpi: Float, densityDpi: Int): Double {
        val logical = if (densityDpi > 0) densityDpi.toDouble() else 160.0
        val physical = physicalDpi.toDouble()
        val dpi = if (physical.isFinite() && physical >= logical / 2 && physical <= logical * 2) physical else logical
        return dpi / 25.4
    }
}
