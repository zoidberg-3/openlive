import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// When Hermes can't reopen one of its own sessions over ACP (its adapter only
// restores sessions it created itself — CLI-made ones, the vast majority, are
// refused), the fallback is a fresh session. Without context that is amnesia, so
// seed it with a short recap read from Hermes' own session store. READ-ONLY —
// never write into another program's live database.
//
// Kept deliberately small: user/assistant text only (no tool output), the newest
// MAX_MSGS live messages, each clipped. Some CLI sessions are huge tool spirals.
const MAX_MSGS = 12;
const MAX_CHARS_EACH = 600;

export function hermesRecap(sessionId: string): string {
  const db = join(homedir(), ".hermes", "state.db");
  if (!existsSync(db)) return "";
  try {
    // Lazy, like History's reader: no sqlite load unless a recap is actually needed.
    const get = (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule;
    const { DatabaseSync } = get("node:sqlite") as typeof import("node:sqlite");
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const rows = conn
        .prepare(`SELECT role, content FROM messages
                  WHERE session_id = ? AND active = 1 AND role IN ('user','assistant')
                    AND content IS NOT NULL AND trim(content) != ''
                  ORDER BY id DESC LIMIT ?`)
        .all(sessionId, MAX_MSGS) as { role: string; content: string }[];
      if (!rows.length) return "";
      const lines = rows.reverse().map((r) => {
        const t = r.content.replace(/\s+/g, " ").trim();
        return `${r.role === "user" ? "User" : "You"}: ${t.length > MAX_CHARS_EACH ? `${t.slice(0, MAX_CHARS_EACH)}…` : t}`;
      });
      return `[Context — the end of an earlier session with this user (${sessionId}), which could not be reopened directly:\n${lines.join("\n")}]\n\n`;
    } finally { conn.close(); }
  } catch { return ""; } // best-effort: no recap is the old behaviour, never a failure
}
