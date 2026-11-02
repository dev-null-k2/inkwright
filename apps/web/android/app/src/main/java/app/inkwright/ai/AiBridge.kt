package app.inkwright.ai

import android.content.Context
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * The `ai*` and `speech*` methods of InkwrightNativePlugin (JS side: apps/web/src/ai/native/).
 *
 *  - aiStatus({ language })          → { engines, tasks, models, ramGb, speech } — see [status]
 *  - aiDownload({ target })          → resolves when ready; events `aiDownload`
 *                                      { target, phase: started|download|verify|done|failed|cancelled, loaded, total, error? }
 *                                      target: `gemini-nano`, `task:<summarize|proofread|rewrite|describe-image>`, `litert:<model id>`
 *  - aiCancelDownload({ target })    → stops; a LiteRT part file is kept and resumes next time
 *  - aiDeleteModel({ modelId })      → deletes a LiteRT model (unloading it first)
 *  - aiUnload()                      → frees the loaded LiteRT model's memory
 *  - aiGenerate({ requestId, engine: gemini-nano|litert, modelId?, messages, maxTokens?, temperature? })
 *                                    → { text }; events `aiDelta` { requestId, delta }
 *  - aiTask({ requestId, task, language?, text?, image? (base64), style?, tone?, inputKind? }) → { text }; `aiDelta` as above
 *  - aiCancel({ requestId })         → the pending aiGenerate/aiTask rejects with code `cancelled`
 *  - speechStart({ sessionId, language? }) → { onDevice } once listening; events `speechPartial` { sessionId, text }
 *  - speechStop({ sessionId })       → { text }
 *  - speechCancel({ sessionId })
 *  - speechTranscribe({ pcm (base64 16-bit mono), sampleRate, language? }) → { text }
 *
 * Errors reject with an [AiException] code (`unsupported`, `busy`, `disk`, `network`, …) the JS
 * bridge maps to messages. Everything runs in [scope] (Dispatchers.Default / IO); only the
 * SpeechRecognizer calls hop to the main thread, as Android requires.
 */
class AiBridge(context: Context, private val scope: CoroutineScope, private val emit: (event: String, data: JSObject) -> Unit) {
    private val app = context.applicationContext
    val nano = GeminiNanoEngine()
    val tasks = GenAiTasks(app)
    val litert = LiteRtEngine(app)
    val speech = OnDeviceSpeech(app, scope)

    private val requests = ConcurrentHashMap<String, Job>()
    private val downloads = ConcurrentHashMap<String, Job>()
    private val sessions = ConcurrentHashMap<String, OnDeviceSpeech.Session>()

    fun status(call: PluginCall) = launch(call) {
        val language = call.getString("language")
        val nanoState = nano.state()
        val engines = JSArray()
        engines.put(JSObject().put("id", "gemini-nano").put("state", downloadingOr("gemini-nano", nanoState).wire).apply {
            if (nanoState == EngineState.AVAILABLE) {
                nano.tokenLimit()?.let { put("contextTokens", it) }
                nano.modelName()?.let { put("model", it) }
            }
        })
        val tasksJson = JSObject()
        // Task features only exist where Gemini Nano does; skip four AICore round trips elsewhere.
        for (t in GenAiTask.entries) {
            val s = if (nanoState == EngineState.UNAVAILABLE) EngineState.UNAVAILABLE else tasks.state(t, language)
            tasksJson.put(t.wire, downloadingOr("task:${t.wire}", s).wire)
        }
        val ram = litert.ramGb
        val models = JSArray()
        for (m in LiteRtModels.all) {
            val installed = litert.isInstalled(m)
            models.put(JSObject()
                .put("id", m.id).put("label", m.label).put("bytes", m.bytes).put("licence", m.licence).put("params", m.params)
                .put("blurb", m.blurb).put("contextTokens", m.contextTokens).put("minRamGb", m.minRamGb)
                .put("state", EngineState.forModelFile(installed, downloads["litert:${m.id}"]?.isActive == true, litert.fits(m)).wire)
                .put("partialBytes", if (installed) m.bytes else litert.partialBytes(m))
                .put("loaded", litert.loadedModelId == m.id).apply { litert.backend?.takeIf { litert.loadedModelId == m.id }?.let { put("backend", it) } })
        }
        val sp = speech.status()
        JSObject()
            .put("engines", engines)
            .put("tasks", tasksJson)
            .put("models", models)
            .put("recommendedModel", if (litert.supported) LiteRtModels.recommend(ram)?.id else null)
            .put("ramGb", ram)
            .put("speech", JSObject().put("available", sp.available).put("onDevice", sp.onDevice).put("fileInput", sp.fileInput))
    }

