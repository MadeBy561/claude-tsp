/**
 * Shell tracing: which lines of a bash command ran, in what order and when,
 * so the command pane can show the run step by step and replay it.
 *
 * The command is given a one-line prelude that turns on bash's own tracing
 * into a private file; its output and exit status are untouched, and shells
 * other than bash 5 skip the prelude. Only line numbers and times are kept:
 * the trace's text holds expanded variables, so it is read for its numbers
 * and deleted.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellTrace } from "./shell.js";

const MAX_STEPS = 2000;
const MARK = "__ctsp";

let dir = "";
let count = 0;

/** A new private file for one command's trace. */
export function traceFile(): string {
  // A directory only this user can read: the raw trace holds expanded values until it is parsed.
  dir ||= mkdtempSync(join(tmpdir(), "claude-tsp-trace-"));
  return join(dir, String(++count));
}

/** `command` with the prelude that traces it into `file`. */
export function traced(command: string, file: string): string {
  return `if [ "\${BASH_VERSINFO:-0}" -ge 5 ]; then eval 'exec {${MARK}}>${file}' && BASH_XTRACEFD=$${MARK} && PS4=$'+\\t\${EPOCHREALTIME}\\t\${LINENO}\\t' && set -x; fi 2>/dev/null\n${command}`;
}

/** The command as it was before `traced` (for showing it to the user). */
export function untraced(command: string): string {
  return command.startsWith('if [ "${BASH_VERSINFO:-0}" -ge 5 ]; then eval \'exec {' + MARK) ? command.slice(command.indexOf("\n") + 1) : command;
}

/** Whether a command turns on, redirects or formats bash's tracing on its own. */
export function usesTracing(command: string): boolean {
  return /\bset\s+[-+][a-wyzA-Z]*x|\bset\s+[-+]o\s+xtrace|BASH_XTRACEFD|\bPS4=/.test(command);
}

/** The steps of an xtrace text written with PS4 `+<tab>seconds<tab>line<tab>`. */
export function parseTrace(text: string): ShellTrace | null {
  const steps: ShellTrace["steps"] = [];
  let origin = 0;
  let total = 0;
  for (const row of text.split("\n")) {
    const match = row.match(/^(\++)\t(\d+\.\d+)\t(\d+)\t/);
    if (!match) continue;
    // Line 1 of what bash ran is the prelude; the script starts on line 2.
    const line = Number(match[3]) - 1;
    if (line < 1) continue;
    total += 1;
    const seconds = Number(match[2]);
    origin ||= seconds;
    if (steps.length < MAX_STEPS) steps.push({ line, at: Math.round((seconds - origin) * 1e6) / 1e3, depth: match[1]!.length });
  }
  if (!steps.length) return null;
  return { steps, ...(total > steps.length ? { trimmed: true } : {}) };
}

/** Reads a trace file for its steps and deletes it. */
export function takeTrace(file: string): ShellTrace | null {
  try {
    return parseTrace(readFileSync(file, "utf8"));
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

/** Removes what is left of the traces when the session ends. */
export function dropTraces(): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
}
