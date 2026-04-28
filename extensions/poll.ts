import { existsSync, readFileSync, watch } from "node:fs"
import { dirname, basename } from "node:path"
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./constants.ts"

export type WaitResult =
  | { kind: "response"; text: string }
  | { kind: "empty" }
  | { kind: "cancelled" }
  | { kind: "timeout" }

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
}

/**
 * Wait for a response file to appear and contain text. Uses `fs.watch` on the
 * parent directory so it reacts within milliseconds, with a periodic fallback
 * for filesystems where watch events are flaky.
 *
 * - File missing for the full timeout → `timeout`
 * - File created but empty → `empty` (Superwhisper X / double-ESC writes "")
 * - File created with text → `response`
 * - `signal` aborts → `cancelled`
 */
export function waitForResponse(
  path: string,
  options: WaitOptions = {},
): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const { signal } = options

  const dir = dirname(path)
  const file = basename(path)

  function tryRead(): WaitResult | null {
    try {
      if (!existsSync(path)) return null
      const text = readFileSync(path, "utf8")
      if (text.trim().length === 0) return { kind: "empty" }
      return { kind: "response", text }
    } catch {
      return null
    }
  }

  return new Promise<WaitResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: "cancelled" })
      return
    }

    let settled = false
    let watcher: ReturnType<typeof watch> | undefined
    let intervalId: ReturnType<typeof setInterval> | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined

    const finish = (result: WaitResult) => {
      if (settled) return
      settled = true
      try {
        watcher?.close()
      } catch {}
      if (intervalId) clearInterval(intervalId)
      if (timeoutId) clearTimeout(timeoutId)
      if (abortHandler && signal) signal.removeEventListener("abort", abortHandler)
      resolve(result)
    }

    const check = () => {
      if (settled) return
      const result = tryRead()
      if (result) finish(result)
    }

    const immediate = tryRead()
    if (immediate) {
      finish(immediate)
      return
    }

    try {
      watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename === file) check()
      })
    } catch {
      // dir missing or watch unsupported — interval is enough
    }

    intervalId = setInterval(check, intervalMs)
    timeoutId = setTimeout(() => finish({ kind: "timeout" }), timeoutMs)

    if (signal) {
      abortHandler = () => finish({ kind: "cancelled" })
      signal.addEventListener("abort", abortHandler, { once: true })
    }
  })
}
