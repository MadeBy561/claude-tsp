/**
 * Whether the Claude Code at hand still speaks what claude-tsp relies on.
 *
 * The surface drives Claude Code through control requests of its stream-json
 * session. Several are not in the published SDK, so a Claude Code update can
 * rename one or change what it answers. These checks ask a live session for
 * each request the surface uses and look at the fields it reads. They need no
 * sign-in and send no prompt: nothing reaches a model.
 *
 * `claude-tsp --check-compat` runs them from a shell (a scheduled workflow
 * does, against each new Claude Code); `/doctor` shows them in the surface.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Claude } from "./cc.js";
import { compareVersions } from "./update.js";

type Json = Record<string, any>;

/** What the package says of Claude Code: the oldest that works, and the newest the release was checked with. */
export interface Supported {
  minimum: string;
  tested: string;
}

export function supported(): Supported {
  try {
    const field = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { claudeCode?: Partial<Supported> }).claudeCode ?? {};
    return { minimum: String(field.minimum ?? "0.0.0"), tested: String(field.tested ?? "0.0.0") };
  } catch {
    return { minimum: "0.0.0", tested: "0.0.0" };
  }
}

/** Where a Claude Code version stands against what the release supports. */
export function standing(version: string, range: Supported = supported()): "older" | "tested" | "newer" | "unknown" {
  const plain = /^\d+\.\d+\.\d+/.exec(version.trim())?.[0];
  if (!plain) return "unknown";
  if (compareVersions(plain, range.minimum) < 0) return "older";
  return compareVersions(plain, range.tested) > 0 ? "newer" : "tested";
}

export interface CheckResult {
  id: string;
  /** What the surface uses it for. */
  what: string;
  /** Without it the surface does not work at all (the rest lose one feature each). */
  core: boolean;
  ok: boolean;
  /** What was seen, or what was wrong. */
  detail: string;
}

interface Check {
  id: string;
  what: string;
  core?: boolean;
  /** Returns what was seen; throws what is wrong. */
  run(cc: Requester, seen: Json): Promise<string>;
}

/** The part of the protocol client a check needs. */
export interface Requester {
  request(subtype: string, body?: Json, timeoutMs?: number): Promise<any>;
}

/** Claude Code's answer to a request it does not have. */
const UNSUPPORTED = /unsupported control request subtype|unknown (?:control )?request/i;

/** The session itself is gone: no answer says anything about the request. */
const GONE = /is not running|ENOENT|EACCES|exited|timed out/i;

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const typeOf = (value: unknown): string => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

/** The fields of an answer the surface reads, each with the type it expects (`a|b` for either). */
function fields(answer: unknown, spec: Record<string, string>, where: string): void {
  need(answer && typeof answer === "object", `${where} answered ${typeOf(answer)}, not an object`);
  for (const [path, types] of Object.entries(spec)) {
    let value: any = answer;
    for (const key of path.split(".")) value = value == null ? undefined : value[key];
    need(types.split("|").includes(value === undefined ? "missing" : typeOf(value)), `${where}.${path} is ${value === undefined ? "missing" : typeOf(value)}, expected ${types}`);
  }
}

/** A request the surface only needs to exist: any answer but "unsupported" will do, an error about its arguments included. */
function exists(id: string, what: string, body: Json): Check {
  return {
    id,
    what,
    run: async cc => {
      try {
        await cc.request(id, body, 15_000);
        return "answered";
      } catch (error) {
        const message = (error as Error).message;
        need(!UNSUPPORTED.test(message) && !GONE.test(message), message);
        return `known (${message.split("\n")[0]!.slice(0, 80)})`;
      }
    },
  };
}

