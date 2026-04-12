# Claude-B Project

## Overview

Claude-B is a background-capable wrapper around Claude Code enabling async AI workflows.

## Quick Reference

### Commands (keep short!)
- `cb <prompt>` - Send prompt
- `cb -l` - Last output
- `cb -s` - List sessions
- `cb -a <id>` - Attach (fg-style)
- `cb -w` - Watch live output
- `cb -n` - New session
- `cb -x <id>` - Select session
- `cb -r` - Start REST API
- `cb -f <prompt>` - Fire-and-forget
- `cb -i` - Interactive inbox
- `cb --telegram <token>` - Setup Telegram
- `cb --telegram-status` - Telegram status
- `cb --inbox-count` - Unread count

### Architecture
- **CLI** (`src/cli/`) - User interface + interactive inbox TUI
- **Daemon** (`src/daemon/`) - Background process manager
- **Session** (`src/session/`) - Session state & conversation continuity
- **Notifications** (`src/notifications/`) - JSONL-based inbox
- **Telegram** (`src/telegram/`) - Bot + config for Telegram integration
- **REST** (`src/rest/`) - HTTP/WebSocket API
- **Hooks** (`src/hooks/`) - Shell hooks & webhooks
- **Orchestration** (`src/orchestration/`) - Multi-host coordination

### Key Files
- `src/cli/index.ts` - CLI entry point + interactive inbox
- `src/daemon/index.ts` - Daemon entry + IPC handlers
- `src/daemon/session-manager.ts` - Session lifecycle
- `src/daemon/client.ts` - IPC client for CLI
- `src/session/session.ts` - Session class wrapping Claude Code
- `src/notifications/inbox.ts` - Notification inbox store
- `src/telegram/bot.ts` - Telegram bot implementation
- `src/telegram/config.ts` - Telegram config persistence

### Development
```bash
pnpm install          # Install deps
pnpm dev              # Dev mode with watch
pnpm build            # Production build
pnpm test             # Run tests
pnpm typecheck        # Type check
```

### IPC Protocol
Unix socket at `~/.claude-b/daemon.sock`

Messages are newline-delimited JSON:
```json
{"method":"session.create","params":{},"id":1}
```

Response:
```json
{"data":{"sessionId":"abc123"},"id":1}
```

### Conventions
- TypeScript strict mode
- Async/await over callbacks
- Errors as typed exceptions
- EventEmitter for streaming
- Tests alongside source files

### Storage Locations
- Config: `~/.claude-b/config.json`
- Sessions: `~/.claude-b/sessions/`
- Notifications: `~/.claude-b/notifications.jsonl`
- Telegram: `~/.claude-b/telegram.json`
- Logs: `~/.claude-b/daemon.log`
- Socket: `~/.claude-b/daemon.sock`
- PID: `~/.claude-b/daemon.pid`

### Telegram ↔ Tmux Integration

Claude-B bridges live Claude Code sessions running in tmux panes with
Telegram, enabling a mobile-first workflow: get notified when sessions
complete, listen to audio summaries (OpenAI TTS), select sessions, and
reply — all from your phone.

#### How It Works

1. **Stop hook** (`bin/cb-notify.sh`) — registered in `~/.claude/settings.json`
   as a `Stop` hook. Fires after every top-level Claude Code response in any
   tmux pane. Reads the hook JSON from stdin, parses the Claude transcript
   JSONL, and POSTs a notification to `POST /api/notify`.

2. **`/api/notify` route** (`src/rest/routes/notify.ts`) — localhost-only,
   API-key-authenticated ingest endpoint. Accepts `{sessionId, sessionName,
   resultPreview, transcriptPath, ...}`. Routes to
   `telegramBot.broadcastNotification()` (existing), caches `transcriptPath`
   for voice context (new).

