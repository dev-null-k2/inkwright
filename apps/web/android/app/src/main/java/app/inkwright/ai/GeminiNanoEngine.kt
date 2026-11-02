package app.inkwright.ai

import android.util.Log
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Content
import com.google.mlkit.genai.prompt.Feature
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Gemini Nano through the ML Kit GenAI Prompt API. AICore (Android System Intelligence) owns the
 * model: it is shared by every app, downloaded once by the system, and runs on the phone's NPU or
 * GPU. Nothing is sent anywhere. Availability depends on the phone (see docs/ANDROID.md); AICore
 * answers `unavailable` everywhere else, which is the normal case on most phones and the emulator.
 *
 * Every call suspends; ML Kit does the work on its own executor, never the main thread.
 */
class GeminiNanoEngine {
    private val model: GenerativeModel by lazy { Generation.getClient() }
    private val mutex = Mutex()
    private var systemPrompt: Boolean? = null

    /** Feature status, or unavailable when AICore is missing or errors (old Play services, emulators). */
    suspend fun state(): EngineState = try {
        EngineState.fromFeatureStatus(model.checkStatus())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Log.i(TAG, "Gemini Nano status unavailable: ${e.message}")
        EngineState.UNAVAILABLE
    }

    /** The model's name as AICore reports it (e.g. a Gemini Nano version), when available. */
    suspend fun modelName(): String? = runCatching { model.getBaseModelName() }.getOrNull()

    /** Token limit of one request (input + output), when AICore reports one. */
    suspend fun tokenLimit(): Int? = runCatching { model.getTokenLimit() }.getOrNull()?.takeIf { it > 0 }

    /** Asks AICore to download Gemini Nano; the flow ends when it completes or fails. */
    fun download(): Flow<DownloadEvent> = model.download().map { s ->
        when (s) {
            is DownloadStatus.DownloadStarted -> DownloadEvent.Started(s.bytesToDownload)
            is DownloadStatus.DownloadProgress -> DownloadEvent.Progress(s.totalBytesDownloaded)
            is DownloadStatus.DownloadCompleted -> DownloadEvent.Completed
            is DownloadStatus.DownloadFailed -> DownloadEvent.Failed(GenAiErrors.describe(s.e.errorCode, s.e.message, s.e))
        }
    }

    /**
     * Streams an answer to [prompt]. Multi-turn input goes in as alternating contents; if this
     * AICore version rejects that shape before producing text, the conversation is sent again as
     * one message ([ChatPrompt.flattened]). One request at a time: AICore answers BUSY otherwise.
     */
    suspend fun generate(prompt: ChatPrompt, maxTokens: Int?, temperature: Double?, out: StreamAssembler): String = mutex.withLock {
        val sys = systemPrompt ?: runCatching { Feature.SYSTEM_PROMPT in model.getAvailableFeatures() }.getOrDefault(false).also { systemPrompt = it }
        try {
            run(request(prompt, sys, multiTurn = prompt.history.isNotEmpty(), maxTokens, temperature), out)
        } catch (e: GenAiException) {
            val shapeRejected = e.errorCode == GenAiErrors.REQUEST_PROCESSING_ERROR || e.errorCode == GenAiErrors.NOT_SUPPORTED
            if (prompt.history.isNotEmpty() && out.soFar.isEmpty() && shapeRejected) {
                try {
                    run(request(prompt, sys, multiTurn = false, maxTokens, temperature), out)
                } catch (e2: GenAiException) {
                    throw GenAiErrors.describe(e2.errorCode, e2.message, e2)
                }
            } else {
                throw GenAiErrors.describe(e.errorCode, e.message, e)
            }
        }
    }

    private suspend fun run(req: GenerateContentRequest, out: StreamAssembler): String {
        model.generateContentStream(req).collect { r ->
            r.candidates.firstOrNull()?.text?.let(out::push)
        }
        return out.finish()
    }

    private fun request(p: ChatPrompt, systemSupported: Boolean, multiTurn: Boolean, maxTokens: Int?, temperature: Double?): GenerateContentRequest {
        val withSystem = !systemSupported
        val builder = if (multiTurn) {
            val contents = ArrayList<Content>()
            p.history.forEachIndexed { i, t ->
                val text = if (i == 0 && withSystem && p.system.isNotBlank()) "${p.system}\n\n${t.text}" else t.text
                contents += Content.Builder().role(if (t.role == ChatPrompt.Role.USER) Content.Role.USER else Content.Role.MODEL).text(text).build()
            }
            contents += Content.Builder().role(Content.Role.USER).text(p.last).build()
            GenerateContentRequest.Builder(contents)
        } else {
            GenerateContentRequest.Builder(TextPart(p.flattened(includeSystem = withSystem)))
        }
        if (systemSupported && p.system.isNotBlank()) builder.systemInstruction = SystemInstruction(p.system)
        if (maxTokens != null && maxTokens > 0) builder.maxOutputTokens = maxTokens.coerceAtMost(MAX_OUTPUT)
        if (temperature != null) builder.temperature = temperature.toFloat().coerceIn(0f, 1f)
        builder.candidateCount = 1
        return builder.build()
    }

    fun close() {
        runCatching { model.close() }
    }

    sealed class DownloadEvent {
        data class Started(val bytes: Long) : DownloadEvent()
        data class Progress(val downloaded: Long) : DownloadEvent()
        object Completed : DownloadEvent()
        data class Failed(val error: AiException) : DownloadEvent()
    }

    private companion object {
        const val TAG = "GeminiNano"
        // Gemini Nano answers are capped well below its context; a cap keeps a runaway answer short.
        const val MAX_OUTPUT = 1024
    }
}
