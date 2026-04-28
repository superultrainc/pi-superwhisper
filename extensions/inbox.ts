import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const execFileAsync = promisify(execFile)

export interface InboxPayload {
  kind: "update" | "dismiss"
  sessionId?: string
  requestId?: string
  agent?: string
  status?: string
  summary?: string
  message?: string
  messageFile?: string
  responseFile?: string
  cwd?: string
  project?: string
  branch?: string
  title?: string
  hookPid?: number
}

let INBOX_DIR = join(
  homedir(),
  "Library/Application Support/superwhisper/agent/inbox",
)

export function __setInboxDirForTest(dir: string): void {
  INBOX_DIR = dir
}

export function writeInboxPayload(payload: InboxPayload): boolean {
  try {
    mkdirSync(INBOX_DIR, { recursive: true })
  } catch {
    return false
  }

  const base = randomUUID()
  const tmpPath = join(INBOX_DIR, `${base}.json.tmp`)
  const finalPath = join(INBOX_DIR, `${base}.json`)

  try {
    writeFileSync(tmpPath, JSON.stringify(payload))
    renameSync(tmpPath, finalPath)
    return true
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {}
    return false
  }
}

export async function isSuperwhisperRunning(): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-x", "superwhisper"])
    return true
  } catch {
    return false
  }
}

export async function fireAgentWake(scheme: string): Promise<void> {
  const url = `${scheme}://agent-wake`
  try {
    await execFileAsync("open", [url])
  } catch {
    // wake is best-effort
  }
}

export async function deliverAgentPayload(
  payload: InboxPayload,
  scheme: string,
): Promise<boolean> {
  const wrote = writeInboxPayload(payload)
  const running = await isSuperwhisperRunning()
  if (!running) {
    await fireAgentWake(scheme)
  }
  return wrote
}
