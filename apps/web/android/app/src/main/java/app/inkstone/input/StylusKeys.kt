package app.inkstone.input

/**
 * Stylus button key codes, as numbers so this file stays plain JVM code (unit-testable without
 * Android). Values are android.view.KeyEvent constants added in API 34; AOSP has no
 * "KEYCODE_BUTTON_STYLUS" — these four are the whole stylus family.
 *
 * Note: barrel buttons are normally delivered as MotionEvent button state (BUTTON_STYLUS_PRIMARY),
 * which the WebView already turns into pointer events (`buttons & 2` / `button === 5` for the
 * eraser end). Key events arrive when a pen or the OS sends them as keys, e.g. a Bluetooth pen
 * button that the system does not claim for itself, or with "stylus buttons" disabled in Settings.
 */
object StylusKeyCodes {
    /** KeyEvent.KEYCODE_STYLUS_BUTTON_PRIMARY */
    const val PRIMARY = 308

    /** KeyEvent.KEYCODE_STYLUS_BUTTON_SECONDARY */
    const val SECONDARY = 309

    /** KeyEvent.KEYCODE_STYLUS_BUTTON_TERTIARY */
    const val TERTIARY = 310

    /** KeyEvent.KEYCODE_STYLUS_BUTTON_TAIL (the "back"/top button of pens that have one) */
    const val TAIL = 311

    val ALL: Set<Int> = setOf(PRIMARY, SECONDARY, TERTIARY, TAIL)
}

/** KeyEvent action values (android.view.KeyEvent.ACTION_*). */
object KeyActions {
    const val DOWN = 0
    const val UP = 1
}

/** What the web layer receives as the `stylusButton` event. */
data class StylusButtonEvent(val keyCode: Int, val pressed: Boolean)

/**
 * Decides which key events become `stylusButton` events: one `pressed=true` per physical press
 * (auto-repeat and duplicate downs are swallowed), one `pressed=false` per release, and synthetic
 * releases when the window loses focus mid-press so the web layer never sees a stuck button.
 *
 * Stylus keys are always consumed so the WebView does not also see them as unidentified keys.
 * Not thread-safe; use from the UI thread (where key events are dispatched).
 */
class StylusKeyFilter(private val keys: Set<Int> = StylusKeyCodes.ALL) {

    data class Decision(val consume: Boolean, val event: StylusButtonEvent?) {
        companion object {
            /** Not a stylus key: let the normal dispatch handle it. */
            val PASS = Decision(consume = false, event = null)

            /** A stylus key with nothing new to report (repeat, duplicate, stray release). */
            val SWALLOW = Decision(consume = true, event = null)
        }
    }

    private val held = LinkedHashSet<Int>()

    /** Keys currently reported as pressed. */
    val pressedKeys: Set<Int> get() = held.toSet()

    fun isStylusKey(keyCode: Int): Boolean = keyCode in keys

    fun onKey(action: Int, keyCode: Int, repeatCount: Int): Decision {
        if (keyCode !in keys) return Decision.PASS
        return when (action) {
            KeyActions.DOWN ->
                if (repeatCount > 0 || !held.add(keyCode)) Decision.SWALLOW
                else Decision(consume = true, event = StylusButtonEvent(keyCode, pressed = true))
            KeyActions.UP ->
                // A release we never reported a press for (pressed before we had focus) is dropped.
                if (held.remove(keyCode)) Decision(consume = true, event = StylusButtonEvent(keyCode, pressed = false))
                else Decision.SWALLOW
            else -> Decision.SWALLOW
        }
    }

    /** Releases every held key (call when the window loses focus or the activity pauses). */
    fun releaseAll(): List<StylusButtonEvent> {
        if (held.isEmpty()) return emptyList()
        val released = held.map { StylusButtonEvent(it, pressed = false) }
        held.clear()
        return released
    }
}
