package app.inkwright.feel

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Renders paper-grain haptic ticks on a dedicated thread so a vibrator binder call can never add
 * latency to the bridge or the UI thread.
 *
 * Best effect first: the LOW_TICK composition primitive (API 31+, the finest texture on actuators
 * that support it), then TICK (API 30+), then a 4 ms amplitude-scaled one-shot, then nothing.
 * Vibrations use touch-feedback usage, so the system "Touch feedback" / haptics setting applies.
 */
class HapticGrainEngine(context: Context) {
    private val vibrator: Vibrator? = obtainVibrator(context)
    private val thread = HandlerThread("inkwright-haptics", Process.THREAD_PRIORITY_DISPLAY).apply { start() }
    private val handler = Handler(thread.looper)
    private val pacer = GrainPacer()

    val hasVibrator: Boolean = vibrator?.hasVibrator() == true

    private val lowTick = hasVibrator && Build.VERSION.SDK_INT >= 31 &&
        vibrator!!.areAllPrimitivesSupported(VibrationEffect.Composition.PRIMITIVE_LOW_TICK)
    private val tick = hasVibrator && Build.VERSION.SDK_INT >= 30 &&
        vibrator!!.areAllPrimitivesSupported(VibrationEffect.Composition.PRIMITIVE_TICK)
    private val click = hasVibrator && Build.VERSION.SDK_INT >= 30 &&
        vibrator!!.areAllPrimitivesSupported(VibrationEffect.Composition.PRIMITIVE_CLICK)
    private val amplitudeControl = hasVibrator && vibrator!!.hasAmplitudeControl()

    /** True when the actuator can render fine grain (composition primitives). */
    val supportsRichHaptics: Boolean get() = lowTick || tick

    // Effects are immutable; build each quantized level once, on the haptics thread.
    private val grainEffects = arrayOfNulls<VibrationEffect>(GrainLevels.STEPS + 1)
    private var confirmEffect: VibrationEffect? = null

    private val touchAttributes: Any? =
        if (Build.VERSION.SDK_INT >= 33) VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH) else null

    @Suppress("DEPRECATION")
    private val legacyAttributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION) // maps to touch feedback
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    /** Queues one grain tick; returns immediately. [intensity] is 0..1. */
    fun grain(intensity: Float) {
        if (!hasVibrator) return
        val level = GrainLevels.level(intensity)
        if (level == 0) return
        val requestedAt = System.nanoTime()
        handler.post {
            if (!pacer.admit(requestedAt, System.nanoTime())) return@post
            val effect = grainEffects[level] ?: buildGrain(GrainLevels.scale(level))?.also { grainEffects[level] = it }
            if (effect != null) vibrate(effect)
        }
    }

    /** A crisp confirmation tick, e.g. when a scratch-out erases something. */
    fun confirm() {
        if (!hasVibrator) return
        handler.post {
            val effect = confirmEffect ?: buildConfirm().also { confirmEffect = it }
            vibrate(effect)
        }
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
    }

    // lowTick / tick / click already include their SDK_INT checks (see the field initializers).
    private fun buildGrain(scale: Float): VibrationEffect? = when {
        lowTick ->
            VibrationEffect.startComposition().addPrimitive(VibrationEffect.Composition.PRIMITIVE_LOW_TICK, scale).compose()
        tick ->
            VibrationEffect.startComposition().addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, scale * 0.6f).compose()
        amplitudeControl -> VibrationEffect.createOneShot(4, (scale * 120).toInt().coerceIn(1, 255))
        else -> null // on/off-only motors cannot render grain; a buzz per tick would feel wrong
    }

    private fun buildConfirm(): VibrationEffect = when {
        click ->
            VibrationEffect.startComposition().addPrimitive(VibrationEffect.Composition.PRIMITIVE_CLICK, 0.7f).compose()
        Build.VERSION.SDK_INT >= 29 -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
        else -> VibrationEffect.createOneShot(12, if (amplitudeControl) 160 else VibrationEffect.DEFAULT_AMPLITUDE)
    }

    @SuppressLint("MissingPermission") // VIBRATE is declared in the manifest
    private fun vibrate(effect: VibrationEffect) {
        val v = vibrator ?: return
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                v.vibrate(effect, touchAttributes as VibrationAttributes)
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(effect, legacyAttributes)
            }
        } catch (_: RuntimeException) {
            // Vibrator service hiccups must never take the app down.
        }
    }

    private companion object {
        fun obtainVibrator(context: Context): Vibrator? =
            if (Build.VERSION.SDK_INT >= 31) {
                context.getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Vibrator::class.java)
            }
    }
}
