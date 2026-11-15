/**
 * Where things live: the Claude Code binary this surface fronts, Claude's
 * config directory (sessions are shared with the terminal UI), and the
 * surface's own state (prompt history, display choices, key bindings).
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The Claude Code binary: `CLAUDE_TSP_BIN`, else `claude` on PATH. */
export function stockPath(): string {
  if (process.env.CLAUDE_TSP_BIN) return process.env.CLAUDE_TSP_BIN;
  let self = "";
  try {
    self = realpathSync(process.argv[1] ?? "");
  } catch {
    /* not a file */
  }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "claude");
    if (!existsSync(candidate)) continue;
    try {
      if (realpathSync(candidate) === self) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  return "claude";
}

/** Claude's config directory: what `CLAUDE_CONFIG_DIR` names, else `~/.claude`. */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The surface's own state directory (0700). */
export function stateDir(): string {
  const dir = process.env.CLAUDE_TSP_HOME || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "claude-tsp");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* read-only home: state is then not kept */
  }
  return dir;
}

/** `/home/u/my.proj` → `-home-u-my-proj`: the folder Claude keeps a project's sessions in. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectDir(cwd: string): string {
  return join(configDir(), "projects", projectSlug(cwd));
}

export function sessionFile(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

/** A subagent's own transcript, written beside its session. */
export function sidechainFile(cwd: string, sessionId: string, agentId: string): string {
  return join(projectDir(cwd), sessionId, "subagents", `agent-${agentId}.jsonl`);
}

/** The name this build goes by: `claude-pi` when it fronts the claude-pi toolkit. */
export function profile(): { id: string; name: string; pi: boolean } {
  const pi = process.env.CLAUDE_TSP_PROFILE === "claude-pi";
  return { id: pi ? "claude-pi" : "claude", name: pi ? "claude-pi" : "Claude Code", pi };
}
