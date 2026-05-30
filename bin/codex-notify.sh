#!/usr/bin/env bash
# Codex CLI Stop hook → Claude-B /api/notify → Telegram
#
# The Codex counterpart of cb-notify.sh. Fires every time a top-level Codex
# response finishes in any tmux pane. Extracts the final assistant message,
# tags it with the tmux target (session:window.pane) + a slug, and POSTs the
# payload to Claude-B's REST API, which forwards it to Telegram via the same
# bot.broadcastNotification path the Claude Code hook uses.
#
# Codex 0.134+ ships a Claude-Code-compatible hooks system. The Stop hook
# receives its JSON payload on STDIN (same channel as Claude Code) and, unlike
# Claude, hands us `last_assistant_message` directly — so no transcript parsing
# is needed for the happy path. `transcript_path` points at the Codex rollout
# JSONL (a different format from Claude's), which we forward so the daemon can
# ground the voice pipeline (the daemon's parser understands both formats).
#
# The `agent: "codex"` field lets the daemon tell Codex panes apart from Claude
# panes (Claude panes are enumerated from tmux by `pane_current_command`, but
# Codex panes report `node`, so the daemon learns about them from these POSTs).
#
# Design rules (identical to cb-notify.sh):
#  - NEVER fail the host Codex session. Always exit 0 on any error.
#  - Skip silently if not running inside tmux.
#  - Skip silently if Claude-B daemon / REST / API key is unavailable.
#
# Installed as: ~/.codex/hooks.json hooks.Stop → this script
#   { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
#     "command": "$HOME/Claude-B/bin/codex-notify.sh" }] }] } }

set +e  # tolerate errors — we never want to break the host session

CB_URL="${CB_NOTIFY_URL:-http://127.0.0.1:3847/api/notify}"
CB_KEY_FILE="${CB_API_KEY_FILE:-$HOME/.claude-b/api.key}"
MAX_RESULT_CHARS=3000
LOG_FILE="${CB_NOTIFY_LOG:-$HOME/.claude-b/codex-notify.log}"

# ─── Read Codex hook payload from stdin ─────────────────────────────────────
payload=$(cat)
[[ -z "$payload" ]] && exit 0

transcript_path=$(jq -r '.transcript_path // empty' <<<"$payload" 2>/dev/null)
hook_cwd=$(jq -r '.cwd // empty' <<<"$payload" 2>/dev/null)
last_assistant=$(jq -r '.last_assistant_message // empty' <<<"$payload" 2>/dev/null)

# ─── We only notify for tmux-hosted sessions ────────────────────────────────
# $TMUX is set by tmux itself for any process running inside a pane.
if [[ -z "${TMUX:-}" ]]; then
  exit 0
fi

# ─── Derive the tmux target + human label ───────────────────────────────────
# Prefer $TMUX_PANE (the unique pane id like %42) for lookup, then ask tmux
# for the stable session:window.pane target and the pane title.
pane_ref="${TMUX_PANE:-}"
if [[ -n "$pane_ref" ]]; then
  tmux_target=$(tmux display-message -p -t "$pane_ref" '#S:#I.#P' 2>/dev/null)
  pane_title=$(tmux display-message -p -t "$pane_ref" '#T' 2>/dev/null)
else
  tmux_target=$(tmux display-message -p '#S:#I.#P' 2>/dev/null)
  pane_title=$(tmux display-message -p '#T' 2>/dev/null)
fi

if [[ -z "$tmux_target" ]]; then
  exit 0
fi

# Codex doesn't set a rich pane title (it's typically just the cwd basename),
# so build a slug from the working directory for a readable label/goal. Fall
# back to the pane title, then to "codex".
slug=""
if [[ -n "$hook_cwd" ]]; then
  slug=$(basename "$hook_cwd" 2>/dev/null)
fi
[[ -z "$slug" && -n "$pane_title" ]] && slug="$pane_title"
[[ -z "$slug" ]] && slug="codex"

session_label="${tmux_target} codex:${slug}"

# ─── Resolve the final assistant message ────────────────────────────────────
# The Stop payload usually carries last_assistant_message. If it's empty (e.g.
# a turn that ended on a tool call only), fall back to the last `agent_message`
# event in the rollout transcript. Codex rollout JSONL records look like:
#   {"type":"event_msg","payload":{"type":"agent_message","message":"..."}}
if [[ -z "$last_assistant" && -n "$transcript_path" && -f "$transcript_path" ]]; then
  # Small delay: the Stop hook can fire before the final rollout line is
  # flushed to disk (mirrors the cb-notify.sh rationale).
  sleep 0.5
  last_assistant=$(
    grep '"type":"event_msg"' "$transcript_path" 2>/dev/null \
      | tac \
      | while IFS= read -r line; do
          text=$(jq -r 'select(.payload.type=="agent_message") | .payload.message // empty' <<<"$line" 2>/dev/null)
          if [[ -n "$text" ]]; then
            echo "$text"
            break
          fi
        done
  )
fi

# Fallback body if nothing at all
if [[ -z "$last_assistant" ]]; then
  last_assistant="(Codex turn completed — no assistant message)"
fi

# Truncate for the mobile display
if [[ ${#last_assistant} -gt $MAX_RESULT_CHARS ]]; then
  last_assistant="${last_assistant:0:$MAX_RESULT_CHARS}…"
fi

# ─── Look up API key and POST to /api/notify ────────────────────────────────
if [[ ! -r "$CB_KEY_FILE" ]]; then
  exit 0
fi
api_key=$(<"$CB_KEY_FILE")
[[ -z "$api_key" ]] && exit 0

# Build JSON body safely via jq (handles quoting + newlines). The `agent`
# field marks this as a Codex pane; `transcriptPath` is cached by the daemon
# so the Telegram voice pipeline can ground optimizePrompt in real history.
body=$(jq -n \
  --arg sessionId "tmux:${tmux_target}" \
  --arg sessionName "$session_label" \
  --arg goal "$hook_cwd" \
  --arg result "$last_assistant" \
  --arg transcriptPath "$transcript_path" \
  '{
    sessionId: $sessionId,
    sessionName: $sessionName,
    type: "prompt.completed",
    agent: "codex",
    goal: $goal,
    exitCode: 0,
    resultPreview: $result
  }
  + (if $transcriptPath != "" then { transcriptPath: $transcriptPath } else {} end)')

# Fire and forget — short timeout, discard output. Log to a rolling file so
# the user can debug without cluttering their terminal.
{
  echo "[$(date -Iseconds)] → $tmux_target (${#last_assistant} chars)"
  curl -sS -m 5 -X POST "$CB_URL" \
    -H 'Content-Type: application/json' \
    -H "X-Claude-B-Key: ${api_key}" \
    --data-binary "$body" 2>&1
  echo
} >>"$LOG_FILE" 2>&1 &

# Detach background curl so we exit immediately — never block host session.
disown 2>/dev/null || true
exit 0
