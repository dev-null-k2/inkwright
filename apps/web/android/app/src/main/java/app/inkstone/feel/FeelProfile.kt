package app.inkstone.feel

import org.json.JSONObject

/**
 * How a pen on a given paper should feel and sound. Mirrors `FeelProfile` in
 * packages/core/src/feel.ts field for field; the web layer computes it (paper × pen) and sends it
 * whole with feelBegin/feelPreview, so native needs no paper or pen tables of its own.
 *
 * Immutable on purpose: the audio thread holds a reference to the current profile and the UI
 * thread swaps in a new one, so no field can change under a render.
 */
data class FeelProfile(
    /** Mean distance between haptic grain ticks, millimetres. */
    val grainPitchMm: Double,
    /** Random variation of the pitch (0..1) so grain feels organic, not mechanical. */
    val grainJitter: Double,
    /** Base haptic strength 0..1 before pressure/speed modulation. */
    val hapticStrength: Double,
    /** Centre of the writing sound's band at slow speed, Hz. */
    val soundBaseHz: Double,
    /** Centre rise per 100 mm/s of pen speed, Hz (faster strokes sound brighter). */
    val soundHzPer100MmS: Double,
    /** Resonance at the top of the band: higher = scratchier nib, lower = softer hiss. */
    val soundQ: Double,
    val soundGain: Double,
    /** Fibre "crackle" bursts mixed in, 0..1. */
    val crackle: Double,
    /** Spacing of the paper's fibres the nib rides over, mm: sets the grain of the sound. */
    val fiberMm: Double,
    /** How much the fibres modulate the sound, 0 (glass) .. 1 (rough). */
    val texture: Double,
) {
    companion object {
        /** `feelOf('standard', 'fountain')` — what the web layer uses before a note sets a paper. */
        val DEFAULT = FeelProfile(
            grainPitchMm = 0.85, grainJitter = 0.3, hapticStrength = 0.4675,
            soundBaseHz = 2000.0, soundHzPer100MmS = 850.0, soundQ = 0.77, soundGain = 0.425,
            crackle = 0.09, fiberMm = 0.2, texture = 0.45,
        )

        /**
         * Reads a profile sent over the bridge. Missing or non-finite fields fall back to [DEFAULT]
         * and every field is clamped to a range the synth stays stable in: the values come from
         * another process boundary, and a bad filter centre would otherwise make the audio thread
         * render noise bursts or NaNs.
         */
        fun fromJson(json: JSONObject?): FeelProfile {
            val d = DEFAULT
            fun read(key: String, fallback: Double, lo: Double, hi: Double): Double {
                val v = json?.optDouble(key, Double.NaN) ?: Double.NaN
                return if (v.isFinite()) v.coerceIn(lo, hi) else fallback
            }
            return FeelProfile(
                grainPitchMm = read("grainPitchMm", d.grainPitchMm, 0.05, 20.0),
                grainJitter = read("grainJitter", d.grainJitter, 0.0, 1.0),
                hapticStrength = read("hapticStrength", d.hapticStrength, 0.0, 1.0),
                soundBaseHz = read("soundBaseHz", d.soundBaseHz, 100.0, 8000.0),
                soundHzPer100MmS = read("soundHzPer100MmS", d.soundHzPer100MmS, 0.0, 5000.0),
                soundQ = read("soundQ", d.soundQ, 0.1, 10.0),
                soundGain = read("soundGain", d.soundGain, 0.0, 1.0),
                crackle = read("crackle", d.crackle, 0.0, 1.0),
                fiberMm = read("fiberMm", d.fiberMm, 0.0, 10.0),
                texture = read("texture", d.texture, 0.0, 1.0),
            )
        }
    }
}
