package app.inkwright.ai

/**
 * A chat request in the shape native engines want: one system instruction, earlier turns that
 * alternate user → model and start with the user, and the user message to answer.
 *
 * The web layer already budgets tokens (toLocalMessages in packages/ai), so [ChatPromptBuilder]'s
 * own budget is a safety net against a context overflow error — and the one place that knows
 * native engines' rules (Gemini Nano rejects a history that doesn't alternate).
 */
data class ChatPrompt(val system: String, val history: List<Turn>, val last: String) {
    enum class Role { USER, MODEL }

    data class Turn(val role: Role, val text: String)

    /** Total characters sent (system + history + last). */
    val chars: Int get() = system.length + history.sumOf { it.text.length } + last.length

    /**
     * The same conversation as a single user message, for engines (or AICore versions) without
     * multi-turn input: earlier turns become a short transcript above the question. When
     * [includeSystem] the system instruction leads, for engines without a system prompt.
     */
    fun flattened(includeSystem: Boolean): String = buildString {
        if (includeSystem && system.isNotBlank()) append(system.trim()).append("\n\n")
        if (history.isNotEmpty()) {
            append("Conversation so far:\n")
            for (t in history) append(if (t.role == Role.USER) "User: " else "Assistant: ").append(t.text.trim()).append('\n')
            append("\nUser: ").append(last.trim())
        } else {
            append(last.trim())
        }
    }
}

object ChatPromptBuilder {
    /** One wire message from JS: role is `system`, `user` or `assistant`. */
    data class WireMessage(val role: String, val content: String)

    /**
     * Builds a [ChatPrompt] from wire messages.
     *  - every `system` message joins the system instruction (in order);
     *  - consecutive turns of the same role merge (blank-line separated) so turns alternate;
     *  - history starts with a user turn (a leading assistant turn is dropped);
     *  - the conversation must end with a user turn — otherwise there is nothing to answer;
     *  - when over [maxChars], the oldest exchanges go first, then the system instruction is cut,
     *    and the last message is only ever shortened from its start (the question is at the end).
     */
    fun build(messages: List<WireMessage>, maxChars: Int = Int.MAX_VALUE): ChatPrompt {
        val system = messages.filter { it.role == "system" }.joinToString("\n\n") { it.content.trim() }.trim()
        val turns = ArrayList<ChatPrompt.Turn>()
        for (m in messages) {
            val role = when (m.role) {
                "user" -> ChatPrompt.Role.USER
                "assistant", "model" -> ChatPrompt.Role.MODEL
                else -> continue
            }
            val text = m.content.trim()
            if (text.isEmpty()) continue
            val prev = turns.lastOrNull()
            if (prev != null && prev.role == role) turns[turns.size - 1] = prev.copy(text = prev.text + "\n\n" + text)
            else turns += ChatPrompt.Turn(role, text)
        }
        while (turns.firstOrNull()?.role == ChatPrompt.Role.MODEL) turns.removeAt(0)
        val last = turns.removeLastOrNull()
        if (last == null || last.role != ChatPrompt.Role.USER) throw AiException("bad-request", "Nothing to answer.")
        return fit(ChatPrompt(system, turns, last.text), maxChars)
    }

    private fun fit(p: ChatPrompt, maxChars: Int): ChatPrompt {
        if (p.chars <= maxChars) return p
        val history = p.history.toMutableList()
        var prompt = p
        // Drop the oldest user+model pair at a time so the history still starts with the user.
        while (prompt.chars > maxChars && history.isNotEmpty()) {
            history.removeAt(0)
            if (history.firstOrNull()?.role == ChatPrompt.Role.MODEL) history.removeAt(0)
            prompt = prompt.copy(history = history.toList())
        }
        if (prompt.chars > maxChars) {
            val room = (maxChars - prompt.last.length).coerceAtLeast(maxChars / 4)
            if (prompt.system.length > room) prompt = prompt.copy(system = prompt.system.take(room).trimEnd())
        }
        if (prompt.chars > maxChars) {
            val room = (maxChars - prompt.system.length).coerceAtLeast(1)
            prompt = prompt.copy(last = prompt.last.takeLast(room).trimStart())
        }
        return prompt
    }
}
