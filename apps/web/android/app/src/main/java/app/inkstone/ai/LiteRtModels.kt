package app.inkstone.ai

/**
 * The LiteRT-LM models Inkstone offers on phones without Gemini Nano (or as a choice beside it).
 *
 * Rules, same as the web models (docs/LOCAL_AI.md): only Apache-2.0 or MIT weights, so a paid app
 * can ship the download without extra terms (Gemma 3/3n under the Gemma Terms are left out;
 * Gemma 4 is Apache-2.0). Each entry is pinned to a Hugging Face commit, a byte size and a SHA-256:
 * litert-community re-exports files under the same name for newer runtimes (e.g. 2026-10-31 GPU
 * exports that need LiteRT-LM 0.19), so an unpinned URL could hand an older runtime a file it
 * can't run, and a pinned one makes resuming safe (the bytes can't change underneath).
 */
data class LiteRtModel(
    val id: String,
    val label: String,
    val repo: String,
    val revision: String,
    val file: String,
    val bytes: Long,
    val sha256: String,
    val licence: String,
    val params: String,
    /** Total RAM (GB, as Android reports it) below which the model is not offered. */
    val minRamGb: Double,
    /** Context window used for the engine's KV cache (tokens). */
    val contextTokens: Int,
    val blurb: String,
) {
    val url: String get() = "https://huggingface.co/$repo/resolve/$revision/$file"

    fun fits(ramGb: Double): Boolean = ramGb <= 0.0 || ramGb >= minRamGb
}

object LiteRtModels {
    val all: List<LiteRtModel> = listOf(
        LiteRtModel(
            id = "gemma-4-e2b",
            label = "Gemma 4 E2B",
            repo = "litert-community/gemma-4-E2B-it-litert-lm",
            revision = "1caa527c1e88b55f046fcd8d2b4265606680663d",
            file = "gemma-4-E2B-it.litertlm",
            bytes = 2_588_147_712L,
            sha256 = "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
            licence = "Apache-2.0",
            params = "5B (2B effective)",
            minRamGb = 7.0,
            contextTokens = 4096,
            blurb = "Google’s open model for phones. Best answers and many languages.",
        ),
        LiteRtModel(
            id = "gemma-4-e4b",
            label = "Gemma 4 E4B",
            repo = "litert-community/gemma-4-E4B-it-litert-lm",
            revision = "e6a3892a8c22cf87ff99583996149cf3cb32452b",
            file = "gemma-4-E4B-it.litertlm",
            bytes = 3_659_530_240L,
            sha256 = "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
            licence = "Apache-2.0",
            params = "8B (4B effective)",
            minRamGb = 11.0,
            contextTokens = 4096,
            blurb = "Larger Gemma 4 for phones with 12 GB of memory or more. Slower, more careful.",
        ),
        LiteRtModel(
            id = "qwen3-1.7b",
            label = "Qwen3 1.7B",
            repo = "litert-community/Qwen3-1.7B",
            revision = "ebb4eef4c07c0ecf019fa3cf7b501771d44ca21f",
            file = "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm",
            bytes = 977_184_032L,
            sha256 = "2a72330b504a6596d53a2c00923c57173b10f1b83e6a541213ffec08d1fc5de8",
            licence = "Apache-2.0",
            params = "1.7B",
            minRamGb = 5.0,
            contextTokens = 4096,
            blurb = "Fast on most recent phones. Good for summaries and questions about notes.",
        ),
        LiteRtModel(
            id = "qwen3-0.6b",
            label = "Qwen3 0.6B",
            repo = "litert-community/Qwen3-0.6B",
            revision = "2670e142a0d16a1b685be6604e5b4f2b31a826d7",
            file = "qwen3_0_6b_mixed_int4.litertlm",
            bytes = 497_516_544L,
            sha256 = "7900eb4e7362d88c58782c6f9999bb7a129e03544aa98b8f338ea0cc5d8c22c1",
            licence = "Apache-2.0",
            params = "0.6B",
            minRamGb = 3.0,
            contextTokens = 2048,
            blurb = "Smallest download, for phones with little memory. Simple tasks only.",
        ),
    )

    fun byId(id: String?): LiteRtModel? = all.firstOrNull { it.id == id }

    /**
     * The model to suggest for a phone with [ramGb] of memory: the best one that leaves room for
     * Android and the app. The 4B Gemma is never the default — it is twice as slow for a modest
     * gain on note-sized tasks — so it is only offered as a choice.
     */
    fun recommend(ramGb: Double): LiteRtModel? = when {
        ramGb <= 0.0 -> byId("qwen3-1.7b")
        else -> all.filter { it.id != "gemma-4-e4b" && it.fits(ramGb) }.maxByOrNull { it.minRamGb }
    }
}
