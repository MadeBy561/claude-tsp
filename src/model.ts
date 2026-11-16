/**
 * The conversation model: Claude Code's stream-json records (and the entries
 * of a stored transcript) folded into an ordered list of renderable items.
 * Nothing here knows about Tern.
 */
import { randomUUID } from "node:crypto";

export type ToolStatus = "pending" | "running" | "done" | "error" | "cancelled";
export type AgentStatus = "pending" | "running" | "done" | "failed" | "aborted";

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "active" | "done" | "dropped" | "blocked";
  note?: string;
}

export interface TodoPhase {
  id: string;
  name: string;
  items: TodoItem[];
}

export interface TurnUsage {
  ms: number;
  input: number;
  output: number;
  total: number;
  cost: number;
}

export interface Image {
  data: string;
  mimeType: string;
}

/** One renderable transcript row. Fields beyond `kind`/`id` depend on the kind. */
export interface Item {
  kind: "user" | "assistant" | "thinking" | "tool" | "agent" | "compaction" | "branch" | "custom" | "bash" | "notice" | "error" | "usage" | "reminder";
  id: string;
  /** Bumped on every change, so a renderer can keep what it built. */
  v: number;
  at: number;
  text: string;
  key?: string;
  /** The record's uuid in Claude's transcript: what rewind and fork address. */
  uuid?: string;
  /** The assistant message this block belongs to. */
  msg?: number;
  status?: string;
  endedAt?: number;
  tookMs?: number;
  // user
  images?: Image[];
  confirmed?: boolean;
  // assistant
  turn?: TurnUsage;
  model?: string;
  // tool / agent
  toolCallId?: string;
  name?: string;
  args?: Record<string, any>;
  rawArgs?: string;
  output?: string;
  /** Claude's structured result of the call (`tool_use_result`). */
  details?: Record<string, any>;
  isError?: boolean;
  startedAt?: number;
  durationMs?: number;
  resultImages?: Image[];
  /** A permission request is open for this call. */
  awaiting?: boolean;
  // agent
  agentType?: string;
  agentStatus?: AgentStatus;
  stats?: { tools?: number; tokens?: number; took?: number };
  activity?: string;
  taskId?: string;
  background?: boolean;
  error?: string;
  /** The subagent's own conversation, filled live from its forwarded messages. */
  sub?: Conversation;
  // summaries / custom / execution / notices
  tokensBefore?: number;
  tokensAfter?: number;
  customType?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  tone?: "muted" | "warning" | "error" | "info";
  /** The todos still open when a run ended (kind `reminder`). */
  open?: TodoPhase[];
  /** A message's token usage (kind `usage`). */
  usage?: { input: number; output: number; cacheRead: number; ms: number; ttftMs: number; /** Everything the request sent: new, cached and newly cached input. */ prompt: number };
  excluded?: boolean;
}

export interface RetryState {
  attempt: number;
  max: number;
  delayMs: number;
  at: number;
  error: string;
}

/** A message sent while Claude works, waiting to be taken. */
export interface Queued {
  uuid: string;
  text: string;
  images: Image[];
  /** `next`: at the next step of this turn. `later`: after the turn. `now`: the turn is interrupted for it. */
  priority: "now" | "next" | "later";
}

/** Work running behind the conversation that is not a subagent card: a shell, a monitor, a workflow. */
export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
  startedAt: number;
  toolUseId?: string;
}

export interface RateWindow {
  utilization: number;
  resetsAt: number;
  status?: string;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(block => block && block.type === "text")
    .map(block => block.text || "")
    .join("");
}

/** Text of a tool result; images are left to `imagesOf`. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => (typeof block === "string" ? block : block?.type === "text" ? block.text || "" : ""))
    .filter(Boolean)
    .join("\n");
}

/** The images among content blocks, as `{data, mimeType}`. */
export function imagesOf(content: unknown): Image[] {
  if (!Array.isArray(content)) return [];
  const out: Image[] = [];
  for (const block of content) {
    if (block?.type !== "image") continue;
    const source = block.source ?? {};
    if (source.type === "base64" && source.data) out.push({ data: String(source.data), mimeType: String(source.media_type || "image/png") });
  }
  return out;
}

/**
 * The object a JSON text streamed so far describes: the text is closed where
 * it stops (an open string, then every open bracket) and parsed. Arguments
 * arrive as such a prefix while a tool call streams.
 */
export function partialJson(text: string): Record<string, any> | null {
  if (!text.trimStart().startsWith("{")) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let body = text;
  if (inString) body += escaped ? '\\"' : '"';
  for (let cut = 0; cut < 3; cut += 1) {
    try {
      const value: unknown = JSON.parse(body + stack.slice().reverse().join(""));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
    } catch {
      // A dangling key, colon or comma: drop back to the last complete member.
      const at = Math.max(body.lastIndexOf(","), body.lastIndexOf("{"));
      if (at < 0) return null;
      body = body[at] === "{" ? body.slice(0, at + 1) : body.slice(0, at);
    }
  }
  return null;
}

