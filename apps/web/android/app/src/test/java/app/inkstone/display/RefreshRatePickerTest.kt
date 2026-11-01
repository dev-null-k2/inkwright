package app.inkstone.display

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshRatePickerTest {
    private fun mode(id: Int, w: Int, h: Int, hz: Float) = DisplayModeInfo(id, w, h, hz)

    @Test
    fun picksHighestRateAtSameResolution() {
        val current = mode(1, 2232, 2484, 60f)
        val modes = listOf(current, mode(2, 2232, 2484, 120f), mode(3, 2232, 2484, 165f), mode(4, 2232, 2484, 90f))
        assertEquals(3, RefreshRatePicker.pick(current, modes).id)
    }

    @Test
    fun neverChangesResolution() {
        val current = mode(1, 1080, 2400, 60f)
        val modes = listOf(current, mode(2, 1440, 3200, 144f), mode(3, 1080, 2400, 120f))
        assertEquals(3, RefreshRatePicker.pick(current, modes).id)
    }

    @Test
    fun keepsCurrentWhenNothingIsFaster() {
        val current = mode(5, 1080, 2400, 120f)
        val modes = listOf(mode(4, 1080, 2400, 60f), current, mode(6, 1440, 3200, 165f))
        assertEquals(current, RefreshRatePicker.pick(current, modes))
    }

    @Test
    fun nearlyEqualRatesDoNotCauseASwitch() {
        val current = mode(1, 1080, 2400, 60f)
        val modes = listOf(mode(2, 1080, 2400, 59.94f), current, mode(3, 1080, 2400, 60.2f))
        assertEquals(1, RefreshRatePicker.pick(current, modes).id)
        assertTrue(RefreshRatePicker.sameRate(59.94f, 60f))
        assertFalse(RefreshRatePicker.sameRate(90f, 120f))
    }

    @Test
    fun emptyListKeepsCurrent() {
        val current = mode(1, 1080, 2400, 60f)
        assertEquals(current, RefreshRatePicker.pick(current, emptyList()))
    }
}