const CHECKS: Check[] = [
  {
    id: "initialize",
    what: "The session opens and lists its commands, models and modes",
    core: true,
    run: async (cc, seen) => {
      const init = (seen.init = await cc.request("initialize", {}, 30_000));
      fields(init, { commands: "array", models: "array", claude_code_version: "string", current_permission_mode: "string", agents: "array|missing", account: "object|null|missing", output_style: "string|missing", available_output_styles: "array|missing" }, "initialize");
      need(init.models.length > 0, "initialize lists no models");
      fields(init.models[0], { value: "string", displayName: "string", supportedEffortLevels: "array|missing", supportsEffort: "boolean|missing", supportsAutoMode: "boolean|missing" }, "initialize.models[0]");
      need(init.commands.length > 0, "initialize lists no commands");
      fields(init.commands[0], { name: "string", description: "string" }, "initialize.commands[0]");
      return `Claude Code ${init.claude_code_version}: ${init.commands.length} commands, ${init.models.length} models`;
    },
  },
  {
    id: "get_settings",
    what: "The model and effort in force, and the settings as Claude Code merged them",
    core: true,
    run: async (cc, seen) => {
      const settings = (seen.settings = await cc.request("get_settings"));
      fields(settings, { effective: "object", applied: "object", "applied.model": "string", "applied.effort": "string|null|missing" }, "get_settings");
      return `model ${settings.applied.model}, effort ${settings.applied.effort ?? "none"}`;
    },
  },
  {
    id: "set_permission_mode",
    what: "Changing the permission mode (Shift+Tab)",
    core: true,
    run: async (cc, seen) => {
      const mode = String(seen.init?.current_permission_mode ?? "default");
      await cc.request("set_permission_mode", { mode });
      return `set to ${mode}, as it was`;
    },
  },
  {
    id: "apply_flag_settings",
    what: "Changing the effort level and ultracode for the session",
    run: async (cc, seen) => {
      const applied = seen.settings?.applied ?? {};
      fields(applied, { ultracode: "boolean|missing", ultracodeAvailable: "boolean|missing" }, "get_settings.applied");
      const effort = applied.effort ?? null;
      await cc.request("apply_flag_settings", { settings: { effortLevel: effort } });
      if (!applied.ultracodeAvailable) return `effort ${effort ?? "auto"} applied; ${"ultracode" in applied ? "this model takes no ultracode" : "this Claude Code has no ultracode"}`;
      // Ultracode with a level in one request: sent apart, the level turns it off.
      await cc.request("apply_flag_settings", { settings: { effortLevel: effort, ultracode: true } });
      const on = (await cc.request("get_settings"))?.applied ?? {};
      await cc.request("apply_flag_settings", { settings: { effortLevel: effort, ultracode: applied.ultracode === true } });
      need(on.ultracode === true, "ultracode did not turn on");
      need((on.effort ?? null) === effort, `turning ultracode on moved the effort from ${effort} to ${on.effort}`);
      return `effort ${effort ?? "auto"} and ultracode both apply`;
    },
  },
  {
    id: "set_max_thinking_tokens",
    what: "Thinking on and off (Alt+K)",
    run: async cc => {
      await cc.request("set_max_thinking_tokens", { max_thinking_tokens: null });
      return "accepted";
    },
  },
  {
    id: "set_model",
    what: "Changing the model (Alt+P)",
    run: async (cc, seen) => {
      const model = String(seen.settings?.applied?.model ?? "");
      need(model, "no model to set back");
      await cc.request("set_model", { model });
      return `set to ${model}, as it was`;
    },
  },
  {
    id: "get_context_usage",
    what: "The context meter and /context",
    run: async cc => {
      const usage = await cc.request("get_context_usage");
      fields(usage, { categories: "array" }, "get_context_usage");
      return `${usage.categories.length} categories`;
    },
  },
  {
    id: "get_usage",
    what: "Session cost and the plan's usage windows (/usage)",
    run: async cc => {
      fields(await cc.request("get_usage"), { session: "object" }, "get_usage");
      return "answered";
    },
  },
  {
    id: "mcp_status",
    what: "The MCP servers and their state (/mcp)",
    run: async cc => {
      const status = await cc.request("mcp_status");
      fields(status, { mcpServers: "array" }, "mcp_status");
      return `${status.mcpServers.length} servers`;
    },
  },
  {
    id: "list_permission_rules",
    what: "The allow and deny rules (/permissions)",
    run: async cc => {
      fields(await cc.request("list_permission_rules"), { state: "object", "state.rules": "array" }, "list_permission_rules");
      return "answered";
    },
  },
  {
    id: "background_tasks",
    what: "The work running behind the conversation",
    run: async cc => {
      need(typeof (await cc.request("background_tasks")) === "object", "no object");
      return "answered";
    },
  },
  {
    id: "ui_panes",
    what: "What plugins draw (the band above the composer, their panes)",
    run: async cc => {
      fields(await cc.request("ui_panes"), { panes: "array" }, "ui_panes");
      return "answered";
    },
  },
  {
    id: "get_sandbox_dialog",
    what: "The sandbox settings (/sandbox)",
    run: async cc => {
      fields(await cc.request("get_sandbox_dialog"), { supported: "boolean" }, "get_sandbox_dialog");
      return "answered";
    },
  },
  {
    id: "get_workspace_diff",
    what: "The uncommitted changes (/diff)",
    run: async cc => {
      const answer = await cc.request("get_workspace_diff");
      need(answer && "diff" in answer, "no `diff` in the answer");
      return answer.diff ? "a diff" : `no diff (${answer.noDiffReason ?? "none"})`;
    },
  },
  {
    id: "interrupt",
    what: "Stopping a turn (Esc)",
    core: true,
    run: async cc => {
      await cc.request("interrupt");
      return "accepted";
    },
  },
  // Requests that act on something a bare session does not have: they only have to be known.
  exists("stop_task", "Stopping a subagent or a background task", { task_id: "claude-tsp-check" }),
  exists("get_task_output", "Reading a background command's output", { task_id: "claude-tsp-check" }),
  exists("cancel_async_message", "Taking back a queued message", { message_uuid: "00000000-0000-4000-8000-000000000000" }),
  exists("rewind_files", "Restoring files when rewinding", { user_message_id: "00000000-0000-4000-8000-000000000000", dry_run: true }),
  exists("mcp_reconnect", "Reconnecting an MCP server", { serverName: "claude-tsp-check" }),
  exists("ui_press", "Pressing a button a plugin drew", { plugin: "claude-tsp-check", handle: 0 }),
  exists("ui_attach", "Attaching to the session as the place plugins draw", { surface: "desktop", client_id: "claude-tsp-check", viewport: { columns: 140, rows: 40, isFullscreen: true } }),
  exists("get_hooks_listing", "The hooks in force (/hooks)", {}),
];

