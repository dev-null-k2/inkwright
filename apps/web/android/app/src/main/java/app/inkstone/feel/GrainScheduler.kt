package app.inkstone.feel

import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** One haptic grain tick: how hard, and how fast the pen was going when it fired. */
data class GrainTick(val intensity: Double, val speedMmPerSec: Double)

/**
 * Decides when to fire haptic grain ticks as the pen moves. Paper fibres are spatial, so ticks
 * are emitted per distance travelled, not per unit time: slow strokes give sparse distinct bumps,
 * fast strokes a fine buzz. Intensity follows pressure and speed; a rate cap keeps requests within
 * what a phone actuator renders distinctly. Deterministic (seeded jitter) for tests and tuning.
 *
 * A line-for-line port of `GrainScheduler` in packages/core/src/feel.ts, which is the reference:
 * GrainSchedulerParityTest checks it against fixtures generated from the TypeScript. Change both
 * together (and regenerate app/src/test/resources/feel-golden.json).
 *
 * Positions are in "units" converted with [unitsPerMm]; the native engine feeds millimetres
 * directly and passes `unitsPerMm = 1.0`. Times are milliseconds. Not thread-safe.
 */
class GrainScheduler(
    private var profile: FeelProfile,
    private val unitsPerMm: Double = 96.0 / 25.4,
    private val maxRateHz: Double = 140.0,
    var userStrength: Double = 1.0,
    seed: Int = 0x51a7e,
) {
    private var lastX = 0.0
    private var lastY = 0.0
    private var lastT = 0.0
    private var hasLast = false
    private var travelled = 0.0
    private var nextPitch: Double = profile.grainPitchMm
    private var lastTickT = -1e12
    private var smoothedSpeed = 0.0
    private var rng: Int = seed

    val speed: Double get() = smoothedSpeed

    fun setProfile(p: FeelProfile) {
        profile = p
        nextPitch = jittered()
    }

    fun reset() {
        hasLast = false
        travelled = 0.0
        smoothedSpeed = 0.0
        lastTickT = -1e12
        nextPitch = jittered()
    }

    /** One pen sample (units, ms); pressure 0..1 or negative if unknown. */
    fun onSample(x: Double, y: Double, t: Double, pressure: Double): GrainTick? {
        if (!hasLast) {
            lastX = x; lastY = y; lastT = t; hasLast = true
            return null
        }
        val dMm = hypot(x - lastX, y - lastY) / unitsPerMm
        val dt = max(1.0, t - lastT)
        lastX = x; lastY = y; lastT = t
        val inst = dMm / (dt / 1000)
        // Time-based smoothing (τ ≈ 12 ms) so the estimate settles equally fast at 60, 120 or 240 Hz.
        val a = 1 - exp(-dt / 12)
        smoothedSpeed = if (smoothedSpeed == 0.0) inst else smoothedSpeed + (inst - smoothedSpeed) * a
        travelled += dMm
        if (travelled < nextPitch) return null
        if (t - lastTickT < 1000 / maxRateHz) {
            travelled = min(travelled, nextPitch * 2)
            return null
        }
        travelled -= nextPitch
        if (travelled > nextPitch) travelled = nextPitch
        nextPitch = jittered()
        lastTickT = t
        val pf = if (pressure < 0) 0.65 else 0.35 + 0.65 * clamp01(pressure)
        val sf = smoothstep(1.5, 25.0, smoothedSpeed) * (1 - 0.4 * smoothstep(250.0, 600.0, smoothedSpeed))
        val intensity = clamp01(profile.hapticStrength * pf * (0.35 + 0.65 * sf) * userStrength)
        if (intensity < 0.02) return null
        return GrainTick(intensity, smoothedSpeed)
    }

    private fun jittered(): Double {
        // JS: (Math.imul(rng, 1103515245) + 12345) | 0 — Int arithmetic wraps identically.
        rng = rng * 1103515245 + 12345
        val r = ((rng ushr 8) and 0xffff) / 65535.0
        return profile.grainPitchMm * (1 + profile.grainJitter * (r * 2 - 1))
    }
}

/** `clamp01` from packages/core/src/geometry.ts. */
internal fun clamp01(v: Double): Double = max(0.0, min(1.0, v))

/** `smoothstep` from packages/core/src/geometry.ts. */
internal fun smoothstep(e0: Double, e1: Double, x: Double): Double {
    val t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)
}
