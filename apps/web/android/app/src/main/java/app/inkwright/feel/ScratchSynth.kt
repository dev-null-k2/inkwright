package app.inkwright.feel

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * Real-time procedural nib-on-paper sound, modelled on what a nib actually does:
 *
 *   noise ─ tilt ─┬─ high-pass ─ low-pass (resonant top) ─ × fibre texture ─ × envelope ─ soft clip
 *   contact tap ──┤
 *   fibre crackle ┘
 *
 * The band (~0.35×…2.4× the centre) gives a soft broadband "shh" rather than a whistle; its centre
 * rises with speed. The nib rides over paper fibres every `fiberMm`, so the level is modulated at
 * speed ÷ fibre spacing by a smoothed random texture: slow strokes sound grainy, fast ones smooth.
 * Crackle and the pen-down tap are short decaying bursts fed through the same band so they sound
 * like paper, not digital clicks. Loudness rises compressively with speed and with pressure.
 *
 * A line-for-line port of `ScratchSynth` in packages/core/src/feel.ts (the reference, which the
 * web build runs in an AudioWorklet), so the app sounds the same on every platform:
 * ScratchSynthParityTest checks it against fixtures generated from the TypeScript. All maths is in
 * Double like JS; the xorshift generators use Int with `shl`/`ushr`/`xor`, which match JS's 32-bit
 * `<<`, `>>>`, `^` and `| 0` exactly. Change both together (and regenerate
 * app/src/test/resources/feel-golden.json).
 *
 * [render] allocates nothing and takes no locks, so it is safe on the audio thread. The class is
 * not thread-safe: one thread owns it (see [WritingSoundOutput]).
 */
class ScratchSynth(sampleRate: Int, profile: FeelProfile) {
    private val sampleRate: Double = sampleRate.toDouble()
    var profile: FeelProfile = profile

    /** Linear output gain (volumeToGain of the user's slider, applied on the web side). */
    var userVolume = 1.0
    private var targetAmp = 0.0
    private var targetHz: Double = profile.soundBaseHz
    private var speed = 0.0
    private var amp = 0.0
    private var hz: Double = profile.soundBaseHz
    private var noise: Int = 0x12345678
    private var rand: Int = 0x0badf00d
    private var tilt = 0.0

    // High-pass and low-pass biquads (direct form I).
    private var hb0 = 0.0; private var hb1 = 0.0; private var hb2 = 0.0; private var ha1 = 0.0; private var ha2 = 0.0
    private var hx1 = 0.0; private var hx2 = 0.0; private var hy1 = 0.0; private var hy2 = 0.0
    private var lb0 = 0.0; private var lb1 = 0.0; private var lb2 = 0.0; private var la1 = 0.0; private var la2 = 0.0
    private var lx1 = 0.0; private var lx2 = 0.0; private var ly1 = 0.0; private var ly2 = 0.0
    private var fiberPhase = 0.0
    private var fiberTarget = 1.0
    private var fiber = 1.0
    private var burst = 0.0
    private var tap = 0.0
    private val attack: Double
    private val release: Double
    private val hzCoef: Double
    private val tiltCoef: Double
    private val fiberCoef: Double
    private val burstDecay: Double
    private val tapDecay: Double

    init {
        val sr = this.sampleRate
        fun coef(s: Double) = 1 - exp(-1 / (s * sr))
        attack = coef(0.005)
        release = coef(0.06)
        hzCoef = coef(0.02)
        tiltCoef = coef(1 / (2 * PI * 3500))
        fiberCoef = coef(0.0007)
        burstDecay = exp(-1 / (0.0012 * sr))
        tapDecay = exp(-1 / (0.004 * sr))
        updateFilters(hz)
    }

    /** Pen speed (mm/s) and pressure (0..1, negative if unknown). Call as often as samples arrive. */
    fun setTarget(speedMmPerSec: Double, pressure: Double) {
        val p = profile
        val v = max(0.0, speedMmPerSec)
        val press = if (pressure < 0) 0.65 else 0.35 + 0.65 * max(0.0, min(1.0, pressure))
        // Silent when the nib rests; loudness then grows compressively with speed, as friction noise does.
        val motion = if (v < 1.5) 0.0 else 1 - exp(-(v - 1.5) / 40)
        targetAmp = max(0.0, min(1.0, p.soundGain * press * motion))
        targetHz = max(250.0, min(sampleRate * 0.2, p.soundBaseHz + p.soundHzPer100MmS * (v / 100)))
        speed = v
    }