/** The requests the surface uses that a check would set off for real, so they are not asked: a message, a rename, a report. */
export const NOT_ASKED = ["side_question", "rename_session", "submit_feedback", "remote_control", "mcp_toggle", "update_settings", "set_cwd", "list_cloud_sessions"];

export interface Report {
  /** Claude Code's version, as the session said it. */
  version: string;
  results: CheckResult[];
}

/** Runs every check against a live session. One that fails does not stop the rest. */
export async function runChecks(cc: Requester): Promise<Report> {
  const seen: Json = {};
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    try {
      results.push({ id: check.id, what: check.what, core: check.core === true, ok: true, detail: await check.run(cc, seen) });
    } catch (error) {
      // No session at all is not a finding about the protocol: there is nothing to report on.
      if (check.id === "initialize" && !seen.init) throw new Error(`the session did not open (${String((error as Error).message || error).split("\n")[0]})`);
      results.push({ id: check.id, what: check.what, core: check.core === true, ok: false, detail: String((error as Error).message || error).split("\n")[0]!.slice(0, 240) });
    }
  }
  return { version: String(seen.init?.claude_code_version ?? ""), results };
}

/**
 * Starts a Claude Code session of its own for the checks and ends it. The
 * session gets a folder and a config directory of its own under `dir`, so it
 * reads none of the user's settings and leaves nothing among their sessions.
 */
export async function checkBinary(bin: string, dir: string, extra: string[] = []): Promise<Report> {
  const cwd = join(dir, "work");
  const config = join(dir, "config");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(config, { recursive: true });
  const cc = new Claude({ bin, args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...extra], cwd, env: { CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } });
  let failed: Error | null = null;
  cc.on("error", (error: Error) => (failed = error));
  try {
    const report = await runChecks(cc);
    if (failed && !report.results.some(result => result.ok)) throw failed;
    return report;
  } finally {
    await cc.stop().catch(() => undefined);
  }
}

export const failures = (report: Report): CheckResult[] => report.results.filter(result => !result.ok);

/** The report in plain lines, for a shell and for an issue. */
export function formatReport(report: Report, range: Supported = supported(), surface = ""): string {
  const failed = failures(report);
  const where = standing(report.version, range);
  const lines = [
    `Claude Code ${report.version || "unknown"}${surface ? `, claude-tsp ${surface}` : ""}`,
    where === "older" ? `Older than the oldest supported (${range.minimum}).` : where === "newer" ? `Newer than the release was checked with (${range.tested}).` : where === "tested" ? `Within what the release was checked with (${range.minimum} to ${range.tested}).` : "",
    "",
    ...report.results.map(result => `${result.ok ? "ok  " : "FAIL"}  ${result.id.padEnd(24)} ${result.ok ? result.detail : `${result.what}: ${result.detail}`}`),
    "",
    failed.length ? `${failed.length} of ${report.results.length} checks failed${failed.some(result => result.core) ? " (the surface cannot work without the core ones)" : " (each costs one feature; the rest works)"}.` : `All ${report.results.length} checks passed.`,
  ];
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

/**
 * `claude-tsp --check-compat [--json] [--bin <claude>]`: the checks from a
 * shell. Exits 0 when all pass, 1 when some fail, 2 when Claude Code could
 * not be started.
 */
export async function compatCli(args: readonly string[], bin: string, surface: string, out: (text: string) => void = text => void process.stdout.write(text)): Promise<number> {
  const at = args.indexOf("--bin");
  const target = at >= 0 && args[at + 1] ? args[at + 1]! : bin;
  const range = supported();
  const cwd = mkdtempSync(join(tmpdir(), "claude-tsp-check-"));
  try {
    const report = await checkBinary(target, cwd);
    const failed = failures(report);
    if (args.includes("--json")) out(`${JSON.stringify({ claudeCode: report.version, claudeTsp: surface, supported: range, standing: standing(report.version, range), passed: report.results.length - failed.length, failed: failed.length, coreFailed: failed.filter(result => result.core).length, notAsked: NOT_ASKED, results: report.results }, null, 2)}\n`);
    else out(`${formatReport(report, range, surface)}\n`);
    return failed.length ? 1 : 0;
  } catch (error) {
    const message = `Claude Code could not be started for the check (${target}): ${(error as Error).message}`;
    if (args.includes("--json")) out(`${JSON.stringify({ error: message })}\n`);
    else out(`${message}\n`);
    return 2;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
