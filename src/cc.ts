/**
 * A client for Claude Code's stream-json protocol (`claude -p --input-format
 * stream-json --output-format stream-json`): the channel the Agent SDK uses.
 *
 * One JSON record per line in both directions. Records the CLI writes are
 * conversation messages, replies to our control requests, or control requests
 * of its own (a tool permission, a hook callback, a dialog) that we answer by
 * id. stdout is read continuously so the child never blocks on a full pipe.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type Record_ = Record<string, any>;

export interface ClaudeOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

/** The flags that make the CLI speak the protocol. */
export const PROTOCOL_ARGS: readonly string[] = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--include-hook-events", "--replay-user-messages", "--permission-prompt-tool", "stdio"];

/**
 * Events: `message` (a conversation record), `request` ({id, request}: the CLI
 * asks us something), `cancel` (request id the CLI withdrew), `stderr`
 * (chunk), `exit` ({code, signal}), `error` (spawn failure).
 */
export class Claude extends EventEmitter {
  readonly bin: string;
  stderr = "";
  exited = false;
  #nextId = 0;
  #pending = new Map<string, Pending>();
  #buffer = "";
  #child: ChildProcessWithoutNullStreams;

  constructor({ bin, args, cwd, env = {} }: ClaudeOptions) {
    super();
    this.bin = bin;
    this.#child = spawn(bin, [...PROTOCOL_ARGS, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // File checkpoints are what `/rewind` restores from.
      env: { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1", ...env },
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16000);
      this.emit("stderr", chunk);
    });
    // A write to a child that already exited must not take the surface down.
    this.#child.stdin.on("error", () => undefined);
    this.#child.on("error", (error: Error) => {
      if (this.exited) return;
      this.exited = true;
      this.#failAll(error);
      this.emit("error", error);
    });
    this.#child.on("exit", (code, signal) => {
      if (this.exited) return;
      this.exited = true;
      this.#failAll(new Error(`claude exited (${signal ?? code})`));
      this.emit("exit", { code, signal });
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let at: number;
    // LF only: U+2028 inside a JSON string is legal and must not split a record.
    while ((at = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (!line.trim()) continue;
      let record: Record_;
      try {
        record = JSON.parse(line) as Record_;
      } catch {
        continue;
      }
      this.#onRecord(record);
    }
  }

  #onRecord(record: Record_): void {
    switch (record.type) {
      case "control_response": {
        const response = record.response ?? {};
        const pending = this.#pending.get(String(response.request_id));
        if (!pending) return;
        this.#pending.delete(String(response.request_id));
        if (pending.timer) clearTimeout(pending.timer);
        if (response.subtype === "error") pending.reject(new Error(String(response.error ?? "request failed")));
        else pending.resolve(response.response ?? {});
        return;
      }
      case "control_request":
        this.emit("request", { id: String(record.request_id), request: record.request ?? {} });
        return;
      case "control_cancel_request":
        this.emit("cancel", String(record.request_id));
        return;
      case "keep_alive":
        return;
      default:
        this.emit("message", record);
    }
  }

  #write(record: Record_): void {
    if (this.exited) return;
    this.#child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** A control request of ours; resolves with the reply's `response`. */
  request(subtype: string, body: Record_ = {}, timeoutMs = 30_000): Promise<any> {
    if (this.exited) return Promise.reject(new Error("claude is not running"));
    const id = `tsp-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.#pending.delete(id) && reject(new Error(`${subtype} timed out`)), timeoutMs) : null;
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ type: "control_request", request_id: id, request: { subtype, ...body } });
    });
  }

  /** Answers a control request the CLI sent. */
  respond(id: string, response: Record_): void {
    this.#write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }

  respondError(id: string, error: string): void {
    this.#write({ type: "control_response", response: { subtype: "error", request_id: id, error } });
  }

  /** Sends a user message: a prompt, a slash command, or blocks with images. */
  user(content: string | Record_[], extra: Record_ = {}): void {
    this.#write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", ...extra });
  }

  /** Ends the session: closing stdin lets the CLI flush and exit; then it is killed. */
  stop(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise(resolve => {
      const done = (): void => resolve();
      this.#child.once("exit", done);
      this.#child.once("error", done);
      try {
        this.#child.stdin.end();
      } catch {
        /* already closed */
      }
      setTimeout(() => !this.exited && this.#child.kill("SIGTERM"), 1200);
      setTimeout(() => {
        if (!this.exited) this.#child.kill("SIGKILL");
        resolve();
      }, 2400);
    });
  }
}
