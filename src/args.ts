/**
 * Claude Code's command line, read just far enough to know what the surface
 * must handle itself (which session to open, the first prompt, the model and
 * modes it can change later) and what passes straight through.
 */

/** Flags that take one value. */
const VALUE = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file", "--autocompact", "--debug-file", "--effort", "--environment", "--fallback-model", "--json-schema",
  "--max-budget-usd", "--max-turns", "--model", "-n", "--name", "--output-format", "--input-format", "--permission-mode", "--permission-prompts", "--plugin-dir", "--plugin-url",
  "--session-id", "--setting-sources", "--settings", "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot", "--remote-control-session-name-prefix", "--resume-session-at",
  "--max-thinking-tokens", "--thinking-display", "--task-budget",
]);
/** Flags that take every following word up to the next flag. */
const VARIADIC = new Set(["--add-dir", "--allowedTools", "--allowed-tools", "--betas", "--disallowedTools", "--disallowed-tools", "--file", "--mcp-config", "--tools"]);
/** Flags whose value may be left out. */
const OPTIONAL = new Set(["-d", "--debug", "-r", "--resume", "--from-pr", "--prompt-suggestions", "--remote-control", "--teleport", "-w", "--worktree", "--cloud"]);

/** Invocations that are not an interactive session in this pane: stock Claude Code runs them. */
const STOCK_FLAGS = new Set(["-p", "--print", "-h", "--help", "-v", "--version", "--bg", "--background", "--cloud", "--desktop", "--remote-control", "--teleport", "--tmux", "-w", "--worktree", "--from-pr", "--output-format", "--input-format", "--ide", "--chrome"]);
const SUBCOMMANDS = new Set(["agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp", "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade"]);

export interface Launch {
  /** Whether a surface can front this invocation. */
  native: boolean;
  /** Everything that passes to every `claude` this session starts. */
  base: string[];
  /** `--resume <id>`; `true` for a bare `--resume` (the picker opens). */
  resume: string | true | null;
  /** `--continue`: the folder's newest session. */
  continue: boolean;
  fork: boolean;
  sessionId: string | null;
  name: string | null;
  model: string | null;
  permissionMode: string | null;
  effort: string | null;
  /** Bypassing permissions may be chosen in this session. */
  allowBypass: boolean;
  /** The prompt given on the command line, sent as the first message. */
  prompt: string;
}

export function parseArgs(args: readonly string[]): Launch {
  const launch: Launch = { native: true, base: [], resume: null, continue: false, fork: false, sessionId: null, name: null, model: null, permissionMode: null, effort: null, allowBypass: false, prompt: "" };
  const positional: string[] = [];
  if (args[0] && SUBCOMMANDS.has(args[0])) launch.native = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (STOCK_FLAGS.has(flag)) launch.native = false;
    let values: string[] = [];
    if (eq > 0) values = [arg.slice(eq + 1)];
    else if (VALUE.has(flag)) {
      if (index + 1 < args.length) values = [args[++index]!];
    } else if (VARIADIC.has(flag)) {
      while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) values.push(args[++index]!);
    } else if (OPTIONAL.has(flag)) {
      if (index + 1 < args.length && !args[index + 1]!.startsWith("-")) values = [args[++index]!];
    }
    const value = values[0] ?? null;
    switch (flag) {
      case "-r":
      case "--resume":
        launch.resume = value ?? true;
        break;
      case "-c":
      case "--continue":
        launch.continue = true;
        break;
      case "--fork-session":
        launch.fork = true;
        break;
      case "--session-id":
        launch.sessionId = value;
        break;
      case "--resume-session-at":
        break;
      case "-n":
      case "--name":
        launch.name = value;
        break;
      case "--model":
        launch.model = value;
        break;
      case "--permission-mode":
        launch.permissionMode = value;
        break;
      case "--effort":
        launch.effort = value;
        break;
      case "--dangerously-skip-permissions":
        launch.permissionMode = "bypassPermissions";
        launch.allowBypass = true;
        break;
      case "--allow-dangerously-skip-permissions":
        launch.allowBypass = true;
        break;
      default:
        launch.base.push(flag, ...values);
    }
  }
  launch.prompt = positional.join(" ").trim();
  return launch;
}

export interface SpawnState {
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  /** Resume this session… */
  resume?: string | null;
  /** …up to this assistant message… */
  resumeAt?: string | null;
  /** …as a new session. */
  fork?: boolean;
  /** Start a new session under this id. */
  sessionId?: string | null;
  name?: string | null;
}

/** The arguments of one `claude` process of the session. */
export function spawnArgs(launch: Launch, state: SpawnState): string[] {
  const out = [...launch.base];
  if (launch.allowBypass) out.push("--allow-dangerously-skip-permissions");
  if (state.model) out.push("--model", state.model);
  if (state.permissionMode) out.push("--permission-mode", state.permissionMode);
  if (state.effort) out.push("--effort", state.effort);
  if (state.resume) {
    out.push("--resume", state.resume);
    if (state.resumeAt) out.push("--resume-session-at", state.resumeAt);
    if (state.fork) out.push("--fork-session");
  } else if (state.sessionId) out.push("--session-id", state.sessionId);
  if (state.name) out.push("--name", state.name);
  return out;
}
