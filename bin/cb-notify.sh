#!/usr/bin/env bash
# Claude Code Stop hook → Claude-B /api/notify → Telegram
#
# Fires every time a top-level Claude Code response finishes in any tmux pane.
# Extracts the last assistant text from the session transcript, tags it with
# the tmux target (session:window.pane) + pane title (Claude's slug), and
# POSTs the payload to Claude-B's REST API. Claude-B forwards it to Telegram
# via the existing bot.broadcastNotification path.
#
# Design rules:
#  - NEVER fail the host Claude session. Always exit 0 on any error.
#  - Skip silently if not running inside tmux.
#  - Skip silently if Claude-B daemon / REST / API key is unavailable.
#
# Installed as: ~/.claude/settings.json hooks.Stop → this script
#   "hooks": { "Stop": [{ "hooks": [{ "type": "command",
#     "command": "$HOME/Claude-B/bin/cb-notify.sh" }] }] }

set +e  # tolerate errors — we never want to break the host session

CB_URL="${CB_NOTIFY_URL:-http://127.0.0.1:3847/api/notify}"
CB_KEY_FILE="${CB_API_KEY_FILE:-$HOME/.claude-b/api.key}"
MAX_RESULT_CHARS=3000
LOG_FILE="${CB_NOTIFY_LOG:-$HOME/.claude-b/cb-notify.log}"

# ─── Read Claude Code hook payload from stdin ───────────────────────────────
payload=$(cat)
[[ -z "$payload" ]] && exit 0

transcript_path=$(jq -r '.transcript_path // empty' <<<"$payload" 2>/dev/null)
claude_session_id=$(jq -r '.session_id // empty' <<<"$payload" 2>/dev/null)
hook_cwd=$(jq -r '.cwd // empty' <<<"$payload" 2>/dev/null)

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

session_label="$tmux_target"
if [[ -n "$pane_title" ]]; then
  session_label="${tmux_target} ${pane_title}"
fi

# ─── Extract last assistant text from the transcript ────────────────────────
# Transcript is JSONL where each line is a typed record. We want the most
# recent assistant message that has at least one text content block. Some
# assistant turns end with tool_use blocks only (e.g. a final Edit/Bash
# without commentary); those are skipped backwards until a text-bearing
# message is found.
last_assistant=""
if [[ -n "$transcript_path" && -f "$transcript_path" ]]; then
  last_assistant=$(
    grep '"type":"assistant"' "$transcript_path" 2>/dev/null \
      | tac \
      | while IFS= read -r line; do
          text=$(jq -r '
            .message.content // []
            | map(select(.type=="text"))
            | map(.text)
            | join("\n")
          ' <<<"$line" 2>/dev/null)
          if [[ -n "$text" ]]; then
            echo "$text"
            break
          fi
        done
  )
fi

# Grab the most recent turn_duration record if present (Claude writes one
# system:turn_duration line after each completed assistant turn).
duration_ms=""
if [[ -n "$transcript_path" && -f "$transcript_path" ]]; then
  duration_ms=$(
    grep '"subtype":"turn_duration"' "$transcript_path" 2>/dev/null \
      | tail -1 \
      | jq -r '.durationMs // empty' 2>/dev/null
  )
fi

# Fallback body if no assistant message had text at all
if [[ -z "$last_assistant" ]]; then
  last_assistant="(session completed — no assistant text in transcript)"
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

# Build JSON body safely via jq (handles quoting + newlines).
# transcriptPath is cached by the daemon so the Telegram voice pipeline can
# later ground optimizePrompt in real session history.
body=$(jq -n \
  --arg sessionId "tmux:${tmux_target}" \
  --arg sessionName "$session_label" \
  --arg goal "$hook_cwd" \
  --arg result "$last_assistant" \
  --arg duration "$duration_ms" \
  --arg transcriptPath "$transcript_path" \
  '{
    sessionId: $sessionId,
    sessionName: $sessionName,
    type: "prompt.completed",
    goal: $goal,
    exitCode: 0,
    resultPreview: $result
  }
  + (if $duration != "" then { durationMs: ($duration | tonumber) } else {} end)
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
