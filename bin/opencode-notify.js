// OpenCode plugin → Claude-B /api/notify → Telegram
//
// The OpenCode counterpart of cb-notify.sh (Claude Code) and codex-notify.sh
// (Codex). OpenCode has no shell-hook system; instead it loads JS/TS plugins
// from ~/.config/opencode/plugins/ and emits a `session.idle` event every time
// a session finishes responding. On that event we fetch the final assistant
// message, tag it with the tmux target (session:window.pane), and POST it to
// Claude-B's REST API, which forwards it to Telegram via the same
// bot.broadcastNotification path the other hooks use.
//
// Design rules (identical to cb-notify.sh / codex-notify.sh):
//  - NEVER fail the host OpenCode session. Every error is swallowed.
//  - Skip silently if not running inside tmux.
//  - Skip silently if Claude-B daemon / REST / API key is unavailable.
//  - Child (subagent/task) sessions are skipped — only top-level turns notify.
//
// Installed as: ~/.config/opencode/plugins/claude-b-notify.js (copy or symlink)

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const CB_URL = process.env.CB_NOTIFY_URL || "http://127.0.0.1:3847/api/notify";
const CB_KEY_FILE = process.env.CB_API_KEY_FILE || `${homedir()}/.claude-b/api.key`;
const LOG_FILE = process.env.CB_OPENCODE_NOTIFY_LOG || `${homedir()}/.claude-b/opencode-notify.log`;
const MAX_RESULT_CHARS = 3000;

function log(line) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function tmux(format) {
  try {
    const args = ["display-message", "-p"];
    if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
    args.push(format);
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return "";
  }
}

export const ClaudeBNotify = async ({ client, directory }) => {
  return {
    event: async ({ event }) => {
      try {
        if (event?.type !== "session.idle") return;
        // We only notify for tmux-hosted sessions.
        if (!process.env.TMUX) return;

        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        const tmuxTarget = tmux("#S:#I.#P");
        if (!tmuxTarget) return;

        const session = (await client.session.get({ path: { id: sessionID } }))?.data;
        if (session?.parentID) return; // subagent / task child session

        // Last assistant message with at least one non-empty text part.
        const messages = (await client.session.messages({ path: { id: sessionID } }))?.data || [];
        let lastAssistant = "";
        for (let i = messages.length - 1; i >= 0 && !lastAssistant; i--) {
          const m = messages[i];
          if (m?.info?.role !== "assistant") continue;
          lastAssistant = (m.parts || [])
            .filter((p) => p.type === "text" && !p.synthetic && p.text)
            .map((p) => p.text)
            .join("\n")
            .trim();
        }
        if (!lastAssistant) lastAssistant = "(OpenCode turn completed — no assistant text)";
        if (lastAssistant.length > MAX_RESULT_CHARS) {
          lastAssistant = lastAssistant.slice(0, MAX_RESULT_CHARS) + "…";
        }

        let apiKey = "";
        try {
          apiKey = readFileSync(CB_KEY_FILE, "utf8").trim();
        } catch {}
        if (!apiKey) return;

        const cwd = session?.directory || directory || "";
        const slug = session?.title || basename(cwd) || "opencode";
        const body = {
          sessionId: `tmux:${tmuxTarget}`,
          sessionName: `${tmuxTarget} opencode:${slug}`,
          type: "prompt.completed",
          agent: "opencode",
          goal: cwd,
          exitCode: 0,
          resultPreview: lastAssistant,
        };

        const res = await fetch(CB_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Claude-B-Key": apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        log(`→ ${tmuxTarget} (${lastAssistant.length} chars) ${res.status} ${await res.text()}`);
      } catch (err) {
        log(`error: ${err?.message || err}`);
      }
    },
  };
};
