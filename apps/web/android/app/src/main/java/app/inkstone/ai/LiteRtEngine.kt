package app.inkstone.ai

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Open models (Gemma 4, Qwen3) through LiteRT-LM, for phones without Gemini Nano. The model file is
 * downloaded once into the app's no-backup files (a 2 GB file must not count against Android's
 * backup quota) and runs on the GPU through OpenCL, falling back to the CPU (XNNPACK) when the GPU
 * delegate can't start. NPU backends need a model compiled for one specific chip plus the vendor's
 * dispatch libraries, so they aren't used (docs/ANDROID.md).
 *
 * One engine is loaded at a time (they hold the weights in memory); loading takes a few seconds the
 * first time (GPU kernels compile and are cached in [cacheDir]) and the engine stays loaded for the
 * next question until [unload] — when the person picks another model or deletes it.
 */
class LiteRtEngine(private val context: Context) {
    private val dir = File(context.noBackupFilesDir, "models/litert")
    val downloader = ModelDownloader(dir)
    private val mutex = Mutex()
    private var loaded: Loaded? = null

    private class Loaded(val model: LiteRtModel, val engine: Engine, val backend: String)

    /** Total memory in GB as Android reports it (an "8 GB" phone reports ~7.4). */
    val ramGb: Double by lazy {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo().also(am::getMemoryInfo)
        info.totalMem / 1_073_741_824.0
    }

    /** LiteRT-LM ships native code for arm64-v8a and x86_64 only; 32-bit-only phones can't run it. */
    val supported: Boolean = Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }

    /** The model can run here: a 64-bit ABI and enough memory. */
    fun fits(model: LiteRtModel) = supported && model.fits(ramGb)

    fun isInstalled(model: LiteRtModel) = downloader.isInstalled(model)
    fun partialBytes(model: LiteRtModel) = downloader.partialBytes(model)

    /** The backend of the loaded engine (`gpu` / `cpu`), for "how is it running" in Settings. */
    val backend: String? get() = loaded?.backend
    val loadedModelId: String? get() = loaded?.model?.id

    suspend fun delete(model: LiteRtModel) {
        mutex.withLock {
            if (loaded?.model?.id == model.id) closeLoaded()
        }
        withContext(Dispatchers.IO) { downloader.delete(model) }
    }

    suspend fun unload() = mutex.withLock { closeLoaded() }

    /**
     * Streams an answer. A fresh conversation per request: the web layer sends the whole (already
     * budgeted) history each time, so no native state can drift from what the person sees.
     */
    suspend fun generate(model: LiteRtModel, prompt: ChatPrompt, maxTokens: Int?, temperature: Double?, out: StreamAssembler): String = mutex.withLock {
        withContext(Dispatchers.Default) {
            val engine = load(model)
            val initial = prompt.history.map { if (it.role == ChatPrompt.Role.USER) Message.user(it.text) else Message.model(it.text) }
            val sampler = SamplerConfig(topK = 40, topP = 0.95, temperature = (temperature ?: 0.7).coerceIn(0.0, 1.5), seed = 0)
            val config = ConversationConfig(
                // An empty system message still keeps the Qwen3 template from rendering an empty preface.
                systemInstruction = Contents.of(prompt.system.ifBlank { "You are a helpful assistant." }),
                initialMessages = initial,
                samplerConfig = sampler,
                maxOutputToken = maxTokens?.takeIf { it > 0 }?.coerceAtMost(model.contextTokens / 2),
            )
            engine.createConversation(config).use { conv ->
                try {
                    // Qwen3's template thinks unless told not to; Gemma's ignores the flag.
                    conv.sendMessageAsync(prompt.last, mapOf("enable_thinking" to false)).collect { msg ->
                        val t = msg.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }
                        out.push(t)
                    }
                } catch (e: CancellationException) {
                    runCatching { conv.cancelProcess() }
                    throw e
                }
            }
            out.finish()
        }
    }

    private fun load(model: LiteRtModel): Engine {
        loaded?.let { if (it.model.id == model.id) return it.engine }
        closeLoaded()
        val file = downloader.fileFor(model)
        if (!downloader.isInstalled(model)) throw AiException("not-downloaded", "${model.label} isn’t downloaded yet.")
        if (!fits(model)) throw AiException("memory", "${model.label} needs more memory than this phone has. Choose a smaller model in Settings › AI.")
        val cache = File(context.cacheDir, "litert").apply { mkdirs() }.path
        for ((name, backend) in listOf("gpu" to Backend.GPU(), "cpu" to Backend.CPU())) {
            try {
                val engine = Engine(EngineConfig(modelPath = file.path, backend = backend, maxNumTokens = model.contextTokens, cacheDir = cache))
                engine.initialize()
                loaded = Loaded(model, engine, name)
                Log.i(TAG, "${model.id} loaded on $name")
                return engine
            } catch (e: Throwable) {
                if (e is CancellationException) throw e
                Log.w(TAG, "${model.id} failed to load on $name", e)
            }
        }
        throw AiException("load", "${model.label} couldn’t start on this phone. Try a smaller model.")
    }

    private fun closeLoaded() {
        loaded?.let { runCatching { it.engine.close() } }
        loaded = null
    }

    private companion object {
        const val TAG = "LiteRtEngine"
    }
}
