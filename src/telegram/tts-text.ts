/**
 * Convert a Claude Code / Codex result (Markdown, possibly with code, tables,
 * links and metadata) into clean, speech-friendly plain text for TTS.
 *
 * The Listen button synthesizes the raw assistant message. Read verbatim, a
 * TTS engine spends most of its time on things nobody wants to hear: code
 * blocks, tables of symbols, raw URLs, emoji read out by name ("sparkles"),
 * and metadata lines (session header, PWD, "Source:", "Reply to follow up").
 * This strips all of that and keeps the prose.
 *
 * Pure + deterministic (no LLM call) so playback stays fast and predictable.
 * Ordering matters: structural removals (code fences, Sources section, tables)
 * run before inline Markdown cleanup so they can still anchor on their syntax.
 */

// OpenAI TTS (and most providers) cap input around 4096 chars. resultPreview is
// already truncated upstream, but guard here too after expansion-free cleanup.
const MAX_SPEECH_CHARS = 4000;

export function sanitizeForSpeech(input: string): string {
  if (!input) return '';
  let t = input.replace(/\r\n?/g, '\n');

  // ── Structural removals (anchor on Markdown syntax first) ─────────────────

  // Fenced code blocks ```lang … ``` — replace with a short spoken marker so
  // the listener knows code was present without hearing it.
  t = t.replace(/```[\s\S]*?```/g, ' (code block omitted) ');
  t = t.replace(/~~~[\s\S]*?~~~/g, ' (code block omitted) ');
  // Stray/unclosed fence to end of line.
  t = t.replace(/^[ \t]*(```|~~~).*$/gm, ' (code omitted) ');

  // Trailing "Sources:" / "References:" section (deep-research style link
  // dumps) — drop from the heading to the end of the message.
  t = t.replace(/\n[ \t]*#{0,6}[ \t]*(sources|references)[ \t]*:?[ \t]*\n[\s\S]*$/i, '\n');

  // Markdown tables: drop separator rows (|---|:--:|) entirely, then flatten
  // "| a | b |" rows into "a, b" so any prose in cells still reads naturally.
  t = t.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$/gm, '');
  t = t.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row.split('|').map((c) => c.trim()).filter(Boolean).join(', '),
  );
  // Unicode box-drawing tables → spaces (the project renders box tables).
  t = t.replace(/[─-╿]/g, ' ');

  // ── Inline / link cleanup ─────────────────────────────────────────────────

  // Images ![alt](url) and links [text](url) → keep the human text.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bare URLs → drop (and tidy any leftover "see " dangling).
  t = t.replace(/\bhttps?:\/\/\S+/gi, '');
  t = t.replace(/<[^>]+>/g, ''); // HTML tags / autolinks
  t = t.replace(/`([^`]+)`/g, '$1'); // inline code → inner text

  // ── Line-level Markdown structure ─────────────────────────────────────────

  const lines = t.split('\n').map((line) => {
    let l = line;
    l = l.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, ''); // headings → spoken title
    l = l.replace(/^[ \t]{0,3}>[ \t]?/, '');       // blockquotes
    l = l.replace(/^[ \t]*[-*+][ \t]+/, '');        // bullet lists
    l = l.replace(/^[ \t]*\d+[.)][ \t]+/, '');      // ordered lists
    l = l.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/, ''); // horizontal rules
    return l;
  });

  // Metadata lines we never want spoken (notification header / footer / source).
  const META = [
    /^[ \t]*(PWD|CWD|Source|Sources|Session|Goal|Status|Duration|Cost)[ \t]*:/i,
    /^[ \t]*Reply to follow up\b/i,
    /^[ \t]*\/select\b/i,
    /^[ \t]*\d+\/\d+[ \t]*$/, // chunk counters like "1/3"
  ];
  t = lines.filter((l) => !META.some((re) => re.test(l))).join('\n');

  // ── Final inline polish ───────────────────────────────────────────────────

  t = t.replace(/(\*\*|\*|__|_|~~)/g, ''); // leftover emphasis markers
  t = stripEmoji(t);

  // Collapse whitespace.
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.trim();

  if (t.length > MAX_SPEECH_CHARS) {
    t = t.slice(0, MAX_SPEECH_CHARS).replace(/\s+\S*$/, '') + '… (message truncated)';
  }

  return t;
}

// Strip emoji and pictographs (incl. variation selectors / flags / ZWJ) so the
// TTS engine doesn't read them out by name.
function stripEmoji(s: string): string {
  return s
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      '',
    )
    .replace(/[ \t]{2,}/g, ' ');
}
