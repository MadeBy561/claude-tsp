/**
 * Claude Code's settings files, for the edits its terminal UI makes in
 * `/permissions`: adding and removing a rule. The files are JSON; everything
 * else in them is kept as it was.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Scope = "userSettings" | "projectSettings" | "localSettings";
export type Behavior = "allow" | "ask" | "deny";

export const SCOPES: Record<Scope, string> = { userSettings: "User settings (every project)", projectSettings: "Project settings (shared, .claude/settings.json)", localSettings: "Local settings (this project, only you)" };

/** The file of a scope. */
export function settingsPath(scope: Scope, configDir: string, cwd: string): string {
  return scope === "userSettings" ? join(configDir, "settings.json") : join(cwd, ".claude", scope === "projectSettings" ? "settings.json" : "settings.local.json");
}

function read(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a settings object`);
  return parsed as Record<string, any>;
}

/** Adds a rule to a settings file. Returns false when it was already there. */
export function addRule(path: string, behavior: Behavior, rule: string): boolean {
  const settings = read(path);
  const permissions = (settings.permissions ??= {}) as Record<string, any>;
  const list: string[] = Array.isArray(permissions[behavior]) ? permissions[behavior] : [];
  if (list.includes(rule)) return false;
  permissions[behavior] = [...list, rule];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** Removes a rule from a settings file. Returns false when it was not there. */
export function removeRule(path: string, behavior: Behavior, rule: string): boolean {
  const settings = read(path);
  const list: unknown = settings.permissions?.[behavior];
  if (!Array.isArray(list) || !list.includes(rule)) return false;
  settings.permissions[behavior] = list.filter(entry => entry !== rule);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** Whether a rule reads as one: `Tool`, `Tool(pattern)` or an MCP tool name. */
export function validRule(rule: string): boolean {
  return /^[A-Za-z_][\w-]*(\(.+\))?$/.test(rule.trim());
}

/** Sets and removes `env` entries of a settings file (a value of null removes one). Returns the keys that changed. */
export function setEnv(path: string, env: Record<string, string | null>): string[] {
  const settings = read(path);
  const current = (settings.env && typeof settings.env === "object" ? settings.env : {}) as Record<string, string>;
  const changed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === null || value === "") {
      if (key in current) {
        delete current[key];
        changed.push(key);
      }
    } else if (current[key] !== value) {
      current[key] = value;
      changed.push(key);
    }
  }
  if (!changed.length) return changed;
  settings.env = current;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return changed;
}

/** The `env` block of a settings file. */
export function readEnv(path: string): Record<string, string> {
  try {
    const env = read(path).env;
    return env && typeof env === "object" ? (env as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Sets one top-level key of a settings file; `undefined` takes it out. Returns whether the file changed. */
export function setKey(path: string, key: string, value: unknown): boolean {
  const settings = read(path);
  if (value === undefined) {
    if (!(key in settings)) return false;
    delete settings[key];
  } else {
    if (JSON.stringify(settings[key]) === JSON.stringify(value)) return false;
    settings[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** One top-level key of a settings file, or undefined. */
export function getKey(path: string, key: string): unknown {
  try {
    return read(path)[key];
  } catch {
    return undefined;
  }
}

/**
 * The settings of Claude Code's own `/config` screen that mean something in
 * this surface, with the key each writes in the user's settings file and its
 * default. Read from Claude Code 2.1.322 by changing each one in its screen.
 */
export const CLAUDE_SETTINGS: { key: string; label: string; hint: string; default: boolean }[] = [
  { key: "idleCompaction", label: "Idle compaction", hint: "Summarize a long conversation while it sits idle", default: true },
  { key: "autoContinueAtUsageLimit", label: "Continue automatically at usage limit", hint: "Pick the turn back up when a usage window resets", default: true },
  { key: "awaySummaryEnabled", label: "Session recap", hint: "A short recap when you come back to a session", default: true },
  { key: "fileCheckpointingEnabled", label: "Rewind code (checkpoints)", hint: "Keep file checkpoints so /rewind can restore code", default: true },
  { key: "enableWorkflows", label: "Dynamic workflows", hint: "Let Claude run multi-agent workflows", default: true },
  { key: "workflowKeywordTriggerEnabled", label: "Ultracode keyword trigger", hint: "Start a workflow when a prompt says ultracode", default: true },
  { key: "useAutoModeDuringPlan", label: "Use auto mode during plan", hint: "Plan mode decides tool calls as auto mode does, where auto mode is available", default: true },
  { key: "showTurnDuration", label: "Show turn duration", hint: "Claude Code's own turn-time line in its terminal UI", default: true },
  { key: "verbose", label: "Verbose output", hint: "Full tool output in Claude Code's terminal UI", default: false },
];

/** Settings of Claude Code's `/config` with a list of values, kept under a nested key of the user's settings file. */
export const CLAUDE_CHOICES: { id: string; path: [string, string]; label: string; hint: string; default: string; options: { value: string; label: string }[] }[] = [
  {
    id: "defaultMode",
    path: ["permissions", "defaultMode"],
    label: "Default permission mode",
    hint: "The mode new sessions start in",
    default: "default",
    options: [
      { value: "default", label: "Ask" },
      { value: "acceptEdits", label: "Accept edits" },
      { value: "plan", label: "Plan" },
      { value: "auto", label: "Auto" },
      { value: "dontAsk", label: "Don't ask" },
    ],
  },
  {
    id: "worktreeBaseRef",
    path: ["worktree", "baseRef"],
    label: "Worktree base ref",
    hint: "What a new worktree starts from: a fresh copy of the default branch, or the current HEAD",
    default: "fresh",
    options: [
      { value: "fresh", label: "fresh" },
      { value: "head", label: "head" },
    ],
  },
];

/** A nested key of a settings file (`permissions.defaultMode`), or undefined. */
export function getNested(path: string, [outer, inner]: [string, string]): unknown {
  const value = getKey(path, outer);
  return value && typeof value === "object" ? (value as Record<string, unknown>)[inner] : undefined;
}

/** Sets a nested key of a settings file, keeping its siblings. */
export function setNested(path: string, [outer, inner]: [string, string], value: unknown): boolean {
  const current = getKey(path, outer);
  const block = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  if (JSON.stringify(block[inner]) === JSON.stringify(value)) return false;
  block[inner] = value;
  return setKey(path, outer, block);
}
