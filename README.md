<p align="center">
  <img src="assets/Claude-B.png" alt="Claude-B Logo" width="800">
</p>

# Claude-B

> Run Claude Code in the background. Send prompts, do other work, check results later.

Claude-B is a background-capable wrapper around [Claude Code](https://claude.ai/code) that enables:

- **Async workflows** - Send prompts, continue working, check results when ready
- **Session management** - Multiple concurrent AI sessions with conversation continuity
- **Fire-and-forget** - Launch background tasks, get notified when done
- **Notification inbox** - Interactive TUI to browse completed tasks with markdown rendering
- **Telegram integration** - Get notifications and reply to sessions from Telegram
- **Foreground attach** - Like `fg` in Linux, attach to see live output
- **Auto-watch streaming** - Automatically streams output after sending prompts
- **REST API** - Control sessions remotely via HTTP/WebSocket
- **Hooks** - Shell hooks and webhooks for notifications and automation
- **Multi-host orchestration** - Distribute work across multiple Claude-B instances

## Installation

```bash
# Clone and build
git clone https://github.com/your-org/claude-b.git
cd claude-b
pnpm install
pnpm build

# Link globally
pnpm link --global
```

## Prerequisites

- Node.js 20+
- [Claude Code](https://claude.ai/code) installed and configured
- `ANTHROPIC_API_KEY` environment variable set

## Quick Start

```bash
# Send a prompt (creates session if needed)
cb "Explain this codebase"

# Check last result
cb -l

# Watch live output
cb -w

# List sessions
cb -s

# Attach to session (interactive mode)
cb -a main
```

## Commands

### Sessions & Prompts

| Command | Short | Description |
|---------|-------|-------------|
| `cb <prompt>` | | Send prompt to current session |
| `cb -- <prompt>` | | Explicit prompt (if starts with `-`) |
| `cb < file` | | Send file as prompt |
| `cb --last` | `-l` | Show last prompt result |
| `cb --sess` | `-s` | List all sessions |
| `cb --attach <id>` | `-a` | Attach to session (fg-style) |
| `cb --detach` | `-d` | Detach from session |
| `cb --new [name]` | `-n` | Create new session |
| `cb --model <model>` | `-m` | Claude model (with `--new`) |
| `cb --kill <id>` | `-k` | Terminate session |
| `cb --watch` | `-w` | Watch live output |
| `cb --select <id>` | `-x` | Select session for commands |
| `cb --current` | `-c` | Show current session |

### Fire-and-Forget & Inbox

| Command | Short | Description |
|---------|-------|-------------|
| `cb -f <prompt>` | | Launch task in background |
| `cb -f -g "goal" <prompt>` | | Fire-and-forget with goal description |
| `cb --inbox` | `-i` | Interactive notification inbox |
| `cb --inbox-count` | | Show unread notification count |
| `cb --inbox-clear` | | Mark all notifications as read |

### Telegram

| Command | Description |
|---------|-------------|
| `cb --telegram <token>` | Set up Telegram bot with token |
| `cb --telegram-status` | Show Telegram bot status |
| `cb --telegram-stop` | Disable Telegram notifications |

### REST API & Hooks

| Command | Short | Description |
|---------|-------|-------------|
| `cb --rest [port]` | `-r` | Start REST API server |
| `cb --rest-stop` | | Stop REST API server |
| `cb --api-key` | | Show REST API key |
| `cb --status` | | Daemon status and health |
| `cb --hook <event> <cmd>` | | Register shell hook |
| `cb --unhook <id>` | | Remove shell hook |
| `cb --hooks` | | List shell hooks |
| `cb --webhook <url>` | | Register webhook |
| `cb --unwebhook <id>` | | Remove webhook |
| `cb --webhooks` | | List webhooks |

### Multi-Host Orchestration

| Command | Description |
|---------|-------------|
| `cb --remote-add <url>` | Add remote host (with `--remote-key`) |
| `cb --remote-hosts` | List remote hosts |
| `cb --remote-health` | Health status of all hosts |
| `cb --remote <hostId> <prompt>` | Send prompt to remote host |
| `cb --remote-fire <hostId> <prompt>` | Fire-and-forget to remote host |
| `cb --remote-stats` | Orchestration statistics |

## Guides

### Quick Start: Fire-and-Forget

Launch tasks that run in the background and notify you when done:

```bash
# Fire a task
cb -f "Refactor the authentication module"

# Fire with a descriptive goal
cb -f -g "Add input validation to all API endpoints" "Review every route handler in src/routes/ and add zod validation"

# Check your inbox for results
cb -i
```

When tasks complete, you'll get a terminal bell notification. Use `cb -i` to browse results interactively.

### Quick Start: Interactive Inbox

The inbox (`cb -i`) is a full-screen TUI for browsing completed tasks:

```
── Inbox (1/3) * unread ──────────────────────────────

  OK  deploy-nginx  14:32  12.3s  $0.004
  Goal: Deploy nginx config and verify

  Configuration updated successfully.
  • nginx.conf validated
  • Service reloaded with zero downtime

  Resume: cb "your follow-up here"

── n=next  p=prev  r=read  d=delete  q=quit ──────────
```

**Keys:**
- `n` / `j` / `→` / `↓` — Next notification
- `p` / `k` / `←` / `↑` — Previous notification
- `r` — Mark current as read
- `d` — Delete current notification
- `q` / `Esc` / `Ctrl+C` — Quit

The inbox renders markdown output (headers, bold, code blocks, lists, quotes) and shows a resume command for continuing the conversation.

### Quick Start: Telegram Integration

Get notifications on your phone and reply to sessions from Telegram.

**Step 1: Create a Telegram bot**

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a name (e.g., "My Claude-B")
4. Choose a username (e.g., `my_claudeb_bot`)
5. Copy the token BotFather gives you (looks like `123456789:ABCdef...`)

**Step 2: Connect to Claude-B**

```bash
cb --telegram 123456789:ABCdefGHIjklMNO

# Output:
#   Telegram bot started!
#   Bot: @my_claudeb_bot
#   Send /start to your bot in Telegram to register.
```

**Step 3: Register in Telegram**

Open your bot in Telegram and send `/start`. You're now registered for notifications.

**Step 4: Use it**

```bash
# Fire a task — notification will arrive in Telegram
cb -f "Analyze the codebase for security issues"
```

When the task completes, you'll get a Telegram message like:

> ✅ **task-a1b2** completed (45.2s)
>
> ```
> Found 3 potential issues in auth module...
> ```
>
> Reply to this message to follow up, or /select a1b2 to switch sessions.

**Telegram commands:**
- `/start` — Register for notifications
- `/sessions` — List active sessions
- `/select <id>` — Select session for replies
- `/inbox` — Show inbox summary
- `/help` — Show all commands
- **Any text** — Send as prompt to selected session
- **Reply to notification** — Follow up on that specific session

**Manage Telegram:**
```bash
cb --telegram-status    # Check if running
cb --telegram-stop      # Disable and clear token
```

### Quick Start: Conversation Continuity

Sessions maintain conversation context across prompts — Claude remembers previous interactions:

```bash
# First prompt creates a conversation
cb "Explain the authentication flow in this codebase"

# Follow-up prompt continues the same conversation
cb "Now add rate limiting to the login endpoint"

# Claude remembers the auth flow discussion
cb "Add tests for what you just implemented"
```

### Quick Start: Multiple Sessions

```bash
# Create named sessions for different workstreams
cb -n backend
cb -n frontend

# Switch and work
cb -x backend
cb "Add rate limiting to API"

cb -x frontend
cb "Implement dark mode"

# Check all sessions
cb -s

# Watch a specific session's live output
cb -x backend
cb -w
```

### Quick Start: Hooks & Webhooks

```bash
# Get a desktop notification when any prompt completes
cb --hook "prompt.completed" "notify-send 'Claude-B' 'Task done'"

# Send a webhook to Slack on completion
cb --webhook "https://hooks.slack.com/services/T.../B.../xxx" --webhook-event "prompt.completed"

# List active hooks
cb --hooks
cb --webhooks
```

### Quick Start: REST API

```bash
# Start REST server
cb -r 3847

# Get API key
cb --api-key

# Use from any HTTP client
TOKEN=$(curl -s -X POST http://localhost:3847/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"api_key": "YOUR_KEY"}' | jq -r '.access_token')

curl http://localhost:3847/api/sessions -H "Authorization: Bearer $TOKEN"
```

### Quick Start: Multi-Host Orchestration

Distribute work across multiple servers running Claude-B:

```bash
# Each server needs REST API running
# On server1: cb -r
# On server2: cb -r

# From your local machine, add remote hosts
cb --remote-add http://server2:3847 --remote-key <api-key> --remote-name server2

# Send work to specific hosts
cb --remote server2 "Analyze the database schema"

# Or fire-and-forget to remote hosts
cb --remote-fire server2 "Run the full test suite"

# Monitor health
cb --remote-health
cb --remote-stats
```

### Piped Input

```bash
# Send file contents as prompt
cb < requirements.txt

# Pipe from other commands
echo "Fix the bug in auth.ts" | cb

# Combine with fire-and-forget
echo "Analyze this log for errors" | cb -f
```

## Architecture

```
┌──────────────┐    ┌────────────────┐
│   cb CLI     │    │  Telegram Bot  │
└──────┬───────┘    └───────┬────────┘
       │ Unix Socket        │
┌──────▼────────────────────▼──┐
│           Daemon             │
│                              │
│ ┌──────────┐  ┌───────────┐  │
│ │ Session  │  │   Hooks   │  │     ┌─────────────┐
│ │   Pool   │  │  Engine   │  │────▶│  Webhooks   │
│ └────┬─────┘  └───────────┘  │     └─────────────┘
│      │        ┌───────────┐  │
│      │        │  Inbox    │  │
│      │        └───────────┘  │     ┌─────────────┐
│      │        ┌───────────┐  │────▶│ Remote Host │
│      │        │  Orch.    │  │     │ Remote Host │
│      │        └───────────┘  │     └─────────────┘
│      │                       │
│ ┌────▼─────┐  ┌───────────┐  │
│ │  Claude  │  │ REST API  │◀─────── HTTP clients
│ │   Code   │  └───────────┘  │
│ └──────────┘                 │
└──────────────────────────────┘
```

### Components

- **CLI** (`cb`) - Thin client with interactive inbox TUI
- **Daemon** - Long-running process managing sessions, hooks, notifications, and integrations
- **Session** - Wraps Claude Code subprocess with conversation continuity
- **Notification Inbox** - JSONL-based store for completion notifications
- **Telegram Bot** - Sends notifications, receives prompts via Telegram
- **Hooks Engine** - Shell hooks and webhooks triggered by events
- **Orchestration** - Multi-host coordination with health checks and failover
- **REST API** - HTTP/WebSocket API for remote control
- **IPC** - Unix socket for local CLI-daemon communication

## Configuration

Config file: `~/.claude-b/config.json`

```json
{
  "sessions": {
    "maxConcurrent": 10,
    "defaultTimeout": 3600000
  },
  "notifications": {
    "shell": true,
    "command": "notify-send 'Claude-B' '$MESSAGE'"
  }
}
```

## Data Storage

```
~/.claude-b/
├── config.json              # Configuration
├── daemon.pid               # Daemon PID file
├── daemon.sock              # Unix socket
├── daemon.log               # Daemon logs
├── notifications.jsonl      # Notification inbox (append-only)
├── telegram.json            # Telegram bot config & session map
├── sessions/
│   ├── index.json           # Session index
│   └── <session-id>/        # Per-session data
│       └── history.jsonl    # Prompt/response history
└── hooks/
    └── config.json          # Hook & webhook definitions
```

## Docker

### Multi-Host Orchestration Testing

Run multiple Claude-B instances for testing orchestration features:

```bash
# Set your API key
export ANTHROPIC_API_KEY=your-key-here

# Start 3 instances
docker-compose up -d

# Instances available at:
#   host1: http://localhost:3847
#   host2: http://localhost:3848
#   host3: http://localhost:3849

# Configure orchestration from primary host
cb -r                                           # Start REST API
cb --remote-add http://localhost:3848 --remote-key <api-key> --remote-name host2
cb --remote-add http://localhost:3849 --remote-key <api-key> --remote-name host3

# Send prompts to remote hosts
cb --remote host2 "Analyze this codebase"
cb --remote-health                              # Check health status

# Stop containers
docker-compose down
```

### Single Instance

```bash
# Build image
docker build -t claude-b .

# Run container
docker run -d \
  -e ANTHROPIC_API_KEY=your-key \
  -p 3847:3847 \
  --name claude-b \
  claude-b
```

### Testing REST API and Hooks

Build and run a test container:

```bash
# Build the image
docker build -t claudeb-test:latest .

# Run container with API key
docker run -d \
  --name claudeb-test \
  -e ANTHROPIC_API_KEY=your-key-here \
  -p 3850:3847 \
  claudeb-test:latest

# Wait for startup and get API key from logs
sleep 3
docker logs claudeb-test
# Look for: API Key: cb_xxxxx...
```

Test the REST API:

```bash
# Set your API key (from docker logs output)
API_KEY="cb_your_api_key_here"

# Get JWT token
TOKEN=$(curl -4 -s -X POST http://127.0.0.1:3850/api/auth/token \
  -H "Content-Type: application/json" \
  -d "{\"api_key\": \"$API_KEY\"}" | jq -r '.access_token')

# Test health endpoint
curl -4 -s http://127.0.0.1:3850/api/health | jq

# List sessions
curl -4 -s http://127.0.0.1:3850/api/sessions \
  -H "Authorization: Bearer $TOKEN" | jq

# Create a session with model selection
curl -4 -s -X POST http://127.0.0.1:3850/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "test-session", "model": "sonnet"}' | jq

# Add a shell hook
curl -4 -s -X POST http://127.0.0.1:3850/api/hooks/shell \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event": "prompt.completed", "command": "echo Done!"}' | jq

# Add a webhook with session filter
curl -4 -s -X POST http://127.0.0.1:3850/api/hooks/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event": "session.created", "url": "https://httpbin.org/post", "sessionFilter": "test-session"}' | jq

# List all hooks
curl -4 -s http://127.0.0.1:3850/api/hooks/shell -H "Authorization: Bearer $TOKEN" | jq
curl -4 -s http://127.0.0.1:3850/api/hooks/webhook -H "Authorization: Bearer $TOKEN" | jq

# Cleanup
docker stop claudeb-test && docker rm claudeb-test
```

## Development

```bash
# Install dependencies
pnpm install

# Development mode (watch)
pnpm dev

# Build for production
pnpm build

# Type check
pnpm typecheck

# Run tests
pnpm test
```

## Potential Features

### Workflow Pipelines
Chain AI tasks together like GitHub Actions for AI. Define multi-step workflows where output flows between sessions.

```yaml
# .claude-b/workflows/code-review.yml
name: code-review
steps:
  - session: analyze
    prompt: "Analyze {{file}} for potential issues"
  - session: suggest
    prompt: "Based on: {{steps.analyze.output}}, suggest improvements"
  - session: implement
    prompt: "Implement the top suggestion"
    requires_approval: true
```

```bash
cb workflow run code-review --file src/api.ts
```

### Session Templates
Pre-configured session setups with custom system prompts, model selection, and hooks. One command to start specialized workflows.

```bash
# Create from template
cb -n myreview --template code-review

# Templates include: code-review, bug-fix, refactor, test-writer, docs
cb template list
cb template create my-custom --from current
```

### Prompt Queues & Scheduling
Queue prompts for batch processing. Schedule recurring AI tasks.

```bash
# Queue multiple prompts
cb queue add "Analyze auth.ts"
cb queue add "Analyze api.ts"
cb queue add "Summarize all findings"
cb queue run                    # Process sequentially

# Schedule recurring tasks
cb schedule "Review open PRs" --cron "0 9 * * *"
cb schedule "Update docs" --every 24h
```

### Cross-Session Context
Sessions that share context and reference each other's outputs.

```bash
# Create a context pool
cb context create myproject

# Sessions share the pool
cb -n backend --context myproject
cb -n frontend --context myproject

# Reference other sessions
cb -x frontend "Use the API schema from @backend to generate TypeScript types"
```

### Cost & Usage Analytics
Track token usage, set budgets, and monitor spending.

```bash
cb usage                        # Current session stats
cb usage --all                  # All sessions
cb usage --report weekly        # Usage report

cb budget set 10.00 --daily     # Daily spending limit
cb budget set 100.00 --session  # Per-session limit
```

### Session Snapshots & Branching
Git-like version control for AI sessions. Save state, branch, compare approaches.

```bash
cb snapshot create "before-refactor"
cb snapshot list
cb snapshot restore abc123

# Branch a session
cb branch myfeature --from main-session
cb branch compare main-session myfeature
```

### Smart Fallbacks & Retries
Automatic retry on failures with model fallback chains.

```bash
# Configure fallback chain
cb config set fallback-chain "opus,sonnet,haiku"

# Auto-retry with exponential backoff
cb config set auto-retry true
cb config set max-retries 3
```

### Output Transformers
Post-process AI output with built-in or custom transformers.

```bash
# Extract code blocks
cb "Generate a function" | cb transform extract-code

# Parse structured output
cb "List files as JSON" | cb transform json

# Custom transformer
cb transform register my-parser --script ./parse.js
```

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.
