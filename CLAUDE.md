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
