package app.inkstone.ink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InkTipStyleTest {
    // ---- The clear colour: the overlay covers the whole WebView. ----

    @Test
    fun clearColourIsFullyTransparent() {
        assertTrue(InkTipColor.isFullyTransparent(InkTipColor.CLEAR))
        // Transparent black, i.e. premultiplied zero: no colour can bleed through on any blend path.
        assertEquals(0, InkTipColor.CLEAR)
    }

    @Test
    fun transparencyChecksOnlyLookAtAlpha() {
        assertTrue(InkTipColor.isFullyTransparent(0x00FFFFFF))
        assertFalse(InkTipColor.isFullyTransparent(0x01000000))
        assertFalse(InkTipColor.isFullyTransparent(0xFF000000.toInt()))
        assertTrue(InkTipColor.isOpaque(0xFF000000.toInt()))
        assertFalse(InkTipColor.isOpaque(0xFE000000.toInt()))
    }

    // ---- Colour parsing ("#AARRGGBB", as @inkstone/core writes it). ----

    @Test
    fun parsesAarrggbb() {
        assertEquals(0xFF1B1F24.toInt(), InkTipColor.parse("#FF1B1F24"))
        assertEquals(0xFF1B1F24.toInt(), InkTipColor.parse("#ff1b1f24"))
        assertEquals(0x80FF0000.toInt(), InkTipColor.parse("#80FF0000"))
        assertEquals(0x00000000, InkTipColor.parse("#00000000"))
        assertEquals(0xFFFFFFFF.toInt(), InkTipColor.parse("#FFFFFFFF"))
    }

    @Test
    fun acceptsTheOtherFormsCoreParseArgbReads() {
        assertEquals(0xFF1B1F24.toInt(), InkTipColor.parse("#1B1F24")) // #RRGGBB is opaque
        assertEquals(0xFF1B1F24.toInt(), InkTipColor.parse("FF1B1F24")) // '#' optional
        assertEquals(0xFF1B1F24.toInt(), InkTipColor.parse("1b1f24"))
    }

    @Test
    fun rejectsJunk() {
        val junk = listOf(
            null, "", "#", "#FFF", "#FF1B1F2", "#FF1B1F245", "#FF1B1F24FF", "#GG1B1F24", "#FF1B1F2Z",
            "red", "rgba(0,0,0,1)", " #FF000000", "#FF000000 ", "#FF00 000", "#+F000000", "#-F000000",
            "0xFF000000", "##FF0000", "null", "#FF١B1F24",
        )
        for (s in junk) assertNull("should reject '$s'", InkTipColor.parse(s))
    }

    // ---- Style from inkTipBegin's arguments. ----

    @Test
    fun styleFromBeginArguments() {
        val s = notNull(InkTipStyle.from("#FF1B1F24", 2.0, 40.0, 2.625f))
        assertEquals(0xFF1B1F24.toInt(), s.argb)
        assertEquals(5.25f, s.widthPx, 1e-6f) // CSS px × density
        assertEquals(40.0, s.tailMs, 0.0)
        assertEquals(32f * 2.625f, s.maxPredictionPx, 1e-4f)
    }

    @Test
    fun onlyOpaqueColoursAreDrawn() {
        // The tip overlaps the web ink for a moment: over see-through ink that would show darker.
        assertNull(InkTipStyle.from("#80FF0000", 2.0, 40.0, 2f))
        assertNull(InkTipStyle.from("#FEFF0000", 2.0, 40.0, 2f))
        assertNull(InkTipStyle.from("#00000000", 2.0, 40.0, 2f))
        assertNotNull(InkTipStyle.from("#FFFF0000", 2.0, 40.0, 2f))
    }

    @Test
    fun junkColourOrWidthDrawsNothing() {
        assertNull(InkTipStyle.from("blue", 2.0, 40.0, 2f))
        assertNull(InkTipStyle.from(null, 2.0, 40.0, 2f))
        for (w in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 0.0, -1.0, -0.0)) {
            assertNull("width $w", InkTipStyle.from("#FF000000", w, 40.0, 2f))
        }
    }

    @Test
    fun widthIsClampedToADrawableRange() {
        assertEquals(InkTipStyle.MIN_WIDTH_PX, InkTipStyle.cssToPx(0.1, 1f)!!, 0f)
        assertEquals(InkTipStyle.MAX_WIDTH_PX, InkTipStyle.cssToPx(5000.0, 3f)!!, 0f)
        assertEquals(12f, InkTipStyle.cssToPx(4.0, 3f)!!, 0f)
        assertNull(InkTipStyle.cssToPx(Double.NaN, 3f))
    }

    @Test
    fun badDensityFallsBackToOne() {
        for (d in listOf(0f, -2f, Float.NaN, Float.POSITIVE_INFINITY)) {
            val s = notNull(InkTipStyle.from("#FF000000", 3.0, 40.0, d))
            assertEquals("density $d", 3f, s.widthPx, 0f)
            assertEquals(InkTipStyle.MAX_PREDICTION_DP, s.maxPredictionPx, 0f)
        }
    }

    @Test
    fun tailFallsBackAndIsCapped() {
        for (t in listOf(Double.NaN, 0.0, -5.0, Double.POSITIVE_INFINITY)) {
            assertEquals("tail $t", InkTipStyle.DEFAULT_TAIL_MS, InkTipStyle.from("#FF000000", 2.0, t, 2f)!!.tailMs, 0.0)
        }
        assertEquals(InkTipStyle.MAX_TAIL_MS, InkTipStyle.from("#FF000000", 2.0, 1000.0, 2f)!!.tailMs, 0.0)
        assertEquals(25.0, InkTipStyle.from("#FF000000", 2.0, 25.0, 2f)!!.tailMs, 0.0)
        // The longest tail fits the ring many times over even at a 500 Hz digitizer.
        assertTrue(InkTipStyle.MAX_TAIL_MS * 0.5 < InkTipSamples.DEFAULT_CAPACITY)
    }

    // ---- Frame bounds (what the renderer clears when the next frame replaces this one). ----

    @Test
    fun frameBoundsCoverRoundCapsAndAntiAliasing() {
        val f = InkTipFrame(floatArrayOf(10f, 20f, 30f, 5f, 25f, 12f), 0xFF000000.toInt(), 4f)
        val g = 4f / 2 + InkTipFrame.AA_MARGIN_PX
        assertEquals(InkTipBounds(10f - g, 5f - g, 30f + g, 20f + g), f.bounds)
        assertEquals(3, f.pointCount)
    }

    @Test
    fun singlePointFrameHasBoundsOfItsDot() {
        val f = InkTipFrame(floatArrayOf(50f, 60f), 0xFF000000.toInt(), 10f)
        val g = 5f + InkTipFrame.AA_MARGIN_PX
        assertEquals(InkTipBounds(50f - g, 60f - g, 50f + g, 60f + g), f.bounds)
        assertFalse(f.bounds.isEmpty)
    }

    @Test
    fun emptyFrameHasEmptyBounds() {
        assertTrue(InkTipFrame.EMPTY.isEmpty)
        assertTrue(InkTipFrame.EMPTY.bounds.isEmpty)
        assertTrue(InkTipColor.isFullyTransparent(InkTipFrame.EMPTY.argb))
    }

    @Test
    fun boundsUnionIgnoresEmptyBoxes() {
        val a = InkTipBounds(0f, 0f, 10f, 10f)
        val b = InkTipBounds(5f, -5f, 20f, 8f)
        assertEquals(InkTipBounds(0f, -5f, 20f, 10f), a.union(b))
        assertEquals(a, a.union(InkTipBounds.EMPTY))
        assertEquals(b, InkTipBounds.EMPTY.union(b))
        assertTrue(InkTipBounds.EMPTY.union(InkTipBounds.EMPTY).isEmpty)
    }

    private fun <T> notNull(value: T?): T {
        assertNotNull(value)
        return value!!
    }
}
