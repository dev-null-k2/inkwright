package app.inkstone.ai

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineStateTest {
    @Test
    fun mirroredConstantsMatchMlKit() {
        // If ML Kit renumbers these, our mapping (and the JVM tests below) would silently lie.
        assertEquals(FeatureStatus.UNAVAILABLE, EngineState.FEATURE_UNAVAILABLE)
        assertEquals(FeatureStatus.DOWNLOADABLE, EngineState.FEATURE_DOWNLOADABLE)
        assertEquals(FeatureStatus.DOWNLOADING, EngineState.FEATURE_DOWNLOADING)
        assertEquals(FeatureStatus.AVAILABLE, EngineState.FEATURE_AVAILABLE)
        assertEquals(GenAiException.ErrorCode.BUSY, GenAiErrors.BUSY)
        assertEquals(GenAiException.ErrorCode.NOT_SUPPORTED, GenAiErrors.NOT_SUPPORTED)
        assertEquals(GenAiException.ErrorCode.NOT_AVAILABLE, GenAiErrors.NOT_AVAILABLE)
        assertEquals(GenAiException.ErrorCode.REQUEST_PROCESSING_ERROR, GenAiErrors.REQUEST_PROCESSING_ERROR)
        assertEquals(GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED, GenAiErrors.PER_APP_BATTERY_USE_QUOTA_EXCEEDED)
        assertEquals(GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED, GenAiErrors.BACKGROUND_USE_BLOCKED)
        assertEquals(GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE, GenAiErrors.NOT_ENOUGH_DISK_SPACE)
        assertEquals(GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE, GenAiErrors.NEEDS_SYSTEM_UPDATE)
        assertEquals(GenAiException.ErrorCode.AICORE_INCOMPATIBLE, GenAiErrors.AICORE_INCOMPATIBLE)
        assertEquals(GenAiException.ErrorCode.REQUEST_TOO_LARGE, GenAiErrors.REQUEST_TOO_LARGE)
        assertEquals(GenAiException.ErrorCode.MAX_TURNS_EXCEEDED, GenAiErrors.MAX_TURNS_EXCEEDED)
        assertEquals(GenAiException.ErrorCode.CANCELLED, GenAiErrors.CANCELLED)
    }

    @Test
    fun featureStatusMapsToWireStates() {
        assertEquals("available", EngineState.fromFeatureStatus(FeatureStatus.AVAILABLE).wire)
        assertEquals("downloadable", EngineState.fromFeatureStatus(FeatureStatus.DOWNLOADABLE).wire)
        assertEquals("downloading", EngineState.fromFeatureStatus(FeatureStatus.DOWNLOADING).wire)
        assertEquals("unavailable", EngineState.fromFeatureStatus(FeatureStatus.UNAVAILABLE).wire)
        // A status a newer AICore might add is not mistaken for "ready".
        assertEquals(EngineState.UNAVAILABLE, EngineState.fromFeatureStatus(42))
        assertEquals(EngineState.UNAVAILABLE, EngineState.fromFeatureStatus(-1))
    }

    @Test
    fun modelFileState() {
        assertEquals(EngineState.AVAILABLE, EngineState.forModelFile(installed = true, downloading = false, fits = true))
        assertEquals(EngineState.DOWNLOADABLE, EngineState.forModelFile(installed = false, downloading = false, fits = true))
        assertEquals(EngineState.DOWNLOADING, EngineState.forModelFile(installed = false, downloading = true, fits = true))
        // Too big for this phone's memory: never offered, even if a file is somehow present.
        assertEquals(EngineState.UNAVAILABLE, EngineState.forModelFile(installed = true, downloading = false, fits = false))
    }

    @Test
    fun errorsBecomeStableCodesAndPlainCopy() {
        val busy = GenAiErrors.describe(GenAiErrors.BUSY)
        assertEquals("busy", busy.code)
        assertTrue(busy.retryable)
        assertEquals("quota", GenAiErrors.describe(GenAiErrors.PER_APP_BATTERY_USE_QUOTA_EXCEEDED).code)
        assertEquals("update", GenAiErrors.describe(GenAiErrors.AICORE_INCOMPATIBLE).code)
        assertEquals("update", GenAiErrors.describe(GenAiErrors.NEEDS_SYSTEM_UPDATE).code)
        val unsupported = GenAiErrors.describe(GenAiErrors.NOT_SUPPORTED)
        assertEquals("unsupported", unsupported.code)
        assertFalse(unsupported.retryable)
        assertEquals("too-large", GenAiErrors.describe(GenAiErrors.MAX_TURNS_EXCEEDED).code)
        val other = GenAiErrors.describe(12345, "engine said no")
        assertEquals("failed", other.code)
        assertTrue(other.message!!.endsWith("engine said no"))
    }
}
