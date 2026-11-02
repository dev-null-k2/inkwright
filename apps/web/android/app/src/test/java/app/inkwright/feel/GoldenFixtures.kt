package app.inkwright.feel

import org.json.JSONArray
import org.json.JSONObject

/**
 * app/src/test/resources/feel-golden.json: outputs of the TypeScript reference
 * (packages/core/src/feel.ts) that the Kotlin ports must reproduce.
 */
internal object GoldenFixtures {
    val root: JSONObject by lazy {
        val stream = GoldenFixtures::class.java.classLoader!!.getResourceAsStream("feel-golden.json")
            ?: error("feel-golden.json missing from test resources")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    val synth: List<JSONObject> get() = root.getJSONArray("synth").objects()
    val grain: List<JSONObject> get() = root.getJSONArray("grain").objects()

    /** Exactly the fixture's values (no [FeelProfile.fromJson] clamping in the parity tests). */
    fun profile(o: JSONObject) = FeelProfile(
        grainPitchMm = o.getDouble("grainPitchMm"),
        grainJitter = o.getDouble("grainJitter"),
        hapticStrength = o.getDouble("hapticStrength"),
        soundBaseHz = o.getDouble("soundBaseHz"),
        soundHzPer100MmS = o.getDouble("soundHzPer100MmS"),
        soundQ = o.getDouble("soundQ"),
        soundGain = o.getDouble("soundGain"),
        crackle = o.getDouble("crackle"),
        fiberMm = o.getDouble("fiberMm"),
        texture = o.getDouble("texture"),
    )

    fun label(o: JSONObject) = "${o.getString("paper")}/${o.getString("pen")}"

    fun JSONArray.doubles(): DoubleArray = DoubleArray(length()) { getDouble(it) }

    private fun JSONArray.objects(): List<JSONObject> = List(length()) { getJSONObject(it) }
}
