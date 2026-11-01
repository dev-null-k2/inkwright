package app.inkstone.display

import kotlin.math.abs

/** A display mode, decoupled from android.view.Display.Mode so the choice is unit-testable. */
data class DisplayModeInfo(val id: Int, val width: Int, val height: Int, val refreshRate: Float)

/**
 * Picks the display mode Inkstone prefers while it is in the foreground: the highest refresh rate
 * at the current resolution, so ink follows the pen at 120/144/165 Hz instead of whatever the
 * panel's power policy picked. Never changes resolution (that would relayout the WebView).
 */
object RefreshRatePicker {
    /**
     * @return the best mode with [current]'s physical resolution, or [current] itself when nothing
     * is faster. Ties keep the current mode so we never request a no-op switch.
     */
    fun pick(current: DisplayModeInfo, supported: List<DisplayModeInfo>): DisplayModeInfo {
        var best = current
        for (m in supported) {
            if (m.width != current.width || m.height != current.height) continue
            if (m.refreshRate > best.refreshRate + EPSILON_HZ) best = m
        }
        return best
    }

    /** True when [a] and [b] are the same refresh rate for practical purposes (59.94 vs 60). */
    fun sameRate(a: Float, b: Float): Boolean = abs(a - b) <= EPSILON_HZ

    private const val EPSILON_HZ = 0.5f
}
