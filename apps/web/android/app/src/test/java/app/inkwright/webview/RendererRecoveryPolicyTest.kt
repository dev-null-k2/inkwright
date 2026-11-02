package app.inkwright.webview

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererRecoveryPolicyTest {
    @Test
    fun recoversOccasionalLosses() {
        val p = RendererRecoveryPolicy(maxRecoveries = 3, windowMs = 60_000)
        assertTrue(p.shouldRecover(0))
        assertTrue(p.shouldRecover(120_000))
        assertTrue(p.shouldRecover(240_000))
        assertTrue(p.shouldRecover(360_000))
    }

    @Test
    fun stopsRecoveringARestartLoop() {
        val p = RendererRecoveryPolicy(maxRecoveries = 3, windowMs = 60_000)
        assertTrue(p.shouldRecover(1_000))
        assertTrue(p.shouldRecover(5_000))
        assertTrue(p.shouldRecover(9_000))
        assertFalse(p.shouldRecover(12_000))
        assertFalse(p.shouldRecover(30_000))
    }

    @Test
    fun recoversAgainOnceTheWindowHasPassed() {
        val p = RendererRecoveryPolicy(maxRecoveries = 2, windowMs = 10_000)
        assertTrue(p.shouldRecover(0))
        assertTrue(p.shouldRecover(1_000))
        assertFalse(p.shouldRecover(2_000))
        assertTrue(p.shouldRecover(11_000)) // the loss at 0 has aged out
    }
}
