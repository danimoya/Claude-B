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
- **REST API** - Control sessions from other machines (planned)
- **Hooks** - Notifications and multi-host AI orchestration (planned)

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

## Roadmap

- [x] Background execution with daemon
- [x] Session management
- [x] Attach/detach (fg-style)
- [x] Live output streaming
- [x] Auto-watch with status feedback
- [x] Async prompt processing
- [x] REST API for remote access
- [x] JWT authentication
- [x] Hooks and webhooks
- [x] Multi-host orchestration

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.
