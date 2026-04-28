import type { AgentMessage } from "@mariozechner/pi-agent-core"

/**
 * Extract the last assistant text from a Pi agent_end message list.
 * Returns "" if no assistant message or no text content.
 */
export function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any
    if (m?.role !== "assistant") continue
    const content = Array.isArray(m.content) ? m.content : []
    const text = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text || "")
      .join("\n")
      .trim()
    if (text) return text
    return ""
  }
  return ""
}

/**
 * The last assistant message — used to inspect stopReason / tool calls.
 */
export function getLastAssistant(messages: AgentMessage[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any
    if (m?.role === "assistant") return m
  }
  return undefined
}

/**
 * Determine if the turn truly ended (vs. the model wanting to call more tools).
 * Pi marks completed turns with stopReason "stop"; "toolUse" means the loop
 * is about to run tools and isn't actually done.
 */
export function isEndTurn(message: any | undefined): boolean {
  if (!message) return false
  return message.stopReason === "stop"
}

export function extractSummary(text: string): string {
  if (!text) return ""

  const maxLength = 200

  if (text.length <= maxLength) return text

  const sentenceEnd = text.substring(0, maxLength).lastIndexOf(". ")
  if (sentenceEnd > 100) return text.substring(0, sentenceEnd + 1)

  const wordEnd = text.substring(0, maxLength).lastIndexOf(" ")
  if (wordEnd > 150) return text.substring(0, wordEnd) + "..."

  return text.substring(0, maxLength) + "..."
}