    private fun downloadingOr(target: String, s: EngineState) = if (downloads[target]?.isActive == true) EngineState.DOWNLOADING else s

    fun download(call: PluginCall) {
        val target = call.getString("target") ?: return call.reject("target is required", "bad-request")
        if (downloads[target]?.isActive == true) return call.reject("Already downloading.", "busy")
        val progress = { phase: String, loaded: Long, total: Long ->
            emit(EVENT_DOWNLOAD, JSObject().put("target", target).put("phase", phase).put("loaded", loaded).put("total", total))
        }
        // Lazy so the job is registered before it can finish (and unregister itself).
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                progress("started", 0, 0)
                when {
                    target == "gemini-nano" -> {
                        var total = 0L
                        nano.download().collect { e ->
                            when (e) {
                                is GeminiNanoEngine.DownloadEvent.Started -> { total = e.bytes; progress("download", 0, total) }
                                is GeminiNanoEngine.DownloadEvent.Progress -> if (e.downloaded >= 0) progress("download", e.downloaded, total)
                                GeminiNanoEngine.DownloadEvent.Completed -> Unit
                                is GeminiNanoEngine.DownloadEvent.Failed -> throw e.error
                            }
                        }
                    }
                    target.startsWith("task:") -> {
                        val task = GenAiTask.fromWire(target.removePrefix("task:")) ?: throw AiException("bad-request", "Unknown task.")
                        tasks.download(task, call.getString("language")) { l, t -> progress("download", l, t) }
                    }
                    target.startsWith("litert:") -> {
                        val model = LiteRtModels.byId(target.removePrefix("litert:")) ?: throw AiException("bad-request", "Unknown model.")
                        if (!litert.fits(model)) throw AiException("memory", "${model.label} needs more memory than this phone has.")
                        litert.downloader.download(model) { phase, l, t -> progress(phase, l, t) }
                    }
                    else -> throw AiException("bad-request", "Unknown download.")
                }
                progress("done", 1, 1)
                call.resolve(JSObject().put("state", EngineState.AVAILABLE.wire))
            } catch (e: CancellationException) {
                emit(EVENT_DOWNLOAD, JSObject().put("target", target).put("phase", "cancelled"))
                call.reject("Download cancelled.", "cancelled")
            } catch (e: Throwable) {
                val err = asAi(e)
                emit(EVENT_DOWNLOAD, JSObject().put("target", target).put("phase", "failed").put("error", err.message).put("code", err.code))
                call.reject(err.message, err.code)
            } finally {
                downloads.remove(target)
            }
        }
        downloads[target] = job
        job.start()
    }

    fun cancelDownload(call: PluginCall) {
        call.getString("target")?.let { downloads[it]?.cancel() }
        call.resolve()
    }

    fun deleteModel(call: PluginCall) = launch(call) {
        val model = LiteRtModels.byId(call.getString("modelId")) ?: throw AiException("bad-request", "Unknown model.")
        downloads["litert:${model.id}"]?.cancel()
        litert.delete(model)
        JSObject()
    }

    fun unload(call: PluginCall) = launch(call) {
        litert.unload()
        JSObject()
    }

    fun generate(call: PluginCall) = request(call) { out ->
        val messages = call.getArray("messages") ?: throw AiException("bad-request", "messages is required")
        val wire = (0 until messages.length()).mapNotNull { i ->
            messages.optJSONObject(i)?.let { ChatPromptBuilder.WireMessage(it.optString("role"), it.optString("content")) }
        }
        val maxTokens = call.getInt("maxTokens")
        val temperature = call.getDouble("temperature")
        when (call.getString("engine")) {
            "gemini-nano" -> {
                // ~3 characters per token leaves room for the answer inside Nano's token limit.
                val limit = nano.tokenLimit() ?: 4096
                nano.generate(ChatPromptBuilder.build(wire, maxChars = (limit - (maxTokens ?: 512)).coerceAtLeast(512) * 3), maxTokens, temperature, out)
            }
            "litert" -> {
                val model = LiteRtModels.byId(call.getString("modelId")) ?: throw AiException("bad-request", "Unknown model.")
                litert.generate(model, ChatPromptBuilder.build(wire, maxChars = (model.contextTokens - (maxTokens ?: 512)).coerceAtLeast(256) * 3), maxTokens, temperature, out)
            }
            else -> throw AiException("bad-request", "Unknown engine.")
        }
    }

    fun task(call: PluginCall) = request(call) { out ->
        val task = GenAiTask.fromWire(call.getString("task")) ?: throw AiException("bad-request", "Unknown task.")
        val image = call.getString("image")?.let { b64 ->
            val bytes = Base64.decode(b64.substringAfter("base64,"), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw AiException("bad-image", "Couldn’t read that image.")
        }
        tasks.run(
            GenAiTasks.Request(task, call.getString("language"), call.getString("text") ?: "", image, call.getString("style"), call.getString("tone"), call.getString("inputKind")),
            out,
        )
    }

    fun cancel(call: PluginCall) {
        call.getString("requestId")?.let { requests[it]?.cancel() }
        call.resolve()
    }

    /** Runs a streaming request: deltas go out as `aiDelta`, the answer resolves the call. */
    private fun request(call: PluginCall, body: suspend (StreamAssembler) -> String) {
        val id = call.getString("requestId") ?: return call.reject("requestId is required", "bad-request")
        val out = StreamAssembler(emit = { d -> emit(EVENT_DELTA, JSObject().put("requestId", id).put("delta", d)) })
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                call.resolve(JSObject().put("text", body(out)))
            } catch (e: CancellationException) {
                call.reject("Stopped.", "cancelled")
            } catch (e: Throwable) {
                val err = asAi(e)
                Log.w(TAG, "AI request failed: ${err.code}", e)
                call.reject(err.message, err.code)
            } finally {
                requests.remove(id)
            }
        }
        requests[id] = job
        job.start()
    }

    fun speechStart(call: PluginCall) = launch(call) {
        val id = call.getString("sessionId") ?: throw AiException("bad-request", "sessionId is required")
        sessions.remove(id)?.cancel()
        val session = speech.start(call.getString("language")) { text ->
            emit(EVENT_SPEECH, JSObject().put("sessionId", id).put("text", text))
        }
        sessions[id] = session
        JSObject().put("onDevice", session.onDevice)
    }

    fun speechStop(call: PluginCall) = launch(call) {
        val session = sessions.remove(call.getString("sessionId") ?: "") ?: throw AiException("bad-request", "Not listening.")
        JSObject().put("text", session.stop())
    }

    fun speechCancel(call: PluginCall) = launch(call) {
        sessions.remove(call.getString("sessionId") ?: "")?.cancel()
        JSObject()
    }

    fun speechTranscribe(call: PluginCall) = launch(call) {
        val pcm = Base64.decode(call.getString("pcm") ?: throw AiException("bad-request", "pcm is required"), Base64.DEFAULT)
        val rate = call.getInt("sampleRate") ?: 16_000
        JSObject().put("text", speech.transcribe(pcm, rate, call.getString("language")))
    }

    /** Ends everything: the plugin is going away. */
    fun close() {
        requests.values.forEach { it.cancel() }
        downloads.values.forEach { it.cancel() }
        sessions.clear()
        nano.close()
    }

    private fun launch(call: PluginCall, body: suspend () -> JSObject) {
        scope.launch {
            try {
                call.resolve(body())
            } catch (e: CancellationException) {
                call.reject("Stopped.", "cancelled")
            } catch (e: Throwable) {
                val err = asAi(e)
                call.reject(err.message, err.code)
            }
        }
    }

    private fun asAi(e: Throwable): AiException = when (e) {
        is AiException -> e
        is OutOfMemoryError -> AiException("memory", "Not enough memory for on-device AI right now. Close other apps or choose a smaller model.")
        else -> AiException("failed", e.message ?: "On-device AI failed.", retryable = true, cause = e)
    }

    companion object {
        const val EVENT_DELTA = "aiDelta"
        const val EVENT_DOWNLOAD = "aiDownload"
        const val EVENT_SPEECH = "speechPartial"
        private const val TAG = "InkwrightAI"
    }
}
