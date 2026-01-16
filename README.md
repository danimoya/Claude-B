<p align="center">
  <img src="assets/Claude-B.png" alt="Claude-B Logo" width="800">
</p>

# Claude-B

> Run Claude Code in the background. Send prompts, do other work, check results later.

Claude-B is a background-capable wrapper around [Claude Code](https://claude.ai/code) that enables:

- **Async workflows** - Send prompts, continue working, check results when ready
- **Session management** - Multiple concurrent AI sessions
- **Foreground attach** - Like `fg` in Linux, attach to see live output
- **Auto-watch streaming** - Automatically streams output after sending prompts
- **Status feedback** - Real-time processing/completed/error status messages
- **REST API** - Control sessions remotely via HTTP/WebSocket
- **Hooks** - Shell hooks and webhooks for notifications and automation

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
| `cb --kill <id>` | `-k` | Terminate session |
| `cb --watch` | `-w` | Watch live output |
| `cb --select <id>` | `-x` | Select session for commands |
| `cb --current` | `-c` | Show current session |
| `cb --rest [port]` | `-r` | Start REST API server |
| `cb --rest-stop` | | Stop REST API server |
| `cb --status` | | Daemon status and health |

## Workflows

### Basic Async Workflow
```bash
# Start a task
cb "Refactor the authentication module"

# Do other work...
vim other_file.ts

# Check status
cb -l
```

### Multiple Sessions
```bash
# Create named sessions
cb -n backend
cb -n frontend

# Select and use
cb -x backend
cb "Add rate limiting to API"

cb -x frontend
cb "Implement dark mode"

# Check both
cb -s
```

### Live Monitoring
```bash
# Watch output as it streams
cb -w

# Or attach for interactive mode
cb -a backend

# Detach with Ctrl+D
```

### Piped Input
```bash
# Send file contents as prompt
cb < requirements.txt

# Pipe from other commands
echo "Fix the bug in auth.ts" | cb
```

## Architecture

```
┌──────────────┐
│   cb CLI     │
└──────┬───────┘
       │ Unix Socket
┌──────▼───────┐
│   Daemon     │
│              │
│ ┌──────────┐ │
│ │ Session  │ │──▶ claude --print
│ │   Pool   │ │
│ └──────────┘ │
└──────────────┘
```

### Components

- **CLI** (`cb`) - Thin client that communicates with daemon
- **Daemon** - Long-running process managing sessions
- **Session** - Wraps Claude Code subprocess, manages I/O
- **IPC** - Unix socket for local communication

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
├── config.json          # Configuration
├── daemon.pid           # Daemon PID file
├── daemon.sock          # Unix socket
├── sessions/
│   ├── index.json       # Session index
│   └── <session-id>/    # Per-session data
└── logs/                # Log files
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