/** A model id as people read it: `claude-opus-5-5` → `Opus 5.5`, a `[1m]` suffix dropped. */
export function modelLabel(model: unknown): string {
  if (!model) return "";
  const id = String(model).replace(/\[1m\]$/, "");
  const match = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (!match) return id;
  const [, family = "", major = "", minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

const AGENT_TOOL_NAMES = new Set(["agent", "task"]);

export function isAgentTool(name: unknown): boolean {
  return AGENT_TOOL_NAMES.has(String(name || "").toLowerCase());
}

const TASK_STATUS: Record<string, TodoItem["status"]> = { completed: "done", in_progress: "active", pending: "pending", deleted: "dropped", cancelled: "dropped" };

const AGENT_STATUS: Record<string, AgentStatus> = { pending: "pending", running: "running", paused: "running", completed: "done", failed: "failed", killed: "aborted", stopped: "aborted" };

interface Stream {
  seq: number;
  startedAt: number;
  firstTokenAt: number;
  blocks: Map<number, Item>;
  /** Text and thinking items not yet matched by a whole `assistant` record. */
  open: Item[];
  usage: Record<string, number>;
  counted: boolean;
}

/** Text Claude Code wraps a local command's output in. */
const LOCAL_STDOUT = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;
const LOCAL_STDERR = /^<local-command-stderr>([\s\S]*?)<\/local-command-stderr>\s*$/;
/** The summary of a branch that was left, as the surface gives it to Claude. */
const BRANCH_SUMMARY = /^<branch-summary>\n?([\s\S]*?)\n?<\/branch-summary>\s*$/;

/** The message that carries a branch summary into the conversation. */
export function branchSummaryMessage(summary: string): string {
  return `<branch-summary>\n${summary.trim()}\n</branch-summary>`;
}

/** How a typed slash command is stored in a transcript. */
const COMMAND_NAME = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
/** A `!command` and its output, as Claude Code records them for the model. */
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/;
const BASH_STDOUT = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/;
const BASH_STDERR = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/;

export class Conversation {
  items: Item[] = [];
  busy = false;
  compacting = false;
  model = "";
  permissionMode = "default";
  effort = "";
  sessionId = "";
  sessionName = "";
  cost = 0;
  contextTokens = 0;
  contextWindow = 0;
  tokPerSec = 0;
  retry: RetryState | null = null;
  todos: TodoPhase[] | null = null;
  queue: Queued[] = [];
  background = new Map<string, BackgroundTask>();
  /** Status texts plugins set (`$.ui.status`), by plugin. */
  statuses = new Map<string, string>();
  /** The account's usage windows, by name (`five_hour`, `seven_day`). */
  rateWindows = new Map<string, RateWindow>();
  /** The prompt Claude predicts next, offered as the composer's placeholder. */
  suggestion = "";
  /** The `/goal` condition in force. */
  goal = "";
  /** The `!command` running now. */
  shell: Item | null = null;
  /** The hook running now (`PreToolUse: lint.sh`). */
  hook = "";
  /** Estimated tokens of the thinking in progress. */
  thinkingTokens = 0;
  /** Bumped on every change. */
  changed = 0;
  runStartedAt = 0;
  /** Called for a notice that should not stay in the transcript. */
  onToast: ((text: string, tone: "info" | "warning" | "error") => void) | null = null;

  readonly root: Conversation;
  #seq = 0;
  #msgSeq = 0;
  #prefix: string;
  /** True while a stored transcript is replayed: wall-clock durations mean nothing then. */
  #restoring = false;
  #byKey = new Map<string, Item>();
  #byToolCall = new Map<string, Item>();
  /** Agent cards by the id of the tool call that started them, across every nesting level (root only). */
  #agents = new Map<string, Item>();
  #byTask = new Map<string, Item>();
  #streams = new Map<string, Stream>();
  #lastModel = "";
  #run = { input: 0, output: 0, total: 0, costAtStart: 0 };
  #tasks = new Map<string, TodoItem>();
  #silent = new Set<string>();

  constructor(root?: Conversation, prefix = "") {
    this.root = root ?? this;
    this.#prefix = prefix;
  }

  touch(): void {
    this.changed += 1;
    if (this.root !== this) this.root.changed += 1;
  }

  bump(item: Item): void {
    item.v += 1;
    this.touch();
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${this.#prefix}${prefix}${this.#seq}`;
  }

  add(fields: Partial<Item> & Pick<Item, "kind">, prefix: string): Item {
    const item: Item = { id: this.#id(prefix), v: 0, at: Date.now(), text: "", ...fields };
    this.items.push(item);
    if (item.key) this.#byKey.set(item.key, item);
    if (item.toolCallId) this.#byToolCall.set(item.toolCallId, item);
    this.touch();
    return item;
  }

  remove(item: Item): void {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
    if (item.key) this.#byKey.delete(item.key);
    this.touch();
  }

  findTool(toolCallId: string | undefined): Item | undefined {
    if (!toolCallId) return undefined;
    return this.#byToolCall.get(toolCallId) ?? this.root.#agents.get(toolCallId);
  }

  /** The tool call of `toolCallId` at any nesting level. */
  findToolDeep(toolCallId: string | undefined): Item | undefined {
    if (!toolCallId) return undefined;
    const own = this.#byToolCall.get(toolCallId);
    if (own) return own;
    for (const agent of this.root.#agents.values()) {
      const found = agent.sub ? agent.sub.#byToolCall.get(toolCallId) : undefined;
      if (found) return found;
    }
    return undefined;
  }

  agents(): Item[] {
    return this.items.filter(item => item.kind === "agent");
  }

  /** The text of the last assistant block with any. */
  lastAnswer(): string {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index]!;
      if (item.kind === "assistant" && item.text.trim()) return item.text;
    }
    return "";
  }

  /** Every assistant block of the run that ends at `item`. */
  answerOf(item: Item): string {
    const index = this.items.indexOf(item);
    const parts: string[] = [];
    for (let at = index; at >= 0; at -= 1) {
      const row = this.items[at]!;
      if (row.kind === "user") break;
      if (row.kind === "assistant" && row.text.trim()) parts.unshift(row.text);
    }
    return parts.join("\n\n");
  }

  /** The local echo of a prompt, confirmed when Claude replays it. */
  addUser(text: string, images: Image[] = [], uuid: string = randomUUID()): Item {
    return this.add({ kind: "user", text, images, confirmed: false, uuid }, "u");
  }

  /** A message sent while Claude works: shown in the queue until it is taken. */
  enqueue(text: string, images: Image[], priority: Queued["priority"]): Queued {
    const queued: Queued = { uuid: randomUUID(), text, images, priority };
    this.queue.push(queued);
    this.touch();
    return queued;
  }

  /** A message sent for its effect only (a slash command): its replay is not drawn. */
  silence(uuid: string): void {
    this.#silent.add(uuid);
  }

  /** Empties the conversation (`/clear`, a new session). */
  reset(): void {
    this.items = [];
    this.#byKey.clear();
    this.#byToolCall.clear();
    this.#agents.clear();
    this.#byTask.clear();
    this.#streams.clear();
    this.#tasks.clear();
    this.#msgSeq = 0;
    this.#lastModel = "";
    this.todos = null;
    this.retry = null;
    this.shell = null;
    this.queue = [];
    this.background.clear();
    this.suggestion = "";
    this.cost = 0;
    this.contextTokens = 0;
    this.busy = false;
    this.compacting = false;
    this.runStartedAt = 0;
    this.sessionName = "";
    this.touch();
  }

  // ───────────────────────────────────────────────────────────── records

  /** Folds one record of the stream in. */
  onMessage(record: Record<string, any>): void {
    const parent = record.parent_tool_use_id;
    if (parent && (record.type === "assistant" || record.type === "user" || record.type === "stream_event" || record.type === "tool_progress")) {
      const agent = this.root.#agents.get(String(parent));
      if (agent?.sub && agent.sub !== this) {
        agent.sub.onMessage({ ...record, parent_tool_use_id: null });
        this.#bumpAgent(agent);
        return;
      }
    }
    switch (record.type) {
      case "stream_event":
        this.#onStream(record.event ?? {});
        break;
      case "assistant":
        this.#onAssistant(record);
        break;
      case "user":
        this.#onUser(record);
        break;
      case "result":
        this.#onResult(record);
        break;
      case "system":
        this.#onSystem(record);
        break;
      case "tool_progress": {
        const item = this.findTool(record.tool_use_id);
        if (item && (item.status === "pending" || item.status === "running")) {
          item.status = "running";
          item.startedAt = Date.now() - Math.round(Number(record.elapsed_time_seconds || 0) * 1000);
          this.bump(item);
        }
        break;
      }
      case "rate_limit_event": {
        const info = record.rate_limit_info ?? {};
        for (const [name, window] of Object.entries<any>(info.unifiedWindows ?? {})) {
          if (window && typeof window.utilization === "number") this.rateWindows.set(name, { utilization: window.utilization, resetsAt: Number(window.resetsAt) || 0, status: window.status });
        }
        if (info.status && info.status !== "allowed" && info.status !== "allowed_warning") this.onToast?.(`Usage limit: ${String(info.status).replace(/_/g, " ")}`, "warning");
        this.touch();
        break;
      }
      case "command_lifecycle": {
        // A queued message of ours was taken (or dropped): it leaves the queue for the transcript.
        const at = this.queue.findIndex(entry => entry.uuid === record.command_uuid);
        if (at < 0) break;
        const [entry] = this.queue.splice(at, 1);
        if (record.state === "started" || record.state === "completed") this.addUser(entry!.text, entry!.images, entry!.uuid).confirmed = true;
        else if (record.state === "queued") this.queue.splice(at, 0, entry!);
        this.touch();
        break;
      }
      case "prompt_suggestion":
        this.suggestion = String(record.suggestion ?? "");
        this.touch();
        break;
      case "active_goal":
        this.goal = record.value?.condition ? String(record.value.condition) : "";
        this.touch();
        break;
      case "auth_status":
        if (record.error) this.add({ kind: "notice", text: `Sign-in: ${record.error}`, tone: "error" }, "n");
        else if (Array.isArray(record.output) && record.output.length) this.onToast?.(record.output.join(" "), "info");
        break;
      default:
        break;
    }
  }

  /** The agent card whose subagent `conversation` is, updated from it. */
  #bumpAgent(agent: Item): void {
    const sub = agent.sub;
    if (sub) {
      const last = sub.items.findLast(item => item.kind === "tool" || item.kind === "agent");
      const running = last && (last.status === "running" || last.status === "pending");
      if (running && (agent.agentStatus === "running" || agent.agentStatus === "pending")) agent.activity = toolActivity(last);
    }
    this.bump(agent);
  }

  #stream(id: string): Stream {
    let stream = this.#streams.get(id);
    if (!stream) {
      this.#msgSeq += 1;
      stream = { seq: this.#msgSeq, startedAt: Date.now(), firstTokenAt: 0, blocks: new Map(), open: [], usage: {}, counted: false };
      this.#streams.set(id, stream);
      // Only the newest messages can still be arriving.
      if (this.#streams.size > 64) this.#streams.delete(this.#streams.keys().next().value!);
    }
    return stream;
  }

  #current: Stream | null = null;

  #onStream(event: Record<string, any>): void {
    switch (event.type) {
      case "message_start": {
        this.#current = this.#stream(String(event.message?.id ?? randomUUID()));
        Object.assign(this.#current.usage, event.message?.usage ?? {});
        this.thinkingTokens = 0;
        // The request that was being retried got through.
        if (this.retry && this.root === this) {
          this.add({ kind: "notice", text: `Recovered after ${this.retry.attempt} ${this.retry.attempt === 1 ? "retry" : "retries"}`, tone: "muted" }, "n");
          this.retry = null;
        }
        if (this.root === this && !this.busy) this.#startRun();
        this.touch();
        break;
      }
      case "content_block_start": {
        const stream = this.#current;
        if (!stream) break;
        const block = event.content_block ?? {};
        const index = Number(event.index ?? 0);
        if (block.type === "text") this.#streamBlock(stream, index, "assistant", { text: block.text || "" });
        else if (block.type === "thinking" || block.type === "redacted_thinking") this.#streamBlock(stream, index, "thinking", { text: block.thinking || "" });
        else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
          const item = this.#streamBlock(stream, index, "tool", { toolCallId: block.id, name: block.name, args: {}, rawArgs: "", output: "" });
          if (isAgentTool(item.name)) this.#promoteAgent(item);
        }
        break;
      }
      case "content_block_delta": {
        const stream = this.#current;
        const item = stream?.blocks.get(Number(event.index ?? 0));
        if (!stream || !item) break;
        const delta = event.delta ?? {};
        if (!stream.firstTokenAt) stream.firstTokenAt = Date.now();
        if (delta.type === "text_delta") item.text += delta.text || "";
        else if (delta.type === "thinking_delta") item.text += delta.thinking || "";
        else if (delta.type === "input_json_delta") {
          item.rawArgs = (item.rawArgs || "") + (delta.partial_json || "");
          const partial = partialJson(item.rawArgs);
          if (partial) item.args = partial;
          if (item.kind === "agent") this.#promoteAgent(item);
        } else break;
        this.bump(item);
        break;
      }
      case "content_block_stop": {
        const item = this.#current?.blocks.get(Number(event.index ?? 0));
        if (!item) break;
        this.#closeBlock(item);
        break;
      }
      case "message_delta": {
        const stream = this.#current;
        if (!stream) break;
        Object.assign(stream.usage, event.usage ?? {});
        break;
      }
      case "message_stop": {
        const stream = this.#current;
        if (stream) this.#countUsage(stream);
        break;
      }
      default:
        break;
    }
  }

  #streamBlock(stream: Stream, index: number, kind: "assistant" | "thinking" | "tool", extra: Partial<Item>): Item {
    const found = stream.blocks.get(index);
    if (found) return found;
    const item = this.add({ kind, msg: stream.seq, status: kind === "tool" ? "pending" : "running", ...extra }, kind === "assistant" ? "m" : kind === "thinking" ? "k" : "t");
    stream.blocks.set(index, item);
    if (kind !== "tool") stream.open.push(item);
    return item;
  }

  /** A block finished streaming: prose is done, a call starts to run. */
  #closeBlock(item: Item): void {
    const now = Date.now();
    if (item.kind === "assistant" || item.kind === "thinking") {
      if (item.status !== "running") return;
      item.status = "done";
      item.endedAt = now;
      if (item.kind === "thinking") item.tookMs ??= Math.max(0, now - item.at);
    } else if (item.status === "pending") {
      if (item.rawArgs) {
        try {
          item.args = JSON.parse(item.rawArgs) as Record<string, any>;
        } catch {
          /* the partial parse stands */
        }
      }
      item.rawArgs = "";
      item.status = "running";
      item.startedAt = now;
      if (item.kind === "agent") this.#promoteAgent(item);
    } else return;
    this.bump(item);
  }

  /** Adds a message's usage line and counts its tokens, once. */
  #countUsage(stream: Stream): void {
    const usage = stream.usage;
    if (stream.counted) return;
    const input = Number(usage.input_tokens || 0);
    const cacheRead = Number(usage.cache_read_input_tokens || 0);
    const cacheWrite = Number(usage.cache_creation_input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    if (!input && !output && !cacheRead && !cacheWrite) return;
    stream.counted = true;
    const now = Date.now();
    const live = stream.firstTokenAt > 0 && !this.#restoring;
    this.add({ kind: "usage", msg: stream.seq, usage: { input: input + cacheWrite, output, cacheRead, prompt: input + cacheRead + cacheWrite, ms: live ? now - stream.startedAt : 0, ttftMs: live ? stream.firstTokenAt - stream.startedAt : 0 } }, "g");
    if (this.root === this) {
      this.contextTokens = input + cacheRead + cacheWrite + output;
      this.#run.input += input + cacheWrite;
      this.#run.output += output;
      this.#run.total += input + cacheWrite + output;
      if (live) {
        const decodeMs = now - stream.firstTokenAt;
        if (output > 0 && decodeMs > 200) this.tokPerSec = Math.round((output / decodeMs) * 1000);
      }
    }
  }

  #startRun(): void {
    this.busy = true;
    this.runStartedAt = Date.now();
    this.#run = { input: 0, output: 0, total: 0, costAtStart: this.cost };
    this.suggestion = "";
  }

  #onAssistant(record: Record<string, any>): void {
    const message = record.message ?? {};
    const blocks: any[] = Array.isArray(message.content) ? message.content : [];
    const synthetic = message.model === "<synthetic>";
    const stream = this.#stream(String(message.id ?? randomUUID()));
    const now = Date.now();
    const at = record.timestamp ? Date.parse(record.timestamp) || now : now;
    if (this.root === this && !this.busy && !this.#restoring && !synthetic) this.#startRun();
    for (const block of blocks) {
      if (block.type === "text") {
        if (!block.text) continue;
        // An API failure is written into the transcript as a synthetic reply.
        if (record.isApiErrorMessage || record.error) {
          this.add({ kind: "error", text: String(block.text), msg: stream.seq, at }, "e");
          continue;
        }
        const item = this.#whole(stream, "assistant", at);
        item.text = block.text;
        item.status = "done";
        item.endedAt ??= now;
        item.model = message.model;
        item.uuid = record.uuid ?? item.uuid;
        if (synthetic) item.customType = "command";
        this.bump(item);
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        const text = block.thinking || "";
        if (!text) continue;
        const item = this.#whole(stream, "thinking", at);
        item.text = text;
        item.status = "done";
        item.endedAt ??= now;
        if (this.#restoring) item.tookMs = undefined;
        else item.tookMs ??= Math.max(0, now - item.at);
        this.bump(item);
      } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
        let item = this.#byToolCall.get(String(block.id));
        if (!item) {
          item = this.add({ kind: "tool", msg: stream.seq, toolCallId: block.id, name: block.name, args: {}, output: "", status: "pending", at }, "t");
        }
        item.name = block.name || item.name;
        item.args = block.input && typeof block.input === "object" ? block.input : item.args || {};
        item.rawArgs = "";
        item.uuid = record.uuid ?? item.uuid;
        if (isAgentTool(item.name)) this.#promoteAgent(item);
        if (item.status === "pending") {
          item.status = "running";
          item.startedAt = at;
        }
        this.#noteTaskCall(item);
        this.bump(item);
      } else if (block.type === "image") {
        const images = imagesOf([block]);
        if (images.length) {
          const item = this.#whole(stream, "assistant", at);
          item.images = [...(item.images ?? []), ...images];
          item.status = "done";
          this.bump(item);
        }
      }
    }
    // A reply from a different model than the one before it says so once.
    if (message.model && blocks.length && !synthetic && this.root === this) {
      if (this.#lastModel && this.#lastModel !== message.model) {
        const key = `model:${stream.seq}`;
        if (!this.#byKey.has(key)) {
          const first = this.items.findIndex(item => item.msg === stream.seq);
          const marker: Item = { kind: "notice", id: this.#id("n"), v: 0, at, text: `Model: ${modelLabel(message.model)}`, tone: "info", key };
          this.items.splice(first < 0 ? this.items.length : first, 0, marker);
          this.#byKey.set(key, marker);
        }
      }
      this.#lastModel = message.model;
    }
    // A message that did not stream (a stored one, a subagent's) brings its usage whole.
    if (!stream.firstTokenAt && message.usage && !synthetic) {
      Object.assign(stream.usage, message.usage);
      if (message.stop_reason || this.#restoring) this.#countUsage(stream);
    }
    this.touch();
  }

  /** The item a whole text or thinking block lands in: the one that streamed it, or a new one. */
  #whole(stream: Stream, kind: "assistant" | "thinking", at: number): Item {
    const at_ = stream.open.findIndex(item => item.kind === kind);
    if (at_ >= 0) return stream.open.splice(at_, 1)[0]!;
    return this.add({ kind, msg: stream.seq, status: "done", at }, kind === "assistant" ? "m" : "k");
  }

  #onUser(record: Record<string, any>): void {
    const message = record.message ?? {};
    const content = message.content;
    const at = record.timestamp ? Date.parse(record.timestamp) || Date.now() : Date.now();
    const results: any[] = Array.isArray(content) ? content.filter(block => block?.type === "tool_result") : [];
    for (const block of results) {
      const item = this.findTool(block.tool_use_id);
      if (item) this.#settleTool(item, block, record.tool_use_result ?? record.toolUseResult, at);
    }
    if (results.length) return;
    const text = textOf(content).trim();
    const images = imagesOf(content);
    const uuid = record.uuid ? String(record.uuid) : undefined;
    if (uuid && this.#silent.delete(uuid)) return;
    if (record.isMeta || record.isVisibleInTranscriptOnly) return;
    if (record.isCompactSummary) {
      const last = this.items.findLast(item => item.kind === "compaction");
      if (last && !last.text) {
        last.text = text.replace(/^This session is being continued[^\n]*\n+/, "");
        this.bump(last);
      } else this.add({ kind: "compaction", text, at }, "c");
      return;
    }
    // The echo of a message this surface sent: its row is already there, or waits in the queue.
    if (uuid) {
      const queued = this.queue.findIndex(entry => entry.uuid === uuid);
      if (queued >= 0) {
        const [entry] = this.queue.splice(queued, 1);
        const item = this.addUser(entry!.text, entry!.images, uuid);
        item.confirmed = true;
        return;
      }
      const echo = this.items.findLast(item => item.kind === "user" && item.uuid === uuid);
      if (echo) {
        echo.confirmed = true;
        this.bump(echo);
        return;
      }
    }
    if (!text && !images.length) return;
    this.#addUserText(text, images, uuid, at);
  }

  /** A user-role message that is not an echo of ours: a stored prompt, a command's output, a wake-up. */
  #addUserText(text: string, images: Image[], uuid: string | undefined, at: number): void {
    const stdout = text.match(LOCAL_STDOUT) ?? text.match(LOCAL_STDERR);
    if (stdout) {
      const body = (stdout[1] ?? "").trim();
      if (body && !/^(Compacted|\(no content\))\s*$/.test(body)) this.add({ kind: "custom", customType: "command output", text: body, at }, "x");
      return;
    }
    // A summary written in place of the earlier conversation (Claude Code's own, or a plugin's).
    if (/^(This conversation was compacted\. Summary of everything before this message:|This session is being continued from a previous conversation)/.test(text)) {
      const body = text.replace(/^[^\n]*\n+/, "");
      const last = this.items.at(-1)?.kind === "compaction" ? this.items.at(-1)! : this.items.findLast(item => item.kind === "compaction" && !item.text);
      if (last && !last.text) {
        last.text = body;
        this.bump(last);
      } else this.add({ kind: "compaction", text: body, at }, "c");
      return;
    }
    // What was said on a branch that was left, as the surface summarized it when moving in the session tree.
    const branch = text.match(BRANCH_SUMMARY);
    if (branch) {
      this.add({ kind: "branch", text: (branch[1] ?? "").trim(), at }, "b");
      return;
    }
    const command = text.match(COMMAND_NAME);
    // The command that started this conversation is not part of it.
    if (command && /^\/?(clear|new|reset)$/.test(command[1]!)) return;
    if (command) {
      const args = (text.match(COMMAND_ARGS)?.[1] ?? "").trim();
      const item = this.addUser(`/${command[1]!.replace(/^\//, "")}${args ? ` ${args}` : ""}`, [], uuid);
      item.confirmed = true;
      item.at = at;
      return;
    }
    const bash = text.match(BASH_INPUT);
    if (bash) {
      const output = [text.match(BASH_STDOUT)?.[1] ?? "", text.match(BASH_STDERR)?.[1] ?? ""].filter(Boolean).join("\n");
      this.add({ kind: "bash", text: (bash[1] ?? "").trim(), output, status: "done", at }, "s");
      return;
    }
    if (/^<bash-std(out|err)>/.test(text)) {
      const last = this.items.findLast(item => item.kind === "bash");
      if (last && !last.output) {
        last.output = [text.match(BASH_STDOUT)?.[1] ?? "", text.match(BASH_STDERR)?.[1] ?? ""].filter(Boolean).join("\n");
        this.bump(last);
      }
      return;
    }
    if (/^\[Request interrupted by user/.test(text)) {
      const last = this.items.at(-1);
      if (!(last?.kind === "notice" && last.text === "Interrupted")) this.add({ kind: "notice", text: "Interrupted", tone: "muted", at }, "n");
      return;
    }
    if (/^<(task-notification|system-reminder|local-command-caveat)>/.test(text)) return;
    // A subagent's report handed back to the session: Claude Code wraps it in notes for the model, which are not for reading.
    const report = agentReport(text);
    if (report !== null) {
      this.add({ kind: "custom", customType: "subagent report", text: report || "(no report)", at }, "x");
      return;
    }
    // A plugin's wake-up (a monitor's batch of lines) reads as an event, not as something the user typed.
    const monitor = text.match(/^Monitor (\S+) \(([^)]*)\)([\s\S]*)$/);
    if (monitor) {
      this.add({ kind: "custom", customType: `monitor · ${monitor[2]}`, text: `\`\`\`\n${(monitor[3] ?? "").replace(/^:?\n?/, "").trim() || "(event)"}\n\`\`\``, at }, "x");
      return;
    }
    // A subagent's task can arrive twice (as its start and as its first message).
    const previous = this.items.at(-1);
    if (previous?.kind === "user" && previous.text === text && this.root !== this) return;
    const item = this.addUser(text, images, uuid);
    item.confirmed = true;
    item.at = at;
  }

  #settleTool(item: Item, block: Record<string, any>, structured: unknown, at: number): void {
    const now = Date.now();
    item.endedAt = this.#restoring ? at : now;
    item.isError = Boolean(block.is_error);
    item.awaiting = false;
    item.status = item.isError ? "error" : "done";
    if (!this.#restoring && item.startedAt) item.durationMs = Math.max(0, now - item.startedAt);
    if (structured && typeof structured === "object") item.details = structured as Record<string, any>;
    const images = imagesOf(block.content);
    if (images.length) item.resultImages = images;
    const text = contentText(block.content).replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/, "$1");
    item.output = text;
    const details = item.details ?? {};
    if (typeof details.durationMs === "number" && !item.durationMs) item.durationMs = details.durationMs;
    if (item.isError) {
      const exit = text.match(/^Exit code (\d+)/);
      if (exit) item.exitCode = Number(exit[1]);
      if (details.interrupted || /interrupted by user|was rejected|doesn't want to proceed/i.test(text)) {
        item.status = "cancelled";
        // Claude Code's note to the model about the refusal is not output of the call.
        item.output = text.replace(/The user doesn't want to proceed with this tool use\.[\s\S]*$/, "").replace(/\[Request interrupted by user[^\]]*\]/g, "").trim();
      }
    }
    if (item.kind === "agent") this.#settleAgent(item, details, text);
    this.#noteTaskResult(item);
    this.bump(item);
  }

  #settleAgent(item: Item, details: Record<string, any>, text: string): void {
    const report = contentText(details.content) || text.replace(/^[\s\S]*?\[Subagent hand-back\][^\n]*\n(?:[^\n]*\n)*?\n/, "");
    // The list of tools Claude Code puts before a subagent's summary is a note for the model, not part of the report.
    const clean = report.replace(/^\s*<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>\s*/, "");
    if (clean.trim()) item.output = clean.replace(/^ {2}/gm, "").trim();
    item.stats = {
      tools: details.totalToolUseCount ?? item.stats?.tools ?? 0,
      tokens: details.totalTokens ?? item.stats?.tokens ?? 0,
      took: details.totalDurationMs ?? item.stats?.took,
    };
    if (details.agentId) item.taskId = String(details.agentId);
    // A background run returns at once and keeps going: only its task events may settle it.
    const detached = details.status === "async_launched" || details.isAsync === true;
    if (detached) {
      item.background = true;
      if (this.#restoring) item.agentStatus = "done";
      else if (item.agentStatus !== "done" && item.agentStatus !== "failed" && item.agentStatus !== "aborted") item.agentStatus = "running";
      return;
    }
    item.agentStatus = item.status === "cancelled" ? "aborted" : item.isError ? "failed" : "done";
  }

  #promoteAgent(item: Item): void {
    const args = item.args || {};
    if (item.kind !== "agent") {
      item.kind = "agent";
      item.agentStatus ??= "pending";
      item.startedAt ??= Date.now();
      item.stats ??= { tools: 0, tokens: 0 };
      item.sub ??= new Conversation(this.root, `${item.id}.`);
      item.sub.#restoring = this.#restoring;
      if (item.toolCallId) this.root.#agents.set(item.toolCallId, item);
    }
    item.agentType = args.subagent_type || item.agentType || "agent";
    item.background = Boolean(args.run_in_background) || item.background;
    if (args.model) item.model = String(args.model);
  }

  /** The Task tools and TodoWrite keep the list drawn above the composer. */
  #noteTaskCall(item: Item): void {
    if (String(item.name) !== "TodoWrite" || !Array.isArray(item.args?.todos)) return;
    this.#tasks.clear();
    item.args.todos.forEach((todo: any, index: number) => {
      const id = String(todo?.id ?? index + 1);
      this.#tasks.set(id, { id, text: String(todo?.content ?? ""), status: TASK_STATUS[String(todo?.status)] ?? "pending", ...(todo?.status === "in_progress" && todo?.activeForm ? { note: String(todo.activeForm) } : {}) });
    });
    this.#publishTasks();
  }

  #noteTaskResult(item: Item): void {
    if (item.isError) return;
    const details = item.details ?? {};
    const args = item.args ?? {};
    switch (String(item.name)) {
      case "TaskCreate": {
        const id = String(details.task?.id ?? "");
        if (id) this.#tasks.set(id, { id, text: String(details.task?.subject ?? args.subject ?? ""), status: "pending" });
        break;
      }
      case "TaskUpdate": {
        const id = String(details.taskId ?? args.taskId ?? "");
        const task = this.#tasks.get(id);
        if (!task) break;
        if (args.status === "deleted") this.#tasks.delete(id);
        else {
          if (args.status) task.status = TASK_STATUS[String(args.status)] ?? task.status;
          if (args.subject) task.text = String(args.subject);
          if (task.status === "active" && args.activeForm) task.note = String(args.activeForm);
          else if (task.status !== "active") delete task.note;
        }
        break;
      }
      case "TaskList": {
        if (!Array.isArray(details.tasks)) return;
        this.#tasks.clear();
        for (const task of details.tasks) {
          const id = String(task?.id ?? "");
          if (id) this.#tasks.set(id, { id, text: String(task?.subject ?? ""), status: TASK_STATUS[String(task?.status)] ?? "pending" });
        }
        break;
      }
      default:
        return;
    }
    this.#publishTasks();
  }

  #publishTasks(): void {
    const target = this.root;
    if (target !== this) return;
    const items = [...this.#tasks.values()].filter(task => task.status !== "dropped");
    target.todos = items.length ? [{ id: "tasks", name: "Tasks", items }] : null;
    this.touch();
  }

  #onResult(record: Record<string, any>): void {
    const wasBusy = this.busy;
    this.busy = false;
    this.retry = null;
    this.compacting = false;
    this.thinkingTokens = 0;
    this.hook = "";
    if (typeof record.total_cost_usd === "number" && record.total_cost_usd >= this.cost) this.cost = record.total_cost_usd;
    const model = this.model && record.modelUsage ? (record.modelUsage[this.model] ?? Object.values<any>(record.modelUsage)[0]) : undefined;
    if (model?.contextWindow) this.contextWindow = model.contextWindow;
    // Anything still pending when the turn ends never ran.
    const settle = (conv: Conversation): void => {
      for (const item of conv.items) {
        if (item.kind === "tool" && (item.status === "pending" || item.status === "running")) {
          item.status = "cancelled";
          item.awaiting = false;
          conv.bump(item);
        }
        if (item.kind === "agent") {
          if (!item.background && (item.agentStatus === "pending" || item.agentStatus === "running")) {
            item.agentStatus = "aborted";
            item.status = "cancelled";
            conv.bump(item);
          }
          if (item.sub && !item.background) settle(item.sub);
        }
        if ((item.kind === "assistant" || item.kind === "thinking") && item.status === "running") {
          item.status = "done";
          conv.bump(item);
        }
      }
    };
    settle(this);
    if (record.is_error || String(record.subtype || "").startsWith("error")) {
      const reason: Record<string, string> = { error_max_turns: "Stopped: the turn limit was reached.", error_max_budget_usd: "Stopped: the spending limit was reached.", error_during_execution: "The turn ended with an error." };
      const text = [typeof record.result === "string" ? record.result : "", ...(Array.isArray(record.errors) ? record.errors.map(String) : [])].filter(Boolean).join("\n") || reason[String(record.subtype)] || "The turn ended with an error.";
      const last = this.items.findLast(item => item.kind !== "usage");
      // The same failure may already be in the transcript as the model's synthetic reply.
      // A turn the user stopped ends "in error" with a diagnostic line: that is not a failure to show.
      const stopped = /interrupted|aborted|\[ede_diagnostic\]/i.test(text) || this.items.slice(-4).some(item => item.kind === "notice" && item.text === "Interrupted");
      if (!(last?.kind === "error" && last.text === text) && !stopped) this.add({ kind: "error", text }, "e");
    }
    if (wasBusy) {
      for (let index = this.items.length - 1; index >= 0; index -= 1) {
        const item = this.items[index]!;
        if (item.kind === "user") break;
        if (item.kind === "assistant" && item.customType !== "command") {
          item.turn = { ms: Number(record.duration_ms) || (this.runStartedAt ? Date.now() - this.runStartedAt : 0), input: this.#run.input, output: this.#run.output, total: this.#run.total, cost: Math.max(0, this.cost - this.#run.costAtStart) };
          this.bump(item);
          break;
        }
      }
      // A run that ends with tasks still open says so, where it ended.
      const open = (this.todos ?? []).map(phase => ({ ...phase, items: phase.items.filter(item => item.status === "pending" || item.status === "active" || item.status === "blocked") })).filter(phase => phase.items.length);
      const done = (this.todos ?? []).some(phase => phase.items.some(item => item.status === "done"));
      if (open.length && done && record.terminal_reason === "completed") this.add({ kind: "reminder", open }, "r");
    }
    this.runStartedAt = 0;
    this.touch();
  }

  #onSystem(record: Record<string, any>): void {
    switch (record.subtype) {
      case "init":
        this.model = String(record.model ?? this.model);
        this.permissionMode = String(record.permissionMode ?? this.permissionMode);
        this.sessionId = String(record.session_id ?? this.sessionId);
        this.touch();
        break;
      case "status":
        if (record.permissionMode) this.permissionMode = String(record.permissionMode);
        if (record.status === "compacting") this.compacting = true;
        else if (record.status === null || record.status === undefined) {
          if (this.compacting && record.compact_result === "failed") this.add({ kind: "notice", text: `Compaction failed${record.compact_error ? `: ${record.compact_error}` : ""}`, tone: "error" }, "n");
          this.compacting = false;
        }
        this.touch();
        break;
      case "compact_boundary": {
        const meta = record.compact_metadata ?? record.compactMetadata ?? {};
        this.compacting = false;
        this.add({ kind: "compaction", text: "", tokensBefore: meta.pre_tokens ?? meta.preTokens, tokensAfter: meta.post_tokens ?? meta.postTokens, at: record.timestamp ? Date.parse(record.timestamp) || Date.now() : Date.now() }, "c");
        if (typeof (meta.post_tokens ?? meta.postTokens) === "number") this.contextTokens = meta.post_tokens ?? meta.postTokens;
        break;
      }
      case "api_retry":
        this.retry = { attempt: Number(record.attempt) || 1, max: Number(record.max_retries) || 0, delayMs: Number(record.retry_delay_ms) || 0, at: Date.now(), error: String(record.error ?? (record.error_status ? `HTTP ${record.error_status}` : "")) };
        this.touch();
        break;
      case "task_started": {
        const agent = record.tool_use_id ? this.root.#agents.get(String(record.tool_use_id)) : undefined;
        if (agent && (record.task_type === "local_agent" || !record.task_type)) {
          agent.taskId = String(record.task_id);
          agent.agentStatus = "running";
          agent.background = Boolean(record.is_backgrounded) || agent.background;
          agent.startedAt ??= Date.now();
          // The plugin names the model a subagent runs on after the description.
          const named = String(record.description ?? "").match(/ · ([^·]+)$/);
          if (named) agent.model = named[1]!.trim();
          this.root.#byTask.set(agent.taskId, agent);
          this.bump(agent);
        } else {
          this.background.set(String(record.task_id), { id: String(record.task_id), type: String(record.task_type ?? "task"), description: String(record.description ?? record.task_type ?? "task"), startedAt: Date.now(), ...(record.tool_use_id ? { toolUseId: String(record.tool_use_id) } : {}) });
          this.touch();
        }
        break;
      }
      case "task_progress": {
        const agent = this.root.#byTask.get(String(record.task_id));
        if (!agent) break;
        const usage = record.usage ?? {};
        agent.stats = { tools: usage.tool_uses ?? agent.stats?.tools ?? 0, tokens: usage.total_tokens ?? agent.stats?.tokens ?? 0, took: usage.duration_ms ?? agent.stats?.took };
        if (record.summary) agent.activity = String(record.summary);
        else if (record.description) agent.activity = String(record.description);
        this.bump(agent);
        break;
      }
      case "task_updated": {
        const patch = record.patch ?? {};
        const agent = this.root.#byTask.get(String(record.task_id));
        if (agent) {
          if (patch.status) agent.agentStatus = AGENT_STATUS[String(patch.status)] ?? agent.agentStatus;
          if (patch.is_backgrounded) agent.background = true;
          if (patch.error) agent.error = String(patch.error);
          if (patch.status && patch.status !== "running" && patch.status !== "pending" && patch.status !== "paused") {
            agent.endedAt = Date.now();
            agent.activity = undefined;
          }
          this.bump(agent);
        } else if (patch.status && patch.status !== "running" && patch.status !== "pending" && patch.status !== "paused") {
          this.background.delete(String(record.task_id));
          this.touch();
        }
        break;
      }
      case "task_notification": {
        const agent = this.root.#byTask.get(String(record.task_id));
        if (agent) {
          const usage = record.usage ?? {};
          agent.agentStatus = AGENT_STATUS[String(record.status)] ?? agent.agentStatus;
          agent.stats = { tools: usage.tool_uses ?? agent.stats?.tools ?? 0, tokens: usage.total_tokens ?? agent.stats?.tokens ?? 0, took: usage.duration_ms ?? agent.stats?.took };
          // A background run reports here; a foreground one has its report in the tool result.
          if (record.summary && (agent.background || !agent.output)) agent.output = String(record.summary);
          agent.endedAt ??= Date.now();
          agent.activity = undefined;
          this.bump(agent);
        } else {
          const task = this.background.get(String(record.task_id));
          if (task) {
            this.background.delete(task.id);
            this.onToast?.(`${task.description}: ${String(record.status ?? "finished")}`, record.status === "failed" ? "error" : "info");
            this.touch();
          }
        }
        break;
      }
      case "background_tasks_changed": {
        const live = new Set<string>((Array.isArray(record.tasks) ? record.tasks : []).map((task: any) => String(task.task_id)));
        for (const task of Array.isArray(record.tasks) ? record.tasks : []) {
          const id = String(task.task_id);
          if (this.root.#byTask.has(id) || this.background.has(id)) continue;
          if (task.task_type === "local_agent") continue;
          this.background.set(id, { id, type: String(task.task_type ?? "task"), description: String(task.description ?? task.task_type ?? "task"), startedAt: Date.now() });
        }
        for (const id of [...this.background.keys()]) if (!live.has(id)) this.background.delete(id);
        this.touch();
        break;
      }
      case "local_command_output": {
        const text = String(record.content ?? "").trim();
        if (text) this.add({ kind: "custom", customType: "command output", text }, "x");
        break;
      }
      case "informational": {
        const text = String(record.content ?? "").trim();
        if (!text) break;
        if (record.level === "warning") this.add({ kind: "notice", text, tone: "warning" }, "n");
        else this.add({ kind: "notice", text, tone: "muted" }, "n");
        break;
      }
      case "notification":
        if (record.text) this.onToast?.(String(record.text), record.priority === "immediate" || record.priority === "high" ? "warning" : "info");
        break;
      case "ui_status":
        if (record.text) this.statuses.set(String(record.plugin ?? "plugin"), String(record.text));
        else this.statuses.delete(String(record.plugin ?? "plugin"));
        this.touch();
        break;
      case "hook_started":
        this.hook = `${String(record.hook_event ?? "hook")}: ${String(record.hook_name ?? "")}`.replace(/: $/, "");
        this.touch();
        break;
      case "hook_response": {
        this.hook = "";
        // A hook that failed says so where it ran; one that passed stays quiet, as in Claude Code.
        const text = String(record.stderr || record.output || record.stdout || "").trim();
        if (record.outcome === "error") this.add({ kind: "notice", text: `${String(record.hook_event ?? "Hook")} hook ${String(record.hook_name ?? "")} failed${record.exit_code != null ? ` (exit ${record.exit_code})` : ""}${text ? `: ${text.split("\n")[0]!.slice(0, 300)}` : ""}`, tone: "warning" }, "n");
        this.touch();
        break;
      }
      case "session_title_changed":
        this.sessionName = String(record.title ?? "");
        this.touch();
        break;
      case "thinking_tokens":
        this.thinkingTokens = Number(record.estimated_tokens) || 0;
        this.touch();
        break;
      case "session_state_changed":
        if (record.state === "idle" && this.busy && !this.#current) this.busy = false;
        this.touch();
        break;
      case "model_refusal_fallback":
      case "model_refusal_no_fallback": {
        const text = String(record.content || record.api_refusal_explanation || record.apiRefusalExplanation || "").trim();
        if (text) this.add({ kind: "notice", text, tone: "warning" }, "n");
        break;
      }
      case "memory_recall": {
        const count = Array.isArray(record.memories) ? record.memories.length : 0;
        if (count) this.add({ kind: "notice", text: `Recalled ${count} ${count === 1 ? "memory" : "memories"}`, tone: "muted" }, "n");
        break;
      }
      case "away_summary":
      case "scheduled_task_fire":
      case "bridge_status": {
        const text = String(record.content ?? "").trim();
        if (text) this.add({ kind: "notice", text, tone: "muted", at: record.timestamp ? Date.parse(record.timestamp) || Date.now() : Date.now() }, "n");
        break;
      }
      case "local_command": {
        const body = String(record.content ?? "").match(LOCAL_STDOUT)?.[1]?.trim();
        if (body && !/^(Compacted|\(no content\))\s*$/.test(body)) this.add({ kind: "custom", customType: "command output", text: body }, "x");
        break;
      }
      default:
        break;
    }
  }

  /** Marks the call a permission request is for, at any nesting level. */
  setAwaiting(toolCallId: string, awaiting: boolean): void {
    const item = this.findToolDeep(toolCallId);
    if (!item || item.awaiting === awaiting) return;
    item.awaiting = awaiting;
    // The call starts to run when it is approved, not when it was asked about.
    if (!awaiting && item.status === "running") item.startedAt = Date.now();
    this.bump(item);
    for (const agent of this.root.#agents.values()) if (agent.sub?.items.includes(item)) this.bump(agent);
  }

  // ───────────────────────────────────────────────────────────── `!command`

  /** A `!command` typed by the user: shown at once, filled as output arrives. */
  startShell(command: string, excluded: boolean): Item {
    const item = this.add({ kind: "bash", text: command, output: "", status: "running", startedAt: Date.now(), excluded }, "s");
    this.shell = item;
    return item;
  }

  finishShell(item: Item, exitCode: number | null, cancelled: boolean, error?: string): void {
    if (this.shell === item) this.shell = null;
    item.endedAt = Date.now();
    item.durationMs = item.endedAt - (item.startedAt || item.at);
    item.exitCode = exitCode;
    item.cancelled = cancelled;
    if (error) item.output = `${item.output || ""}${item.output ? "\n" : ""}${error}`;
    item.status = error ? "error" : cancelled ? "cancelled" : exitCode ? "error" : "done";
    this.bump(item);
  }

  // ───────────────────────────────────────────────────────────── stored transcripts

  /**
   * Rebuilds from a stored transcript's entries (resume, fork, rewind): the
   * branch that ends at the last message, oldest first.
   */
  loadEntries(entries: Record<string, any>[], leaf?: string): void {
    this.reset();
    this.#restoring = true;
    for (const entry of liveBranch(entries, leaf)) {
      if (entry.type === "user" || entry.type === "assistant") this.onMessage({ ...entry, parent_tool_use_id: null });
      else if (entry.type === "system") this.#onSystem(entry);
    }
    for (const entry of entries) {
      if (entry.type === "custom-title" && entry.customTitle) this.sessionName = String(entry.customTitle);
      else if (entry.type === "ai-title" && entry.aiTitle && !this.sessionName) this.sessionName = String(entry.aiTitle);
      else if (entry.type === "cost-state" && typeof entry.totalCostUSD === "number") this.cost = entry.totalCostUSD;
    }
    this.#finishRestore(this);
    this.#restoring = false;
    this.busy = false;
    this.touch();
  }

  /** Fills an agent card's conversation from its stored sidechain transcript. */
  loadSidechain(agent: Item, entries: Record<string, any>[]): void {
    const sub = agent.sub;
    if (!sub || sub.items.length) return;
    sub.#restoring = true;
    for (const entry of entries) if (entry.type === "user" || entry.type === "assistant") sub.onMessage({ ...entry, parent_tool_use_id: null });
    this.#finishRestore(sub);
    sub.#restoring = false;
    this.bump(agent);
  }

  /** A call with no result in a stored transcript never ran to the end. */
  #finishRestore(conv: Conversation): void {
    for (const item of conv.items) {
      if (item.kind === "tool" && (item.status === "pending" || item.status === "running")) item.status = "cancelled";
      if (item.kind === "agent") {
        if (item.agentStatus === "pending" || item.agentStatus === "running") item.agentStatus = item.background ? "done" : "aborted";
        if (item.status === "pending" || item.status === "running") item.status = "cancelled";
        if (item.sub) this.#finishRestore(item.sub);
      }
      if (item.kind === "assistant" || item.kind === "thinking") {
        if (item.status === "running") item.status = "done";
        if (item.kind === "thinking") item.tookMs = undefined;
      }
    }
  }
}

