# @superwhisper/pi

Superwhisper voice integration extension for [Pi](https://github.com/badlogic/pi-mono).

Get voice notifications when your AI coding tasks complete, and respond with your voice. Your voice response is sent back to Pi as the next prompt, creating a hands-free coding loop.

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-coding-agent`) installed (`npm i -g @mariozechner/pi-coding-agent`)
- [Superwhisper](https://superwhisper.com) app for macOS

## Installation

```bash
curl -fsSL https://superwhisper.com/install-pi.sh | bash
```

Or directly via pi's package manager:

```bash
pi install npm:@superwhisper/pi
```

Restart pi to activate.

## How It Works

```
You speak → Pi works → Extension notifies Superwhisper → You speak back → loop
```

1. **Task completes** → Pi fires `agent_end` with `stopReason: "stop"`
2. **Extension extracts the response** → reads the last assistant text content
3. **Extension notifies Superwhisper** → writes message to temp file, opens deeplink
4. **Superwhisper shows notification** → displays summary with voice recording UI
5. **You speak your response** → Superwhisper transcribes and writes to response file
6. **Extension reads response** → polls the response file, sends back to Pi via `pi.sendUserMessage`
7. **Pi continues** → processes your voice input as the next instruction

## Events

| Pi Event          | Superwhisper Status | Description                  |
|-------------------|---------------------|------------------------------|
| `agent_end` (stop)| `completed`         | Task finished                |

Pi has no built-in permission popups or elicitation system, so only end-of-turn completions are surfaced today. If you wire up your own permission gate via `tool_call` blocking, file an issue and we'll plumb it through.

## Controlling Superwhisper During a Session

You can ask the agent to enable or disable Superwhisper voice notifications at any time during a session. The extension exposes a `superwhisper_toggle` tool the agent will use automatically when instructed.

**Disable Superwhisper for the current session:**
> "Disable Superwhisper" / "Turn off voice notifications" / "Stop Superwhisper"

**Re-enable Superwhisper for the current session:**
> "Enable Superwhisper" / "Turn voice notifications back on" / "Re-enable Superwhisper"

The toggle is session-scoped — it only affects the current Pi session and resets when you start a new one.

## Development

```bash
npm install
npm run typecheck
```

### Local Testing

Pi loads `.ts` extensions directly via jiti, so no build step is needed. To install a local checkout:

```bash
pi install /absolute/path/to/pi-superwhisper
```

Or symlink the extension into pi's user extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/extensions/superwhisper.ts" ~/.pi/agent/extensions/superwhisper.ts
```

Restart pi to pick up changes.

### Environment Variables

| Variable               | Default | Description                                                          |
|------------------------|---------|----------------------------------------------------------------------|
| `SUPERWHISPER_DEBUG`   | unset   | Set to `1` to write debug logs to `/tmp/superwhisper-agent/debug.log`|
| `SUPERWHISPER_SCHEME`  | auto    | Override deeplink scheme (`superwhisper` vs `superwhisper-debug`)    |

### Project Structure

```
extensions/
  superwhisper.ts  # Extension entry — pi loads this directly
  constants.ts         # Constants and shared types
  deeplink.ts      # Deeplink URL building
  inbox.ts         # Inbox payload writes + scheme detection
  message.ts       # Pi AgentMessage helpers (extract text, summary, end-turn)
  poll.ts          # Response file polling
```

## License

MIT
