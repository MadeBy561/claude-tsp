/**
 * `/stats`: what the stored sessions add up to. Claude Code counts these in
 * its terminal UI only, so they are counted here from the same session files:
 * sessions, prompts, tokens per model, the days worked and the streaks.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Stats {
  sessions: number;
  prompts: number;
  replies: number;
  toolCalls: number;
  /** Tokens by model id. */
  models: Map<string, ModelTotals>;
  /** Messages (prompts and replies) by local day, `YYYY-MM-DD`. */
  days: Map<string, number>;
  /** Replies by hour of the local day. */
  hours: number[];
  firstDay: string;
  longest: { messages: number; minutes: number };
  currentStreak: number;
  longestStreak: number;
  /** Session files left out because the scan ran out of time. */
  skipped: number;
}

const day = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function emptyStats(): Stats {
  return { sessions: 0, prompts: 0, replies: 0, toolCalls: 0, models: new Map(), days: new Map(), hours: new Array<number>(24).fill(0), firstDay: "", longest: { messages: 0, minutes: 0 }, currentStreak: 0, longestStreak: 0, skipped: 0 };
}

/** Adds one session's entries to the totals. */
export function addSession(stats: Stats, entries: Iterable<Record<string, any>>): void {
  let messages = 0;
  let first = 0;
  let last = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || entry.isSidechain) continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (entry.type === "user") {
      const content = entry.message?.content;
      // Tool results travel as user entries; only what a person typed is a prompt.
      const typed = typeof content === "string" ? !entry.isMeta : Array.isArray(content) && !entry.isMeta && content.some((part: any) => part?.type === "text") && !content.some((part: any) => part?.type === "tool_result");
      if (!typed) continue;
      stats.prompts += 1;
    } else if (entry.type === "assistant") {
      const message = entry.message ?? {};
      // A reply is stored once per content block; its usage counts once.
      const id = String(message.id ?? entry.uuid ?? "");
      for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "tool_use") stats.toolCalls += 1;
      if (id && seen.has(id)) continue;
      seen.add(id);
      stats.replies += 1;
      const usage = message.usage;
      const model = String(message.model ?? "");
      if (usage && model && model !== "<synthetic>") {
        const totals = stats.models.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        totals.input += Number(usage.input_tokens) || 0;
        totals.output += Number(usage.output_tokens) || 0;
        totals.cacheRead += Number(usage.cache_read_input_tokens) || 0;
        totals.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
        stats.models.set(model, totals);
      }
      if (Number.isFinite(at)) stats.hours[new Date(at).getHours()]! += 1;
    } else continue;
    messages += 1;
    if (Number.isFinite(at)) {
      first ||= at;
      last = at;
      const key = day(new Date(at));
      stats.days.set(key, (stats.days.get(key) ?? 0) + 1);
    }
  }
  if (!messages) return;
  stats.sessions += 1;
  if (messages > stats.longest.messages) stats.longest = { messages, minutes: Math.round(Math.max(0, last - first) / 60_000) };
}

/** Works out the first day and the streaks once every session is in. */
export function finish(stats: Stats, today = new Date()): Stats {
  const days = [...stats.days.keys()].sort();
  stats.firstDay = days[0] ?? "";
  let run = 0;
  let previous = 0;
  for (const key of days) {
    const at = Date.parse(`${key}T12:00:00`);
    run = previous && Math.round((at - previous) / 86_400_000) === 1 ? run + 1 : 1;
    previous = at;
    if (run > stats.longestStreak) stats.longestStreak = run;
  }
  // The streak that is still alive: it reaches today, or yesterday when today has no work yet.
  const cursor = new Date(today);
  if (!stats.days.has(day(cursor))) cursor.setDate(cursor.getDate() - 1);
  stats.currentStreak = 0;
  while (stats.days.has(day(cursor))) {
    stats.currentStreak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return stats;
}

async function readSession(path: string): Promise<Record<string, any>[]> {
  const entries: Record<string, any>[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Only the lines that count are parsed: the rest (attachments, snapshots) can be large.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    try {
      const entry = JSON.parse(line);
      // What is kept is small: the fields the count reads.
      entries.push({ type: entry.type, isSidechain: entry.isSidechain, isMeta: entry.isMeta, timestamp: entry.timestamp, uuid: entry.uuid, message: entry.type === "assistant" ? { id: entry.message?.id, model: entry.message?.model, usage: entry.message?.usage, content: (entry.message?.content ?? []).filter?.((part: any) => part?.type === "tool_use").map(() => ({ type: "tool_use" })) } : { content: typeof entry.message?.content === "string" ? "x" : (entry.message?.content ?? []).map?.((part: any) => ({ type: part?.type })) } });
    } catch {
      // A line cut short by a crash.
    }
  }
  return entries;
}

/** Counts every session under `<config>/projects`, newest first, for at most `budgetMs`. */
export async function collectStats(configDir: string, budgetMs = 20_000, progress?: (done: number, total: number) => void): Promise<Stats> {
  const stats = emptyStats();
  const files: { path: string; mtime: number }[] = [];
  const root = join(configDir, "projects");
  let projects: string[] = [];
  try {
    projects = readdirSync(root);
  } catch {
    return finish(stats);
  }
  for (const project of projects) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        files.push({ path: join(root, project, name), mtime: statSync(join(root, project, name)).mtimeMs });
      } catch {
        // Removed meanwhile.
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const started = Date.now();
  let done = 0;
  for (const file of files) {
    if (Date.now() - started > budgetMs) {
      stats.skipped = files.length - done;
      break;
    }
    try {
      addSession(stats, await readSession(file.path));
    } catch {
      // Unreadable: left out.
    }
    done += 1;
    if (done % 25 === 0) progress?.(done, files.length);
  }
  return finish(stats);
}
