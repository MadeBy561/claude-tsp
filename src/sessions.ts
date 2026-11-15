/**
 * Claude Code's stored sessions, for the resume picker and for redrawing a
 * conversation that is resumed.
 *
 * A session is one JSONL under `<config>/projects/<project-slug>/`. Listing
 * reads only the start and the end of each file, so a project with hundreds
 * of megabytes of transcripts still lists at once.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir } from "./paths.js";

export interface SessionRow {
  id: string;
  path: string;
  title: string;
  name: string;
  cwd: string;
  preview: string;
  previewMessages: { role: string; text: string }[];
  when: string;
  mtime: number;
  size: string;
  branch: string;
}

const EDGE = 96 * 1024;

function parseLines(text: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, any>);
    } catch {
      /* a line cut by the window */
    }
  }
  return out;
}

/** Every entry of a transcript file. */
export function readEntries(path: string): Record<string, any>[] {
  return parseLines(readFileSync(path, "utf8"));
}

/** The entries at the start and at the end of a file, without reading the middle. */
function readEdges(path: string, size: number): { head: Record<string, any>[]; tail: Record<string, any>[] } {
  if (size <= EDGE * 2) {
    const all = readEntries(path);
    return { head: all, tail: all };
  }
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(EDGE);
    const tail = Buffer.alloc(EDGE);
    readSync(fd, head, 0, EDGE, 0);
    readSync(fd, tail, 0, EDGE, size - EDGE);
    const headText = head.toString("utf8");
    const tailText = tail.toString("utf8");
    return { head: parseLines(headText.slice(0, headText.lastIndexOf("\n"))), tail: parseLines(tailText.slice(tailText.indexOf("\n") + 1)) };
  } finally {
    closeSync(fd);
  }
}

const flat = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

function promptText(entry: Record<string, any>): string {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return "";
  const content = entry.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join(" ") : "";
  if (!text || /^<(local-command|system-reminder|task-notification|bash-std)/.test(text.trim()) || text.trim().startsWith("Another Claude session sent a message:")) return "";
  const command = text.match(/<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/);
  if (command) return `/${command[1]!.replace(/^\//, "")}`;
  return text;
}

function answerText(entry: Record<string, any>): string {
  if (entry.type !== "assistant" || entry.isSidechain) return "";
  const content = entry.message?.content;
  return Array.isArray(content) ? content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join(" ") : "";
}

export function relative(at: number): string {
  if (!Number.isFinite(at)) return "";
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function describe(path: string, size: number, mtime: number): SessionRow | null {
  let edges;
  try {
    edges = readEdges(path, size);
  } catch {
    return null;
  }
  let title = "";
  let command = "";
  let name = "";
  let cwd = "";
  let branch = "";
  for (const entry of edges.head) {
    cwd ||= typeof entry.cwd === "string" ? entry.cwd : "";
    // A session is named for the first thing asked, not for a command typed before it.
    const prompt = flat(promptText(entry), 110);
    if (prompt && !title && !prompt.startsWith("/")) title = prompt;
    command ||= prompt;
    if (title && cwd) break;
  }
  const recent: { role: string; text: string }[] = [];
  let lastPrompt = "";
  for (const entry of edges.tail) {
    if (entry.type === "custom-title" && entry.customTitle) name = String(entry.customTitle);
    else if (entry.type === "ai-title" && entry.aiTitle && !name) name = String(entry.aiTitle);
    else if (entry.type === "last-prompt" && entry.lastPrompt) lastPrompt = String(entry.lastPrompt);
    if (typeof entry.gitBranch === "string" && entry.gitBranch) branch = entry.gitBranch;
    cwd ||= typeof entry.cwd === "string" ? entry.cwd : "";
    const text = promptText(entry) || answerText(entry);
    if (text) {
      // A preview is one flowing line: heading marks, table rules and fences would only be noise in it.
      const plain = text
        .replace(/^```.*$/gm, "")
        .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, "")
        .replace(/[ \t]*\|[ \t]*/g, " · ")
        .replace(/\*\*|__|`/g, "");
      recent.push({ role: entry.type, text: flat(plain, 500) });
      if (recent.length > 8) recent.shift();
    }
  }
  for (const entry of edges.head) {
    if (entry.type === "custom-title" && entry.customTitle && !name) name = String(entry.customTitle);
    else if (entry.type === "ai-title" && entry.aiTitle && !name) name = String(entry.aiTitle);
  }
  title ||= flat(lastPrompt, 110).startsWith("/") ? "" : flat(lastPrompt, 110);
  title ||= command;
  // A file with no prompt in it is bookkeeping, not a conversation to resume.
  if (!title && !recent.length) return null;
  return { id: basename(path).replace(/\.jsonl$/, ""), path, title, name, cwd, preview: recent.at(-1)?.text.slice(0, 240) ?? "", previewMessages: recent, when: relative(mtime), mtime, size: bytes(size), branch };
}

/** The most recent sessions of every project, this folder's first. */
export function listSessions(cwd: string, limit = 300): SessionRow[] {
  const root = join(configDir(), "projects");
  const files: { path: string; size: number; mtime: number }[] = [];
  let projects: string[] = [];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const project of projects) {
    let names: string[];
    try {
      names = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
      const path = join(root, project, name);
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.size > 0) files.push({ path, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        /* removed meanwhile */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const rows: SessionRow[] = [];
  for (const file of files.slice(0, limit * 2)) {
    const row = describe(file.path, file.size, file.mtime);
    if (row) rows.push(row);
    if (rows.length >= limit) break;
  }
  return [...rows.filter(row => row.cwd === cwd), ...rows.filter(row => row.cwd !== cwd)];
}

/** The newest session of a folder: what `--continue` resumes. */
export function latestSession(cwd: string): SessionRow | null {
  return listSessions(cwd, 50).find(row => row.cwd === cwd) ?? null;
}