3. **Virtual tmux sessions** — session IDs use the format `tmux:<target>`
   (e.g. `tmux:general:2.0`). The daemon's `onPrompt` handler recognises
   this prefix and routes replies via `tmux send-keys` instead of
   `sessionManager.sendPrompt`. `/sessions` in Telegram merges Claude-B's
   own sessions with live tmux panes (via `tmux list-panes -a`).

4. **Voice pipeline** — sends a voice note in Telegram → Whisper STT →
   `optimizePrompt(transcript, sessionContext)` → confirm/edit/cancel.
   Context for tmux sessions comes from the cached transcript path
   (last 3 user + 3 assistant turns, tool-result wrappers filtered out).

#### Stop Hook Configuration

```json
// ~/.claude/settings.json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "$HOME/Claude-B/bin/cb-notify.sh"
      }]
    }]
  }
}
```

#### TTS Configuration

Model and voice are read from `~/.claude-b/telegram.json` under
`sttProvider.ttsModel` / `sttProvider.ttsVoice`. Defaults: `gpt-4o-mini-tts`
/ `alloy`. To change:

```bash
# Edit the config
jq '.sttProvider.ttsModel = "tts-1" | .sttProvider.ttsVoice = "nova"' \
  ~/.claude-b/telegram.json > /tmp/tg.json && mv /tmp/tg.json ~/.claude-b/telegram.json
# Restart the daemon to pick up the change
sudo systemctl restart cb-daemon.service
```

Available models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`.
Available voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`,
`nova`, `onyx`, `sage`, `shimmer`, `verse`.

#### Caveats

- **Hook pickup**: the Stop hook in `settings.json` is read at Claude Code
  startup. Running panes that were started before the hook was added will
  not fire it. Restart those panes (`/exit` + relaunch `claude`) or wait
  for natural session turnover.

- **Cold transcript cache**: voice prompt optimisation uses session context
  from a cached transcript path. The cache populates when `/api/notify`
  receives a `transcriptPath` (i.e. after the pane's first Stop hook fires
  since the last daemon restart). Before that, `optimizePrompt` still works
  but with no turn-history grounding.

- **`/sessions` enumeration is synchronous**: the daemon spawns
  `tmux list-panes -a` on each `/sessions` call. At ~22 panes this is
  <10ms. At hundreds of panes, consider caching the result with a short TTL.

- **Inline keyboard button labels**: Telegram buttons with long labels
  (60+ chars) truncate visually on narrow phone screens. Pane titles like
  `helios:3.0 ✳ wire-baas-layer-heliosdb` render fine; very long slugs
  get clipped but remain tappable.

- **Reply routing via `tmux send-keys`**: replies typed into a Telegram
  notification are injected into the target tmux pane literally. Multi-line
  replies are sent as a single keystroke sequence + Enter. If the target
  pane is in the middle of something (e.g. Claude is currently outputting),
  the injected text may interleave. Best practice: reply to idle panes.

- **Daemon restart**: restarting `cb-daemon.service` clears the in-memory
  transcript cache and reconnects the Telegram bot. Active Claude-B sessions
  survive (persisted to disk); tmux panes are unaffected.

### Session Lifecycle
1. `cb -n myproject` - Create named session
2. `cb "analyze code"` - Send prompt (auto-creates if needed)
3. `cb -w` - Watch output stream
4. `cb -l` - Check last result
5. `cb -k myproject` - Kill session when done

### Claude Code Integration
Sessions wrap Claude Code with two modes:
1. **PTY mode** (with node-pty): Full interactive Claude Code
   - Persistent process per session
   - Multiple prompts to same process
   - Terminal emulation support
2. **Fallback mode** (without node-pty): `claude --print` per prompt
   - Fresh process for each prompt
   - stdin: receives prompt, stdout/stderr: captured
   - Exit triggers completion notification

### Session Storage
Each session stores:
- `~/.claude-b/sessions/<id>/history.jsonl` - Prompt/response history
- Output buffer in memory for replay on attach
