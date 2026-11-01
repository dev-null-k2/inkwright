package app.inkstone.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StylusKeyFilterTest {
    private val down = KeyActions.DOWN
    private val up = KeyActions.UP

    @Test
    fun keyCodesMatchAosp() {
        // android.view.KeyEvent (API 34): KEYCODE_STYLUS_BUTTON_PRIMARY..TAIL = 308..311
        assertEquals(308, StylusKeyCodes.PRIMARY)
        assertEquals(309, StylusKeyCodes.SECONDARY)
        assertEquals(310, StylusKeyCodes.TERTIARY)
        assertEquals(311, StylusKeyCodes.TAIL)
        assertEquals(setOf(308, 309, 310, 311), StylusKeyCodes.ALL)
    }

    @Test
    fun nonStylusKeysPassThrough() {
        val f = StylusKeyFilter()
        for (code in listOf(4 /* BACK */, 24 /* VOLUME_UP */, 66 /* ENTER */, 312 /* RECENT_APPS */, 313 /* MACRO_1 */)) {
            assertEquals(StylusKeyFilter.Decision.PASS, f.onKey(down, code, 0))
            assertEquals(StylusKeyFilter.Decision.PASS, f.onKey(up, code, 0))
        }
        assertTrue(f.pressedKeys.isEmpty())
    }

    @Test
    fun pressAndReleaseEmitOneEventEach() {
        val f = StylusKeyFilter()
        val d = f.onKey(down, StylusKeyCodes.PRIMARY, 0)
        assertTrue(d.consume)
        assertEquals(StylusButtonEvent(308, pressed = true), d.event)
        val u = f.onKey(up, StylusKeyCodes.PRIMARY, 0)
        assertTrue(u.consume)
        assertEquals(StylusButtonEvent(308, pressed = false), u.event)
        assertTrue(f.pressedKeys.isEmpty())
    }

    @Test
    fun autoRepeatIsConsumedButNotResent() {
        val f = StylusKeyFilter()
        f.onKey(down, StylusKeyCodes.TAIL, 0)
        for (repeat in 1..5) {
            val r = f.onKey(down, StylusKeyCodes.TAIL, repeat)
            assertTrue(r.consume)
            assertNull(r.event)
        }
        assertEquals(StylusButtonEvent(311, pressed = false), f.onKey(up, StylusKeyCodes.TAIL, 0).event)
    }

    @Test
    fun duplicateDownWithoutRepeatCountIsDeduplicated() {
        val f = StylusKeyFilter()
        assertTrue(f.onKey(down, StylusKeyCodes.SECONDARY, 0).event!!.pressed)
        val dup = f.onKey(down, StylusKeyCodes.SECONDARY, 0)
        assertTrue(dup.consume)
        assertNull(dup.event)
    }

    @Test
    fun strayReleaseIsSwallowedSilently() {
        val f = StylusKeyFilter()
        val u = f.onKey(up, StylusKeyCodes.PRIMARY, 0)
        assertTrue(u.consume)
        assertNull(u.event)
    }

    @Test
    fun independentButtonsTrackSeparately() {
        val f = StylusKeyFilter()
        f.onKey(down, StylusKeyCodes.PRIMARY, 0)
        assertEquals(StylusButtonEvent(309, true), f.onKey(down, StylusKeyCodes.SECONDARY, 0).event)
        assertEquals(setOf(308, 309), f.pressedKeys)
        assertEquals(StylusButtonEvent(308, false), f.onKey(up, StylusKeyCodes.PRIMARY, 0).event)
        assertEquals(setOf(309), f.pressedKeys)
    }

    @Test
    fun releaseAllReleasesHeldKeysOnce() {
        val f = StylusKeyFilter()
        f.onKey(down, StylusKeyCodes.PRIMARY, 0)
        f.onKey(down, StylusKeyCodes.TAIL, 0)
        assertEquals(
            listOf(StylusButtonEvent(308, false), StylusButtonEvent(311, false)),
            f.releaseAll(),
        )
        assertTrue(f.releaseAll().isEmpty())
        // The real release arriving later is not reported a second time…
        assertNull(f.onKey(up, StylusKeyCodes.PRIMARY, 0).event)
        // …and the next press works normally.
        assertTrue(f.onKey(down, StylusKeyCodes.PRIMARY, 0).event!!.pressed)
    }

    @Test
    fun otherActionsOnStylusKeysAreSwallowed() {
        val f = StylusKeyFilter()
        val multiple = 2 // KeyEvent.ACTION_MULTIPLE
        val d = f.onKey(multiple, StylusKeyCodes.PRIMARY, 0)
        assertTrue(d.consume)
        assertNull(d.event)
        assertFalse(f.pressedKeys.contains(StylusKeyCodes.PRIMARY))
    }

    @Test
    fun customKeySet() {
        val f = StylusKeyFilter(setOf(313))
        assertFalse(f.isStylusKey(308))
        assertEquals(StylusKeyFilter.Decision.PASS, f.onKey(down, 308, 0))
        assertEquals(StylusButtonEvent(313, true), f.onKey(down, 313, 0).event)
    }
}
