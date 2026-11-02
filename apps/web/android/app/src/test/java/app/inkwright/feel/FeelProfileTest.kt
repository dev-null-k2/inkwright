package app.inkwright.feel

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class FeelProfileTest {
    @Test
    fun readsEveryField() {
        val json = JSONObject()
            .put("grainPitchMm", 0.55).put("grainJitter", 0.4).put("hapticStrength", 0.8)
            .put("soundBaseHz", 1700).put("soundHzPer100MmS", 1000).put("soundQ", 0.65)
            .put("soundGain", 0.6).put("crackle", 0.3).put("fiberMm", 0.3).put("texture", 0.65)
        assertEquals(
            FeelProfile(0.55, 0.4, 0.8, 1700.0, 1000.0, 0.65, 0.6, 0.3, 0.3, 0.65),
            FeelProfile.fromJson(json),
        )
    }

    @Test
    fun missingOrMalformedFieldsFallBackToTheDefault() {
        assertEquals(FeelProfile.DEFAULT, FeelProfile.fromJson(null))
        assertEquals(FeelProfile.DEFAULT, FeelProfile.fromJson(JSONObject()))
        val p = FeelProfile.fromJson(JSONObject().put("soundQ", "loud").put("texture", 0.2))
        assertEquals(FeelProfile.DEFAULT.soundQ, p.soundQ, 0.0)
        assertEquals(0.2, p.texture, 0.0)
    }

    @Test
    fun clampsToRangesTheSynthIsStableIn() {
        val p = FeelProfile.fromJson(
            JSONObject().put("soundBaseHz", 1e7).put("soundGain", 5).put("grainPitchMm", 0).put("soundQ", -1).put("fiberMm", -2),
        )
        assertEquals(8000.0, p.soundBaseHz, 0.0)
        assertEquals(1.0, p.soundGain, 0.0)
        assertEquals(0.05, p.grainPitchMm, 0.0)
        assertEquals(0.1, p.soundQ, 0.0)
        assertEquals(0.0, p.fiberMm, 0.0)
    }
}