    /** The soft "tk" of the nib meeting paper. */
    fun touch(pressure: Double) {
        val press = if (pressure < 0) 0.6 else 0.3 + 0.7 * max(0.0, min(1.0, pressure))
        tap = max(tap, 0.55 * press * min(1.0, profile.soundGain * 1.6))
    }

    fun silence() {
        targetAmp = 0.0
        speed = 0.0
    }

    val isAudible: Boolean get() = amp > 1e-4 || targetAmp > 0 || tap > 1e-4

    fun render(out: FloatArray, offset: Int = 0, frames: Int = out.size - offset) {
        val p = profile
        val tAmp = targetAmp
        val tHz = targetHz
        val fiberStep = if (p.fiberMm > 0) speed / p.fiberMm / sampleRate else 0.0
        val depth = max(0.0, min(0.9, p.texture))
        val crackleProb = if (p.crackle > 0) min(0.02, ((speed / max(0.05, p.grainPitchMm)) * p.crackle) / sampleRate) else 0.0
        val glide = 1 - (1 - hzCoef).pow(32)
        val vol = userVolume
        for (i in 0 until frames) {
            amp += (tAmp - amp) * (if (tAmp > amp) attack else release)
            if ((i and 31) == 0) {
                hz += (tHz - hz) * glide
                updateFilters(hz)
            }
            // Source: noise with a gentle high-frequency tilt (paper is soft, not white).
            val n = nextNoise()
            tilt += (n - tilt) * tiltCoef
            var x = n * 0.55 + tilt * 0.75
            if (crackleProb > 0 && nextUniform() < crackleProb) burst = max(burst, 0.5 + 0.5 * nextUniform())
            if (burst > 1e-4 || tap > 1e-4) {
                x += nextNoise() * (burst * 1.4 + tap * 0.8)
                burst *= burstDecay
                tap *= tapDecay
            }
            // Band: high-pass then resonant low-pass.
            val h = hb0 * x + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2
            hx2 = hx1; hx1 = x; hy2 = hy1; hy1 = h
            val l = lb0 * h + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2
            lx2 = lx1; lx1 = h; ly2 = ly1; ly1 = l
            // Fibres: a new random level each time the nib crosses one, smoothed so it never clicks.
            if (fiberStep > 0) {
                fiberPhase += fiberStep
                if (fiberPhase >= 1) { fiberPhase -= floor(fiberPhase); fiberTarget = 1 - depth * nextUniform() }
            }
            fiber += (fiberTarget - fiber) * fiberCoef
            val tapLevel = if (tap > 1e-4) 1.0 else 0.0
            val env = max(amp, tapLevel * 0.35)
            val c = max(-1.5, min(1.5, l * fiber * env * vol * 3.4))
            out[offset + i] = (c - (c * c * c) / 6.75).toFloat()
        }
        if (amp < 1e-5 && tAmp == 0.0) amp = 0.0
    }

    private fun updateFilters(centre: Double) {
        val sr = sampleRate
        val hp = max(120.0, centre * 0.35)
        val lp = min(sr * 0.45, centre * 2.4)
        var w = (2 * PI * hp) / sr
        var cs = cos(w)
        var al = sin(w) / (2 * 0.6)
        var a0 = 1 + al
        hb0 = (1 + cs) / 2 / a0; hb1 = -(1 + cs) / a0; hb2 = hb0
        ha1 = (-2 * cs) / a0; ha2 = (1 - al) / a0
        w = (2 * PI * lp) / sr
        cs = cos(w)
        al = sin(w) / (2 * max(0.3, profile.soundQ))
        a0 = 1 + al
        lb0 = (1 - cs) / 2 / a0; lb1 = (1 - cs) / a0; lb2 = lb0
        la1 = (-2 * cs) / a0; la2 = (1 - al) / a0
    }

    private fun nextNoise(): Double {
        var s = noise
        s = s xor (s shl 13); s = s xor (s ushr 17); s = s xor (s shl 5)
        noise = s
        return max(-1.0, min(1.0, noise / 2147483647.0))
    }

    private fun nextUniform(): Double {
        var s = rand
        s = s xor (s shl 13); s = s xor (s ushr 17); s = s xor (s shl 5)
        rand = s
        return (rand ushr 1) / 2147483647.0
    }
}