/** What a running call is doing, in a few words. */
export function toolActivity(item: Item | undefined): string {
  if (!item) return "";
  const args = item.args || {};
  const name = String(item.name || "tool");
  const what = String(args.description ?? args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url ?? args.subject ?? "").split("\n")[0]!.slice(0, 70);
  const verb: Record<string, string> = { Bash: "Running", Read: "Reading", Edit: "Editing", Write: "Writing", Grep: "Searching", Glob: "Finding", WebSearch: "Searching the web for", WebFetch: "Fetching", Agent: "Running", Task: "Running", LSP: "Asking the language server", NotebookEdit: "Editing" };
  if (/^Task(Create|Update|List|Get)$|^TodoWrite$/.test(name)) return "Tracking the work";
  if (name === "AskUserQuestion") return "Waiting for your answer";
  return [verb[name] ?? `Running ${name.replace(/^mcp__/, "").replace(/__/g, " · ")}`, what].filter(Boolean).join(" ");
}

/**
 * The entries of the conversation as it stands: from the last message back
 * through each parent, a compaction boundary continuing at its logical parent.
 */
export function liveBranch(entries: Record<string, any>[], leafUuid?: string): Record<string, any>[] {
  const byUuid = new Map<string, Record<string, any>>();
  let leaf: Record<string, any> | undefined;
  for (const entry of entries) {
    if (!entry.uuid || entry.isSidechain) continue;
    byUuid.set(String(entry.uuid), entry);
    if (entry.type === "user" || entry.type === "assistant" || entry.type === "system") leaf = entry;
  }
  if (leafUuid && byUuid.has(leafUuid)) leaf = byUuid.get(leafUuid);
  const seen = new Set<string>();
  for (let entry = leaf; entry && !seen.has(String(entry.uuid)); ) {
    seen.add(String(entry.uuid));
    const parent: unknown = entry.parentUuid ?? entry.logicalParentUuid;
    entry = parent ? byUuid.get(String(parent)) : undefined;
  }
  // Calls made side by side chain one after another, so each result but the
  // last hangs off the chain: a result belongs when its call's message does.
  const hasResult = (entry: Record<string, any>): boolean => entry.type === "user" && Array.isArray(entry.message?.content) && entry.message.content.some((block: any) => block?.type === "tool_result");
  return entries.filter(entry => entry.uuid && !entry.isSidechain && (seen.has(String(entry.uuid)) || (hasResult(entry) && (seen.has(String(entry.parentUuid)) || seen.has(String(entry.sourceToolAssistantUUID))))));
}

