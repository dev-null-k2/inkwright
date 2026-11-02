package app.inkwright.ai

import android.speech.SpeechRecognizer
import com.google.mlkit.genai.proofreading.ProofreaderOptions
import com.google.mlkit.genai.rewriting.RewriterOptions
import com.google.mlkit.genai.summarization.SummarizerOptions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CatalogAndTasksTest {
    @Test
    fun catalogIsPinnedAndOpenLicensed() {
        val ids = HashSet<String>()
        for (m in LiteRtModels.all) {
            assertTrue("duplicate id ${m.id}", ids.add(m.id))
            assertTrue("${m.id} licence", m.licence == "Apache-2.0" || m.licence == "MIT")
            assertTrue("${m.id} revision must be a full commit", Regex("^[0-9a-f]{40}$").matches(m.revision))
            assertTrue("${m.id} sha256", Regex("^[0-9a-f]{64}$").matches(m.sha256))
            assertTrue(m.file.endsWith(".litertlm"))
            assertTrue(m.bytes > 100_000_000)
            assertEquals("https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}", m.url)
        }
    }

    @Test
    fun recommendsByMemory() {
        assertEquals("gemma-4-e2b", LiteRtModels.recommend(7.4)?.id) // an "8 GB" phone
        assertEquals("gemma-4-e2b", LiteRtModels.recommend(15.2)?.id) // E4B is a choice, never the default
        assertEquals("qwen3-1.7b", LiteRtModels.recommend(5.5)?.id)
        assertEquals("qwen3-0.6b", LiteRtModels.recommend(3.6)?.id)
        assertNull(LiteRtModels.recommend(2.0))
        assertEquals("qwen3-1.7b", LiteRtModels.recommend(0.0)?.id) // unknown memory: a safe middle
        assertFalse(LiteRtModels.byId("gemma-4-e4b")!!.fits(7.4))
        assertTrue(LiteRtModels.byId("gemma-4-e4b")!!.fits(11.3))
    }

    @Test
    fun taskLanguages() {
        assertEquals(TaskOptions.LANG_GERMAN, TaskOptions.language(GenAiTask.PROOFREAD, "de-AT"))
        assertEquals(TaskOptions.LANG_SPANISH, TaskOptions.language(GenAiTask.REWRITE, "es_MX"))
        assertEquals(TaskOptions.LANG_ENGLISH, TaskOptions.language(GenAiTask.SUMMARIZE, null))
        assertEquals(TaskOptions.LANG_JAPANESE, TaskOptions.language(GenAiTask.SUMMARIZE, "ja"))
        // Summaries only in English, Japanese, Korean: a German note goes to the Prompt API instead.
        assertNull(TaskOptions.language(GenAiTask.SUMMARIZE, "de"))
        assertNull(TaskOptions.language(GenAiTask.PROOFREAD, "nl"))
        assertNull(TaskOptions.language(GenAiTask.DESCRIBE_IMAGE, "fr"))
        assertEquals(TaskOptions.LANG_ENGLISH, TaskOptions.language(GenAiTask.DESCRIBE_IMAGE, "en-GB"))
        assertEquals(GenAiTask.DESCRIBE_IMAGE, GenAiTask.fromWire("describe-image"))
        assertNull(GenAiTask.fromWire("translate"))
    }

    @Test
    fun taskOptionInts() {
        assertEquals(TaskOptions.SUMMARY_ONE_BULLET, TaskOptions.summaryOutput("short"))
        assertEquals(TaskOptions.SUMMARY_THREE_BULLETS, TaskOptions.summaryOutput("bullets"))
        assertEquals(TaskOptions.PROOFREAD_INPUT_VOICE, TaskOptions.proofreadInput("voice"))
        assertEquals(TaskOptions.PROOFREAD_INPUT_KEYBOARD, TaskOptions.proofreadInput("handwriting"))
        assertEquals(TaskOptions.REWRITE_SHORTEN, TaskOptions.rewriteOutput("shorten"))
        assertNull(TaskOptions.rewriteOutput("pirate"))
    }

    @Test
    fun mirroredTaskConstantsMatchMlKit() {
        assertEquals(SummarizerOptions.InputType.ARTICLE, TaskOptions.SUMMARY_INPUT_ARTICLE)
        assertEquals(SummarizerOptions.OutputType.ONE_BULLET, TaskOptions.SUMMARY_ONE_BULLET)
        assertEquals(SummarizerOptions.OutputType.THREE_BULLETS, TaskOptions.SUMMARY_THREE_BULLETS)
        assertEquals(SummarizerOptions.Language.KOREAN, TaskOptions.LANG_KOREAN)
        assertEquals(ProofreaderOptions.Language.GERMAN, TaskOptions.LANG_GERMAN)
        assertEquals(ProofreaderOptions.Language.SPANISH, TaskOptions.LANG_SPANISH)
        assertEquals(ProofreaderOptions.InputType.VOICE, TaskOptions.PROOFREAD_INPUT_VOICE)
        assertEquals(RewriterOptions.Language.FRENCH, TaskOptions.LANG_FRENCH)
        assertEquals(RewriterOptions.OutputType.PROFESSIONAL, TaskOptions.REWRITE_PROFESSIONAL)
        assertEquals(RewriterOptions.OutputType.REPHRASE, TaskOptions.REWRITE_REPHRASE)
    }

    @Test
    fun speechTranscriptAssembly() {
        val t = SpeechTranscript()
        t.partial("buy")
        t.partial("buy milk")
        assertEquals("buy milk", t.live)
        t.segment("Buy milk.")
        t.partial("and")
        assertEquals("Buy milk. and", t.live)
        assertEquals("Buy milk. And eggs.", t.final("And eggs."))
        // No final result (stopped by an error after speech): the partial is kept.
        val u = SpeechTranscript()
        u.partial("half a sentence")
        assertEquals("half a sentence", u.final(null))
        assertEquals("", SpeechTranscript().final("  "))
    }

    @Test
    fun speechErrors() {
        assertEquals(SpeechRecognizer.ERROR_NO_MATCH, SpeechErrors.NO_MATCH)
        assertEquals(SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechErrors.SPEECH_TIMEOUT)
        assertEquals(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS, SpeechErrors.INSUFFICIENT_PERMISSIONS)
        assertEquals(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE, SpeechErrors.LANGUAGE_UNAVAILABLE)
        assertEquals(SpeechRecognizer.ERROR_CLIENT, SpeechErrors.CLIENT)
        assertTrue(SpeechErrors.isEmptyResult(SpeechErrors.NO_MATCH))
        assertFalse(SpeechErrors.isEmptyResult(SpeechErrors.AUDIO))
        assertEquals("permission", SpeechErrors.describe(SpeechErrors.INSUFFICIENT_PERMISSIONS).code)
        assertEquals("language-download", SpeechErrors.describe(SpeechErrors.LANGUAGE_UNAVAILABLE).code)
        assertEquals("network", SpeechErrors.describe(SpeechErrors.NETWORK_TIMEOUT).code)
    }
}
