import { existsSync, mkdirSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  AgentEndEvent,
  AgentStartEvent,
  SessionShutdownEvent,
} from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"

import { LOG_PREFIX, MESSAGE_DIR } from "./constants.ts"
import { deliverAgentPayload } from "./inbox.ts"
import {
  extractLastAssistantText,
  getLastAssistant,
  isEndTurn,
  extractSummary,
} from "./message.ts"
import { waitForResponse } from "./poll.ts"

const execFileAsync = promisify(execFile)

async function detectScheme(): Promise<string> {
  const envScheme = process.env.SUPERWHISPER_SCHEME
  if (envScheme) return envScheme

  try {
    await execFileAsync("pgrep", ["-f", "DerivedData.*superwhisper.app"])
    return "superwhisper-debug"
  } catch {
    return "superwhisper"
  }
}

async function getGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
    )
    const trimmed = stdout.trim()
    return trimmed || undefined
  } catch {
    return undefined
  }
}

export default async function superwhisperExtension(pi: ExtensionAPI): Promise<void> {
  const scheme = await detectScheme()
  mkdirSync(MESSAGE_DIR, { recursive: true })

  const DEBUG = !!process.env.SUPERWHISPER_DEBUG
  const LOG_FILE = `${MESSAGE_DIR}/debug.log`

  function log(level: "debug" | "info" | "warn" | "error", message: string) {
    if (!DEBUG) return
    try {
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] [${level}] ${LOG_PREFIX} ${message}\n`,
      )
    } catch {}
  }

  // --- Session id ---

  // Derived from pi's session file path so it survives reloads/forks and stays
  // consistent across separate runs that resume the same session. Falls back
  // to a pid-based id only when pi hasn't bound a session file yet.
  function deriveSessionId(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile()
    if (file) return basename(file).replace(/[^a-zA-Z0-9_.-]/g, "_")
    return `pi-${process.pid}`
  }

  // --- State ---

  const activePolls = new Map<string, AbortController>()

  // Sessions explicitly disabled via the toggle tool / slash command.
  const disabledSessions = new Set<string>()

  function isSessionDisabled(sessionId: string): boolean {
    if (disabledSessions.has(sessionId)) return true
    return existsSync(`${MESSAGE_DIR}/disabled-${sessionId}`)
  }

  function disableSession(sessionId: string): void {
    disabledSessions.add(sessionId)
    try {
      writeFileSync(`${MESSAGE_DIR}/disabled-${sessionId}`, "")
    } catch (err) {
      log("error", `Failed to write disabled flag for session=${sessionId}: ${err}`)
    }
  }

  function enableSession(sessionId: string): void {
    disabledSessions.delete(sessionId)
    try {
      const flagPath = `${MESSAGE_DIR}/disabled-${sessionId}`
      if (existsSync(flagPath)) unlinkSync(flagPath)
    } catch (err) {
      log("error", `Failed to remove disabled flag for session=${sessionId}: ${err}`)
    }
  }

  function cancelPoll(sessionId: string, source: string): boolean {
    const ctrl = activePolls.get(sessionId)
    if (ctrl) {
      ctrl.abort()
      activePolls.delete(sessionId)
      log("debug", `Poll cancelled for session=${sessionId} (${source})`)
      return true
    }
    return false
  }

  function sendDismiss(sessionId: string, source: string) {
    log("debug", `Sending dismiss via inbox (${source}) for session=${sessionId}`)
    deliverAgentPayload({ kind: "dismiss", sessionId }, scheme).catch((err) => {
      log("error", `Failed to send dismiss for session=${sessionId}: ${err}`)
    })
  }

  // --- Notification ---

  type NotifyOutcome =
    | { kind: "response"; text: string }
    | { kind: "empty" }
    | { kind: "cancelled" }
    | { kind: "timeout" }

  async function sendNotification(params: {
    sessionId: string
    status: string
    summary: string
    messageContent: string
    cwd: string
    title?: string
  }): Promise<NotifyOutcome> {
    const { sessionId, status, summary, messageContent, cwd, title } = params

    cancelPoll(sessionId, "new-notification")

    const messageFile = `${MESSAGE_DIR}/${sessionId}-message.txt`
    const responseFile = `${MESSAGE_DIR}/${sessionId}-response.txt`

    try {
      writeFileSync(messageFile, messageContent)
    } catch (err) {
      log("error", `Failed to write message file: ${messageFile} — ${err}`)
      return { kind: "timeout" }
    }

    if (existsSync(responseFile)) {
      log("info", `Removing stale response file for session=${sessionId}`)
      try {
        unlinkSync(responseFile)
      } catch {}
    }

    const branch = await getGitBranch(cwd)
    const projectName = basename(cwd) || "pi"

    try {
      await deliverAgentPayload(
        {
          kind: "update",
          agent: "pi",
          status,
          sessionId,
          summary,
          messageFile,
          responseFile,
          cwd,
          project: projectName,
          branch,
          title,
          hookPid: process.pid,
        },
        scheme,
      )
    } catch (err) {
      log("error", `Failed to deliver Superwhisper payload — ${err}`)
      return { kind: "timeout" }
    }

    log("info", `Notification sent: status=${status} session=${sessionId}`)

    const ctrl = new AbortController()
    activePolls.set(sessionId, ctrl)

    const result = await waitForResponse(responseFile, { signal: ctrl.signal })

    if (activePolls.get(sessionId) === ctrl) activePolls.delete(sessionId)

    try {
      if (existsSync(responseFile)) unlinkSync(responseFile)
      if (existsSync(messageFile)) unlinkSync(messageFile)
    } catch {}

    return result
  }

  // --- Event handlers ---

  pi.on("agent_start", async (_event: AgentStartEvent, ctx: ExtensionContext) => {
    // A new turn started — any prior notification poll is stale. Kill it so
    // we don't re-inject an old voice response into this fresh turn.
    const sessionId = deriveSessionId(ctx)
    cancelPoll(sessionId, "agent_start")
  })

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    const sessionId = deriveSessionId(ctx)
    const cwd = ctx.cwd

    if (isSessionDisabled(sessionId)) {
      log("debug", `Skipping agent_end for session=${sessionId} (disabled)`)
      return
    }

    const lastAssistant = getLastAssistant(event.messages)
    const fullMessage = extractLastAssistantText(event.messages)

    if (!fullMessage) {
      log("info", `Skipping empty completion for session=${sessionId}`)
      return
    }

    if (!isEndTurn(lastAssistant)) {
      log(
        "info",
        `Skipping non-end-turn agent_end for session=${sessionId} (stopReason=${lastAssistant?.stopReason})`,
      )
      return
    }

    const summary = extractSummary(fullMessage)
    const title = ctx.sessionManager.getSessionName()

    const outcome = await sendNotification({
      sessionId,
      status: "completed",
      summary,
      messageContent: fullMessage,
      cwd,
      title,
    })

    switch (outcome.kind) {
      case "response":
        try {
          pi.sendUserMessage(outcome.text)
          log("info", `Voice response sent back to pi for session=${sessionId}`)
        } catch (err) {
          log("error", `Failed to sendUserMessage: ${err}`)
        }
        return
      case "empty":
        // User dismissed via Superwhisper X / double-ESC — drop the prompt
        // silently. No dismiss inbox payload needed; Superwhisper already
        // closed its own UI.
        log("info", `User dismissed notification for session=${sessionId}`)
        return
      case "cancelled":
        // Cancelled internally (agent_start, session_shutdown, or new
        // notification superseding this one). The cancel source is
        // responsible for any dismiss it wants to send.
        log("info", `Notification cancelled for session=${sessionId}`)
        return
      case "timeout":
        log("info", `Poll timed out for session=${sessionId}`)
        sendDismiss(sessionId, "completed-timeout")
        return
    }
  })

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const sessionId = deriveSessionId(ctx)
    log("info", `session_shutdown for session=${sessionId}`)
    if (cancelPoll(sessionId, "session_shutdown")) {
      sendDismiss(sessionId, "session_shutdown")
    }
  })

  // --- Tool ---

  pi.registerTool({
    name: "superwhisper_toggle",
    label: "Superwhisper",
    description:
      "Enable or disable Superwhisper voice notifications for this session. " +
      "Use action='disable' when the user wants to turn Superwhisper off, " +
      "and action='enable' when they want to turn it back on.",
    promptSnippet:
      "Toggle Superwhisper voice notifications for this Pi session.",
    promptGuidelines: [
      "Use superwhisper_toggle when the user asks to enable or disable Superwhisper, voice notifications, or hands-free mode.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("enable"), Type.Literal("disable")]),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = deriveSessionId(ctx)
      if (params.action === "disable") {
        disableSession(sessionId)
        log("info", `Superwhisper disabled for session=${sessionId}`)
        return {
          content: [
            {
              type: "text",
              text: "Superwhisper voice notifications disabled for this session.",
            },
          ],
          details: undefined,
          isError: false,
        }
      } else {
        enableSession(sessionId)
        log("info", `Superwhisper re-enabled for session=${sessionId}`)
        return {
          content: [
            {
              type: "text",
              text: "Superwhisper voice notifications re-enabled for this session.",
            },
          ],
          details: undefined,
          isError: false,
        }
      }
    },
  })

  // --- Slash command ---

  pi.registerCommand("superwhisper", {
    description: "Enable, disable, or test Superwhisper voice notifications for this session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sessionId = deriveSessionId(ctx)
      const action = args.trim().toLowerCase()

      if (action === "off" || action === "disable") {
        disableSession(sessionId)
        ctx.ui.notify("Superwhisper disabled for this session", "info")
        return
      }
      if (action === "on" || action === "enable") {
        enableSession(sessionId)
        ctx.ui.notify("Superwhisper enabled for this session", "info")
        return
      }
      if (action === "test") {
        const summary = "Pi Superwhisper test"
        const message = "This is a Pi Superwhisper test notification."
        sendNotification({
          sessionId,
          status: "completed",
          summary,
          messageContent: message,
          cwd: ctx.cwd,
          title: ctx.sessionManager.getSessionName(),
        })
          .then((outcome) => {
            log("info", `Test notification outcome: ${outcome.kind}`)
          })
          .catch((err) => log("error", `Test notification failed: ${err}`))
        ctx.ui.notify("Sent Superwhisper test notification", "info")
        return
      }
      if (action === "" || action === "status") {
        const disabled = isSessionDisabled(sessionId)
        ctx.ui.notify(
          `Superwhisper is ${disabled ? "disabled" : "enabled"} for this session. Usage: /superwhisper [on|off|test|status]`,
          "info",
        )
        return
      }
      ctx.ui.notify("Usage: /superwhisper [on|off|test|status]", "info")
    },
  })
}
