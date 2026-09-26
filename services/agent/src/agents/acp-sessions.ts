import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "@openlive/shared";
import { widenedPath } from "@openlive/shared/node";
import { adapterFor } from "./acp-agent.js";
import type { AgentId } from "./types.js";
import { killTree } from "./proc.js";
import { log } from "../log.js";

// List the sessions an AGENT knows about in a folder, as opposed to the chats
// OpenLive has records of. Those are not the same set: a session started in the
// agent's own CLI is a first-class session on disk that OpenLive has simply never
// seen, so History can't offer it. `session/list` is advertised by Claude Code
// and Hermes alike and returns exactly that list.
//
// This spawns a throwaway adapter, because listing has to work BEFORE a call
// starts and there is no connection yet. Measured cost of spawn → initialize →
// list → kill: ~2.3s for claude-agent-acp, ~5s for hermes acp. Cheap enough to
// fetch when the History pane opens; cached briefly so reopening is instant.

export type AgentSession = { sessionId: string; title?: string; updatedAt?: string; cwd?: string };

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; sessions: AgentSession[] }>();
const inflight = new Map<string, Promise<AgentSession[]>>();

/** The SDK (1.2.1) has no typed helper for session/list — 1.5.0 adds one — so the
 *  response is parsed defensively rather than trusted. */
function parseSessions(res: unknown): AgentSession[] {
  const raw = (res as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(raw)) return [];
  const out: AgentSession[] = [];
  for (const s of raw) {
    const id = (s as { sessionId?: unknown })?.sessionId;
    if (typeof id !== "string" || !id) continue;
    const r = s as { title?: unknown; updatedAt?: unknown; cwd?: unknown };
    out.push({
      sessionId: id,
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
      ...(typeof r.cwd === "string" ? { cwd: r.cwd } : {}),
    });
  }
  // Newest first — History is read top-down.
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

async function fetchSessions(id: AgentId, cwd: string): Promise<AgentSession[]> {
  const cfg = adapterFor(id, cwd);
  if (!cfg.cwd) return [];
  const isWin = process.platform === "win32";
  const child = spawn(cfg.command, cfg.args, {
    cwd: cfg.cwd,
    shell: isWin,
    env: { ...process.env, PATH: widenedPath(), ...(AGENT_REGISTRY[id].acp.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: !isWin,
  });
  child.stderr.resume(); // drain, or a chatty adapter fills the pipe and stalls
  try {
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as never, Readable.toWeb(child.stdout) as never);
    // A listing client answers nothing: no permissions, no terminals, no fs.
    const conn = new ClientSideConnection(() => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) as never,
      sessionUpdate: async () => {},
    }) as never, stream);
    const init = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const caps = (init.agentCapabilities as { sessionCapabilities?: { list?: unknown } } | undefined)?.sessionCapabilities;
    if (!caps || caps.list === undefined) return []; // agent can't enumerate — not an error
    return parseSessions(await conn.request("session/list", { cwd: cfg.cwd }));
  } catch (e) {
    log.debug("agents", `session/list(${id}) failed:`, e);
    return []; // never surface as an error: History still has OpenLive's own chats
  } finally {
    killTree(child);
  }
}

/** Sessions the agent itself knows about in `cwd`. Empty on any failure. */
export function listAgentSessions(id: AgentId, cwd: string): Promise<AgentSession[]> {
  const key = `${id}\u0000${cwd}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.sessions);
  const running = inflight.get(key);
  if (running) return running; // one spawn per folder, however many callers ask
  const p = fetchSessions(id, cwd)
    .then((sessions) => { cache.set(key, { at: Date.now(), sessions }); return sessions; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