export interface TreeNode {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  depth: number;
  /** On the branch the conversation is on now. */
  live: boolean;
}

/**
 * The report inside a message another agent of the session sent (`<agent-message>`),
 * without the notes Claude Code wraps around it for the model; null for any other text.
 */
export function agentReport(text: string): string | null {
  const match = text.match(/^Another Claude session sent a message:\s*<agent-message[^>]*>([\s\S]*?)<\/agent-message>/);
  if (!match) return null;
  const body = match[1]!;
  const cut = body.search(/The report\s+follows:/);
  const report = cut >= 0 ? body.slice(cut).replace(/^The report\s+follows:\s*/, "") : body;
  // The harness indents every line of the report.
  return report.replace(/^ {1,4}/gm, "").trim();
}

/**
 * Every message of a stored session as a tree: a rewind or an edit leaves the
 * old continuation in the file as a sibling branch, and each branch indents.
 */
export function sessionTree(entries: Record<string, any>[]): TreeNode[] {
  const live = new Set(liveBranch(entries).map(entry => String(entry.uuid)));
  const shown = (entry: Record<string, any>): string => {
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) return "";
    const content = entry.message?.content;
    if (entry.type === "user") {
      const text = (typeof content === "string" ? content : textOf(content)).trim();
      if (!text || /^<(local-command|system-reminder|task-notification|bash-std|command-message)/.test(text) || agentReport(text) !== null) return "";
      const command = text.match(COMMAND_NAME);
      return command ? `/${command[1]!.replace(/^\//, "")}` : text;
    }
    if (entry.type === "assistant") return textOf(content).trim();
    return "";
  };
  const children = new Map<string, Record<string, any>[]>();
  const roots: Record<string, any>[] = [];
  const known = new Set(entries.filter(entry => entry.uuid).map(entry => String(entry.uuid)));
  for (const entry of entries) {
    // Every entry links the chain (attachments sit between a message and its reply); only messages are shown.
    if (!entry.uuid || entry.isSidechain) continue;
    const parent = entry.parentUuid ?? entry.logicalParentUuid;
    if (parent && known.has(String(parent))) {
      const list = children.get(String(parent));
      if (list) list.push(entry);
      else children.set(String(parent), [entry]);
    } else roots.push(entry);
  }
  const out: TreeNode[] = [];
  // Iterative: a long session is a chain tens of thousands of entries deep.
  const stack: { entry: Record<string, any>; depth: number }[] = roots.reverse().map(entry => ({ entry, depth: 0 }));
  while (stack.length) {
    const { entry, depth } = stack.pop()!;
    const text = shown(entry);
    if (text) out.push({ uuid: String(entry.uuid), role: entry.type === "user" ? "user" : "assistant", text, depth, live: live.has(String(entry.uuid)) });
    // Only branches that say something count: side-by-side tool results are not forks.
    const kids = children.get(String(entry.uuid)) ?? [];
    const speaking = kids.filter(kid => hasText(kid, children, shown));
    const fork = speaking.length > 1;
    for (let index = kids.length - 1; index >= 0; index -= 1) stack.push({ entry: kids[index]!, depth: fork && speaking.includes(kids[index]!) ? depth + 1 : depth });
  }
  return out;
}

/** Whether `entry` or anything below it is a message a person would recognise. */
function hasText(entry: Record<string, any>, children: Map<string, Record<string, any>[]>, shown: (entry: Record<string, any>) => string): boolean {
  const stack = [entry];
  for (let steps = 0; stack.length && steps < 400; steps += 1) {
    const at = stack.pop()!;
    if (shown(at)) return true;
    stack.push(...(children.get(String(at.uuid)) ?? []));
  }
  return false;
}
