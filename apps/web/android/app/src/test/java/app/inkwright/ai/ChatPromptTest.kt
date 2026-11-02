package app.inkwright.ai

import app.inkwright.ai.ChatPrompt.Role.MODEL
import app.inkwright.ai.ChatPrompt.Role.USER
import app.inkwright.ai.ChatPromptBuilder.WireMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatPromptTest {
    private fun m(role: String, content: String) = WireMessage(role, content)

    @Test
    fun splitsSystemHistoryAndLastQuestion() {
        val p = ChatPromptBuilder.build(listOf(m("system", "Be brief."), m("user", "Hi"), m("assistant", "Hello!"), m("user", "What is in my notes?")))
        assertEquals("Be brief.", p.system)
        assertEquals(listOf(ChatPrompt.Turn(USER, "Hi"), ChatPrompt.Turn(MODEL, "Hello!")), p.history)
        assertEquals("What is in my notes?", p.last)
    }

    @Test
    fun joinsSystemMessagesAndMergesSameRoleTurns() {
        val p = ChatPromptBuilder.build(listOf(m("system", "A"), m("user", "one"), m("system", "B"), m("user", "two"), m("assistant", "x"), m("assistant", "y"), m("user", "q")))
        assertEquals("A\n\nB", p.system)
        assertEquals(listOf(ChatPrompt.Turn(USER, "one\n\ntwo"), ChatPrompt.Turn(MODEL, "x\n\ny")), p.history)
    }

    @Test
    fun dropsLeadingAssistantTurnsAndBlankMessages() {
        val p = ChatPromptBuilder.build(listOf(m("assistant", "Welcome"), m("user", "  "), m("user", "Hi")))
        assertTrue(p.history.isEmpty())
        assertEquals("Hi", p.last)
    }

    @Test
    fun refusesAConversationThatDoesNotEndWithTheUser() {
        val e = assertThrows(AiException::class.java) { ChatPromptBuilder.build(listOf(m("user", "Hi"), m("assistant", "Hello"))) }
        assertEquals("bad-request", e.code)
        assertThrows(AiException::class.java) { ChatPromptBuilder.build(listOf(m("system", "only system"))) }
    }

    @Test
    fun overBudgetDropsOldestExchangesFirstKeepingAlternation() {
        val msgs = listOf(m("system", "S"), m("user", "a".repeat(100)), m("assistant", "b".repeat(100)), m("user", "c".repeat(100)), m("assistant", "d".repeat(100)), m("user", "question"))
        val p = ChatPromptBuilder.build(msgs, maxChars = 250)
        assertEquals(listOf(ChatPrompt.Turn(USER, "c".repeat(100)), ChatPrompt.Turn(MODEL, "d".repeat(100))), p.history)
        assertEquals("question", p.last)
        assertTrue(p.chars <= 250)
    }

    @Test
    fun overBudgetThenCutsSystemThenTheStartOfTheLastMessage() {
        val p = ChatPromptBuilder.build(listOf(m("system", "s".repeat(500)), m("user", "x".repeat(50) + "END")), maxChars = 200)
        assertTrue(p.chars <= 200)
        assertTrue(p.last.endsWith("END"))
        assertEquals(53, p.last.length)

        val huge = ChatPromptBuilder.build(listOf(m("system", "rules"), m("user", "y".repeat(1000) + "?")), maxChars = 100)
        assertTrue(huge.chars <= 100)
        assertTrue(huge.last.endsWith("?"))
        assertEquals("rules", huge.system)
    }

    @Test
    fun flattenedTranscriptForSingleTurnEngines() {
        val p = ChatPromptBuilder.build(listOf(m("system", "Sys"), m("user", "Hi"), m("assistant", "Hello"), m("user", "And?")))
        assertEquals("Sys\n\nConversation so far:\nUser: Hi\nAssistant: Hello\n\nUser: And?", p.flattened(includeSystem = true))
        assertEquals("Conversation so far:\nUser: Hi\nAssistant: Hello\n\nUser: And?", p.flattened(includeSystem = false))
        val single = ChatPromptBuilder.build(listOf(m("user", "Just this")))
        assertEquals("Just this", single.flattened(includeSystem = true))
    }
}
