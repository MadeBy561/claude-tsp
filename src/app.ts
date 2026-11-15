/**
 * The controller: Claude Code's stream-json session on one side, a Tern
 * surface on the other. It owns input focus (composer, picker, dialog,
 * sheet), runs commands and redraws the view from state.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Node as TernNode, type Key, type Session, type Surface, type TspEvent } from "@stencil-hq/tern";
import { spawnArgs, type Launch, type SpawnState } from "./args.js";
import { Claude } from "./cc.js";
import { isImagePath, readClipboardFilePaths, readClipboardImage, readClipboardText, readImageFile } from "./clipboard.js";
import { TextEditor } from "./editor.js";
import { FileIndex } from "./files.js";
import { API_KEY_SECRET, APP_URL, inspect, MANUAL_URL, OAUTH_SECRET, parseRepo, plainText, preflight, secretFor, setup, tokenIn, workflowFile, type WorkflowKind } from "./github.js";
import { rank } from "./fuzzy.js";
import { DEFAULT_KEYS, Keymap, type Action } from "./keymap.js";
import { branchSummaryMessage, Conversation, liveBranch, modelLabel, sessionTree, toolActivity, type Image, type Item, type Queued } from "./model.js";
import { releaseNotes } from "./notes.js";
import { configDir, profile, sessionFile, sidechainFile, stateDir, stockPath } from "./paths.js";
import { LOCAL_ALIAS, LOCAL_EFFORTS, localEffort, realWindow } from "./pi.js";
import { Picker, type PickerOptions } from "./picker.js";
import { drawn, uiButtons, uiNodes, type UiNode, type UiPress } from "./pluginui.js";
import { providerIcon } from "./provider.js";
import { BlockRegion } from "./region.js";
import type { ShellPrefs } from "./shell.js";
import { installSplice } from "./splice.js";
import { latestSession, listSessions, readEntries, type SessionRow } from "./sessions.js";
import { collectStats, emptyStats, type Stats } from "./stats.js";
import { addRule, CLAUDE_CHOICES, CLAUDE_SETTINGS, getKey, getNested, setNested, readEnv, removeRule, setKey, SCOPES, setEnv, settingsPath, validRule, type Behavior, type Scope } from "./settingsfile.js";
import { LOGO_SVG, stylesheet } from "./theme.js";
import { dropTraces, takeTrace, traced, traceFile, untraced, usesTracing } from "./trace.js";
import { Vim } from "./vim.js";
import { dock, EDITOR_ID, errorBanner, MODES, rewindPanel, type Attachment, type DockActions, type DockState } from "./view/dock.js";
import { clock, duration, fileHref, firstLine, h, money, s, showPath, tokens, type EditEvent, type Node, type ViewCtx } from "./view/h.js";
import { approvalPanel, completionPopup, fieldDialog, fieldInputId, pickerNode, prefsNode, QUESTION_INPUT_ID, questionPanel, sheet, toastNodes, type Completion, type PickerItem, type PrefsRow, type Toast } from "./view/overlays.js";
import { commandPane, diffHunks, toolTitle } from "./view/tools.js";
import { TIPS, TranscriptView, welcome } from "./view/transcript.js";

export const VERSION: string = (() => {
  try {
    return String((JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const PROFILE = profile();

/** The surface: inline like a program's output, and styled by Tern as an agent session. */
const SURFACE = { id: PROFILE.id, mode: "inline", title: PROFILE.name, role: "omp.session", font: "sans" } as const;

const plainLabel = (text: string): string => text.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "");

const META_AS_CTRL = process.env.CLAUDE_TSP_META_AS_CTRL === "1";

/**
 * How this surface names itself to plugins. A plugin draws from the element
 * table of a surface it knows, and `desktop`'s is the one for a graphical
 * host: Box, Text, Button, Link, Code and Markdown are drawn here.
 */
const UI_SURFACE = "desktop";
const UI_CLIENT = "claude-tsp";

interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

interface Command {
  name: string;
  description: string;
  icon: string;
  hint?: string;
  /** Shown at the row's end: the current value. */
  value?: () => string;
  /** A local command; absent for the ones Claude Code runs itself. */
  run?: (args: string) => void | Promise<void>;
}

interface Choice {
  id: string;
  label: string;
  deny: boolean;
  detail?: string;
  /** What answers the request when this is chosen; `null` asks for a message first. */
  answer: (() => Record<string, any>) | null;
}

interface Approval {
  /** The control request this answers. */
  id: string;
  toolUseId: string;
  title: string;
  origin?: string;
  reason?: string;
  preview: () => (Node | null)[];
  details: string[];
  choices: Choice[];
  selected: string;
  expanded: boolean;
  expandable: boolean;
}

interface Question {
  id: string;
  toolUseId: string;
  input: Record<string, any>;
  questions: { question: string; header: string; multi: boolean; options: { label: string; description: string }[] }[];
  at: number;
  /** Chosen labels per question; the free answer is kept apart. */
  picked: Set<string>[];
  other: string[];
  selected: number;
  editor: TextEditor | null;
}

interface Field {
  title: string;
  detail: string;
  link?: string;
  placeholder: string;
  multiline: boolean;
  editor: TextEditor;
  done(value: string | null): void;
}

interface Sheet {
  id: string;
  head: string;
  size: "sm" | "md" | "lg" | "full";
  body(): (Node | null)[];
  extra?: () => (Node | null)[];
}

interface Prefs {
  page: string;
  focus: string | null;
  /** The row whose menu is open, and the option under the cursor. */
  editing?: { row: string; option: string } | null;
}

/** The user messages that can be rewound to, and which one is chosen. */
interface RewindState {
  entries: Item[];
  at: number;
  mode: "both" | "conversation" | "files";
  files: Map<string, string>;
}

interface CompletionState {
  kind: "command" | "file";
  /** Where the completed token starts in the draft. */
  from: number;
  items: Completion[];
  selected: number;
}

const EFFORT_DETAIL: Record<string, string> = {
  low: "Fast, for simple edits",
  medium: "Balanced",
  high: "Thorough",
  xhigh: "Very thorough, slower",
  max: "The deepest reasoning, slowest; this session only",
};

/** The modes Shift+Tab steps through, as Claude Code does. */
const MODE_CYCLE = ["default", "acceptEdits", "plan", "auto"];

/** Commands that only Claude Code's own terminal UI can run: they open it on this session. */
const TUI_COMMANDS: Record<string, string> = {
  "autofix-pr": "Monitor and autofix any issues with the current PR",
  passes: "Share a free week of Claude Code with friends",
  powerup: "Discover Claude Code features through quick interactive lessons",
  "remote-env": "Choose the default environment for cloud agents",
  voice: "Toggle voice mode",
};

export interface AppOptions {
  session: Session;
  launch: Launch;
  cwd: string;
}

export class App {
  readonly conv = new Conversation();
  readonly editor = new TextEditor();
  #session: Session;
  #surface: Surface;
  #cc!: Claude;
  #launch: Launch;
  #cwd: string;
  #transcript = new TranscriptView();
  /** The transcript region, reconciled block by block instead of through the SDK's whole-view diff. */
  #main = new BlockRegion("main");
  #files: FileIndex;
  #models: ModelInfo[] = [];
  /** The picker value of the model in use (`opus`, `claude-…`). */
  #modelValue = "";
  #remote: Command[] = [];
  #agentTypes: { name: string; description: string; model?: string }[] = [];
  #account: Record<string, any> = {};
  #outputStyle = "default";
  #outputStyles: string[] = [];
  #mcp: { name: string; status: string }[] = [];
  #plugins: { name: string; path?: string; source?: string; version?: string }[] = [];
  /** What plugins draw: the band above the prompt, and the panes they opened. */
  #uiAttached = false;
  #uiBand: UiNode | undefined;
  #uiPanes: { id: string; title: string; plugin: string; tree?: UiNode }[] = [];
  #uiSeq = 0;
  /** Subtasks (forked copies of the conversation) still at work. */
  #subtasks = 0;
  /** The link of this session while remote control is on. */
  #remoteLink: { url: string } | null = null;
  #uiPanesKnown = false;
  /** The status-line command Claude Code is configured with, and whether its line is drawn here. */
  #statusLineCommand = "";
  #statusLine = false;
  #statusLineAt = 0;
  #tools: string[] = [];
  #claudeVersion = "";
  #tip = TIPS[Math.floor(Math.random() * TIPS.length)] ?? "";
  #starting = true;
  #stopping = false;
  /** The process is being replaced (resume, rewind, fork): its exit is expected. */
  #swapping = false;
  #visible = true;
  // Display state.
  #fold = new Map<string, boolean>();
  #shellPrefs = new Map<string, ShellPrefs>();
  #foldRev = 0;
  #expandAll = false;
  #hideThinking = false;
  #showImages = true;
  #showUsage = false;
  #showCharts = true;
  #compactTools = false;
  #showTasks = true;
  #clay = true;
  #suggestions = true;
  /** Claude Code compacts by itself when the window fills, and retries a failed request. */
  #autoCompact = true;
  #autoRetry = true;
  /** What Enter does while Claude works: the message goes in at its next step, after the turn, or stops the turn. */
  #steer: Queued["priority"] = "next";
  /** Bash calls are traced for step-by-step replay (`/trace`). */
  #traceCalls = false;
  #traceFiles = new Map<string, string>();
  #replayTimer: NodeJS.Timeout | null = null;
  /** The item whose command pane is open in the inspector sheet. */
  #inspecting = "";
  /** Extended thinking is switched off for this session (Alt+T). */
  #thinkingOff = false;
  #vimKeys = false;
  #vim = new Vim(this.editor);
  #rewind: RewindState | null = null;
  #rewindPage: Surface | null = null;
  /** The pinned error: which error row it shows, and whether it is opened or dismissed. */
  #banner = { id: "", expanded: false, dismissed: false };
  // Focus owners, innermost first: sheet, prefs, picker, field, question, approval, composer.
  #picker: Picker | null = null;
  #approvals: Approval[] = [];
  #questions: Question[] = [];
  #field: Field | null = null;
  #sheet: Sheet | null = null;
  #prefs: Prefs | null = null;
  #completion: CompletionState | null = null;
  #completionDismissed = "";
  #attachments: Attachment[] = [];
  #stash: { text: string; attachments: Attachment[] } | null = null;
  #toasts: Toast[] = [];
  #toastSeq = 0;
  #blobs = new WeakMap<object, string>();
  #renderTimer: NodeJS.Timeout | null = null;
  #tick: NodeJS.Timeout | null = null;
  #focus: string | null | undefined;
  #lastCtrlC = 0;
  #lastEscape = 0;
  #resyncAt = 0;
  #blockedSince = 0;
  #keymap = Keymap.load(stateDir());
  #lastError = "";
  #shellChild: ChildProcess | null = null;
  /** A run ended: after the next frame, tell Tern its blocks are final. */
  #settlePending = false;
  #settled = new Set<string>();
  #contextAt = 0;
  /** Bumped by every key press: a sheet that was still loading when the user moved on does not open. */
  #keySeq = 0;

  constructor(options: AppOptions) {
    this.#session = options.session;
    this.#launch = options.launch;
    this.#cwd = options.cwd;
    this.#files = new FileIndex(options.cwd);
    installSplice();
    this.#surface = this.#session.open(SURFACE);
    this.#loadHistory();
    this.#loadDisplay();
    this.#applyStyles();
    this.#vim.reset();
    this.conv.onToast = (text, tone) => this.toast(text, tone);
    this.conv.permissionMode = options.launch.permissionMode ?? "default";
  }

  #applyStyles(): void {
    if (!this.#session.caps.features.includes("styles")) return;
    let css = stylesheet(this.#clay);
    // A stylesheet to try in place of the built-in one, for working on the look.
    if (process.env.CLAUDE_TSP_CSS) {
      try {
        css = readFileSync(process.env.CLAUDE_TSP_CSS, "utf8");
      } catch {
        /* the built-in one stands */
      }
    }
    this.#surface.stylesheet("claude-tsp", css);
  }

  // ───────────────────────────────────────────────────────────── lifecycle

  /** Runs until the user quits or Claude Code cannot be started. */
  async run(): Promise<number> {
    this.#applyStyles();
    this.render();
    void this.#open();
    for await (const input of this.#session) {
      try {
        if (input.type === "key") await this.#onKey(input.key);
        else this.#onEvent(input.event);
      } catch (error) {
        this.toast(`claude-tsp: ${(error as Error).message}`, "error");
      }
      this.schedule();
      if (this.#stopping) break;
    }
    return 0;
  }

  /** The first process of the session: a new conversation, or the one the command line names. */
  async #open(): Promise<void> {
    const launch = this.#launch;
    const state: SpawnState = { model: launch.model, permissionMode: launch.permissionMode, effort: launch.effort, name: launch.name };
    let resume: SessionRow | null = null;
    if (typeof launch.resume === "string") {
      const rows = listSessions(this.#cwd);
      resume = rows.find(row => row.id === launch.resume) ?? rows.find(row => row.name === launch.resume) ?? rows.find(row => row.cwd === this.#cwd && row.name.toLowerCase().includes(String(launch.resume).toLowerCase())) ?? null;
      state.resume = resume?.id ?? launch.resume;
    } else if (launch.continue) {
      resume = latestSession(this.#cwd);
      if (resume) state.resume = resume.id;
    }
    if (state.resume) state.fork = launch.fork;
    else state.sessionId = launch.sessionId ?? randomUUID();
    await this.#start(state, resume?.path ?? (state.resume ? sessionFile(this.#cwd, state.resume) : null));
    if (launch.resume === true) this.#pickSession();
    else if (launch.prompt) void this.#submit(launch.prompt);
  }

  /**
   * Starts a `claude` process and reads what the surface needs from it. With
   * `transcript`, the stored conversation is drawn first (up to `leaf`).
   */
  async #start(state: SpawnState, transcript: string | null = null, leaf?: string): Promise<void> {
    const bin = stockPath();
    this.#starting = true;
    this.conv.reset();
    this.#fold.clear();
    this.#foldRev += 1;
    this.conv.sessionId = state.fork ? "" : (state.resume ?? state.sessionId ?? "");
    if (transcript && existsSync(transcript)) {
      try {
        this.conv.loadEntries(readEntries(transcript), leaf);
      } catch (error) {
        this.toast(`Could not read the session: ${(error as Error).message}`, "error");
      }
      if (!state.fork) this.conv.sessionId = state.resume ?? "";
    }
    if (state.name) this.conv.sessionName = state.name;
    this.schedule();
    const env: Record<string, string> = { ...(this.#autoCompact ? {} : { DISABLE_AUTO_COMPACT: "1" }), ...(this.#autoRetry ? {} : { CLAUDE_CODE_MAX_RETRIES: "0" }) };
    const cc = new Claude({ bin, args: [...(this.#suggestions ? ["--prompt-suggestions=true"] : []), ...spawnArgs(this.#launch, state)], cwd: this.#cwd, env });
    this.#cc = cc;
    cc.on("message", (record: Record<string, any>) => cc === this.#cc && this.#onMessage(record));
    cc.on("request", ({ id, request }: { id: string; request: Record<string, any> }) => cc === this.#cc && this.#onRequest(id, request));
    cc.on("cancel", (id: string) => cc === this.#cc && this.#onCancel(id));
    cc.on("error", (error: NodeJS.ErrnoException) => {
      if (cc !== this.#cc) return;
      this.#fatal(error.code === "ENOENT" ? `Could not run Claude Code at ${bin}. Install it on PATH or set CLAUDE_TSP_BIN.` : `Claude Code failed to start: ${error.message}`);
    });
    cc.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      if (this.#stopping || this.#swapping || cc !== this.#cc) return;
      const tail = cc.stderr.trim().slice(-1200);
      this.#fatal(`Claude Code exited (${signal ?? code})${tail ? `\n\n${tail}` : ""}`);
    });
    try {
      const init = await cc.request("initialize", { hooks: { PreToolUse: [{ matcher: "Bash", hookCallbackIds: ["trace"] }] }, promptSuggestions: this.#suggestions, agentProgressSummaries: true, forwardSubagentText: true, perTaskStopAffordance: true }, 60_000);
      if (cc !== this.#cc) return;
      this.#models = Array.isArray(init.models) ? init.models : [];
      this.#setCommands(init.commands);
      this.#agentTypes = Array.isArray(init.agents) ? init.agents : [];
      this.#account = init.account ?? {};
      this.#outputStyle = String(init.output_style ?? "default");
      this.#outputStyles = Array.isArray(init.available_output_styles) ? init.available_output_styles.map(String) : [];
      this.#claudeVersion = String(init.claude_code_version ?? "");
      if (init.current_permission_mode) this.conv.permissionMode = String(init.current_permission_mode);
      // This surface joins the session as one that draws what plugins render.
      this.#uiAttached = false;
      this.#uiBand = undefined;
      this.#uiPanes = [];
      this.#uiPanesKnown = false;
      void cc
        .request("ui_attach", { surface: UI_SURFACE, client_id: UI_CLIENT, viewport: { columns: 140, rows: 40, isFullscreen: true } }, 15_000)
        .then(() => {
          if (cc !== this.#cc) return;
          this.#uiAttached = true;
          void this.#refreshPluginUi();
        })
        .catch(() => undefined);
      await this.#refreshSettings(state.model ?? null);
      if (this.#thinkingOff) await cc.request("set_max_thinking_tokens", { max_thinking_tokens: 0 }).catch(() => undefined);
      await this.#refreshContext(true);
    } catch (error) {
      if (cc === this.#cc && !cc.exited) this.#fatal(`Claude Code did not answer: ${(error as Error).message}`);
      return;
    }
    if (!this.#claudeVersion) {
      execFile(bin, ["--version"], { timeout: 4000 }, (error, stdout) => {
        if (!error) this.#claudeVersion = stdout.trim().split(/\s+/)[0] ?? "";
        this.schedule();
      });
    }
    // Startup is over: Tern now sends what it kept while the composer was not ready.
    this.#starting = false;
    this.#lastError = "";
    this.#statusLineAt = 0;
    this.#runStatusLine();
    this.schedule();
  }

  /** Replaces the running process: a resume, a rewind, a fork, or a restart after the TUI had the session. */
  async #restart(state: SpawnState, transcript: string | null, leaf?: string): Promise<void> {
    this.#swapping = true;
    this.#denyAll();
    try {
      await this.#cc?.stop();
    } finally {
      this.#swapping = false;
    }
    await this.#start({ model: this.#modelValue || null, permissionMode: this.conv.permissionMode, effort: this.conv.effort || null, ...state }, transcript, leaf);
  }

  /** Starts the session's process again as it stands (a setting that Claude Code reads only at start changed). */
  async #respawn(): Promise<void> {
    if (this.conv.busy) await this.#interrupt();
    const id = this.conv.sessionId;
    const stored = id && existsSync(sessionFile(this.#cwd, id));
    await this.#restart(stored ? { resume: id } : { sessionId: randomUUID() }, stored ? sessionFile(this.#cwd, id) : null);
  }

  #setCommands(commands: unknown): void {
    this.#remote = (Array.isArray(commands) ? commands : []).map((command: any) => ({
      name: String(command.name),
      description: firstLine(String(command.description ?? ""), 200),
      icon: command.builtin === false ? "sparkles" : "terminal",
      ...(command.argumentHint ? { hint: String(command.argumentHint) } : {}),
    }));
  }

  /** The model and effort the session runs on, as Claude Code resolved them. */
  async #refreshSettings(asked: string | null = this.#modelValue || null): Promise<void> {
    const settings = await this.#cc.request("get_settings").catch(() => null);
    const applied = settings?.applied ?? {};
    if (applied.model) this.conv.model = String(applied.model);
    const line = settings?.effective?.statusLine;
    this.#statusLineCommand = line?.type === "command" && typeof line.command === "string" ? line.command : "";
    this.conv.effort = applied.effort ? String(applied.effort) : "";
    const wanted = asked ?? (typeof settings?.effective?.model === "string" ? settings.effective.model : null);
    const model = this.#models.find(entry => entry.value === wanted) ?? this.#models.find(entry => entry.value !== "default" && (entry.resolvedModel ?? entry.value) === this.conv.model) ?? this.#models.find(entry => (entry.resolvedModel ?? entry.value) === this.conv.model);
    this.#modelValue = model?.value ?? wanted ?? "";
    // claude-pi's local model takes its effort from the plugin, not from Claude Code.
    if (this.#local()) this.conv.effort = localEffort();
    this.conv.touch();
  }

  #modelInfo(): ModelInfo | undefined {
    return this.#models.find(entry => entry.value === this.#modelValue) ?? this.#models.find(entry => (entry.resolvedModel ?? entry.value) === this.conv.model);
  }

  /** A model as people name it: `Fable 5.2`, or the label a custom row gives it. */
  #modelName(model: ModelInfo | undefined = this.#modelInfo()): string {
    if (!model) return modelLabel(this.conv.model);
    if (/^claude-/.test(model.value)) return model.displayName || modelLabel(model.value);
    const resolved = modelLabel(model.resolvedModel ?? "");
    return resolved && !/^claude-/.test(resolved) ? resolved : firstLine(model.description.split(" · ")[0] ?? model.displayName, 40) || model.displayName;
  }

  #modelIcon(model: ModelInfo | undefined = this.#modelInfo()): string {
    const name = this.#modelName(model);
    // A custom row may stand for another maker's model (a local one, a ChatGPT one): its label says which.
    const maker = providerIcon("", name.toLowerCase());
    return maker && maker !== "provider:" ? maker : "provider:anthropic";
  }

  /** Whether the session runs on claude-pi's local model. */
  #local(model: ModelInfo | undefined = this.#modelInfo()): boolean {
    return PROFILE.pi && (model?.resolvedModel ?? model?.value ?? this.conv.model) === LOCAL_ALIAS;
  }

  #levels(model: ModelInfo | undefined = this.#modelInfo()): string[] {
    if (this.#local(model)) return [...LOCAL_EFFORTS];
    return model?.supportsEffort ? (model.supportedEffortLevels ?? []) : [];
  }

  /** What fills the context window, from Claude Code's own count. */
  async #refreshContext(force = false): Promise<void> {
    if (!force && Date.now() - this.#contextAt < 1500) return;
    this.#contextAt = Date.now();
    try {
      const usage = await this.#cc.request("get_context_usage", {}, 20_000);
      // An alias id reports the window of the Claude model it borrows; claude-pi knows the real one.
      const real = PROFILE.pi ? realWindow(this.conv.model) : undefined;
      if (real) this.conv.contextWindow = real;
      else if (typeof usage.maxTokens === "number") this.conv.contextWindow = usage.maxTokens;
      if (typeof usage.totalTokens === "number") this.conv.contextTokens = usage.totalTokens;
      this.conv.touch();
      this.schedule();
    } catch {
      /* the meter is a nicety */
    }
  }

  /**
   * Claude Code's configured status line (`statusLine.command` in its
   * settings): run as Claude Code runs it, with the session's facts as JSON on
   * stdin, and its first line drawn among the composer's facts.
   */
  #runStatusLine(): void {
    const key = "status line";
    if (!this.#statusLine || !this.#statusLineCommand) {
      if (this.conv.statuses.delete(key)) this.conv.touch();
      return;
    }
    if (Date.now() - this.#statusLineAt < 800) return;
    this.#statusLineAt = Date.now();
    const conv = this.conv;
    const model = this.#modelInfo();
    const input = {
      hook_event_name: "Status",
      session_id: conv.sessionId,
      transcript_path: conv.sessionId ? sessionFile(this.#cwd, conv.sessionId) : "",
      cwd: this.#cwd,
      model: { id: conv.model, display_name: model?.displayName ?? modelLabel(conv.model) },
      workspace: { current_dir: this.#cwd, project_dir: this.#cwd },
      version: this.#claudeVersion,
      output_style: { name: this.#outputStyle },
      cost: { total_cost_usd: conv.cost },
      effort: conv.effort,
      permission_mode: conv.permissionMode,
      context_window: { context_window_size: conv.contextWindow, used_percentage: conv.contextWindow ? Math.round((conv.contextTokens / conv.contextWindow) * 100) : 0, current_usage: { input_tokens: conv.contextTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
    };
    try {
      const child = spawn("sh", ["-c", this.#statusLineCommand], { cwd: this.#cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CLAUDE_CONFIG_DIR: configDir() } });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
      child.stdout.on("data", (chunk: Buffer) => (out = (out + chunk.toString("utf8")).slice(0, 4000)));
      child.stdin.on("error", () => undefined);
      child.on("error", () => clearTimeout(timer));
      child.on("close", () => {
        clearTimeout(timer);
        // eslint-disable-next-line no-control-regex
        const text = out.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "").split("\n").map(line => line.trim()).find(Boolean) ?? "";
        if (text) conv.statuses.set(key, text.slice(0, 160));
        else conv.statuses.delete(key);
        conv.touch();
        this.schedule();
      });
      child.stdin.end(JSON.stringify(input));
    } catch {
      /* a status line that cannot run is left out */
    }
  }

  /** Asks the plugins again for what they draw: the band above the prompt and each open pane. */
  async #refreshPluginUi(): Promise<void> {
    if (!this.#uiAttached || this.#cc.exited) return;
    const cc = this.#cc;
    const seq = ++this.#uiSeq;
    const ask = (component: string, instance: string, props: Record<string, unknown>): Promise<Record<string, any> | null> =>
      cc.request("ui_render", { surface: UI_SURFACE, client_id: UI_CLIENT, component, instance_id: instance, props }, 15_000).catch(() => null);
    const [band, listed] = await Promise.all([ask("AbovePrompt", "above-prompt", { hasSurvey: false, isCollapsed: false, isWorking: this.conv.busy, maxRows: 8 }), cc.request("ui_panes", { client_id: UI_CLIENT }, 15_000).catch(() => null)]);
    const panes: { id: string; title: string; plugin: string; tree?: UiNode }[] = (Array.isArray(listed?.panes) ? listed.panes : []).map((pane: any) => ({ id: String(pane.id), title: String(pane.title || pane.id), plugin: String(pane.plugin ?? "") }));
    await Promise.all(
      panes.map(async pane => {
        const tree = drawn(await ask("Pane", pane.id, { title: pane.title, isFocused: false, bodyColumns: 96, placement: "inline" }));
        if (tree !== undefined) pane.tree = tree;
      }),
    );
    // A later ask may have answered first.
    if (seq !== this.#uiSeq || cc !== this.#cc) return;
    // A pane a plugin has just opened comes forward, as it would in Claude Code's own window.
    const fresh = this.#uiPanesKnown ? panes.find(pane => !this.#uiPanes.some(old => old.id === pane.id)) : undefined;
    this.#uiPanesKnown = true;
    this.#uiBand = drawn(band);
    this.#uiPanes = panes;
    if (fresh && !this.#sheet) this.#openPane(fresh.id);
    this.schedule();
  }

  /** A Button a plugin drew was pressed: its closure runs in the plugin, then the drawing is asked for again. */
  #pluginPress = (target: UiPress): void => {
    void this.#cc
      .request("ui_press", { plugin: target.plugin, handle: target.handle, ...(target.key ? { key: target.key } : {}), surface: UI_SURFACE, client_id: UI_CLIENT }, 15_000)
      .catch(() => null)
      .then(() => this.#refreshPluginUi());
  };

  /** What plugins draw above the composer: their band, and a tab for each pane they opened. */
  #pluginBand(): Node | null {
    const band = this.#uiBand ? uiNodes(this.#uiBand, this.#pluginPress, "band") : [];
    const panes = this.#uiPanes.map(pane =>
      h("button", { key: `pane-${pane.id.replace(/[^\w-]/g, "_")}`, role: "omp.btn", text: pane.title, size: "sm", icon: "panel", title: `Open the ${pane.title} pane${pane.plugin ? ` (${pane.plugin})` : ""}`, onClick: () => this.#openPane(pane.id) }),
    );
    if (!band.length && !panes.length) return null;
    return h("col", { key: "plugin-ui", role: "claude.plugin.band", gap: "xs" }, [...band, panes.length ? h("row", { key: "panes", gap: "xs", wrap: true }, panes) : null]);
  }

  /** A pane a plugin opened, as a sheet; closing the sheet closes the pane for the plugin too. */
  #openPane(id: string): void {
    const find = (): { id: string; title: string; plugin: string; tree?: UiNode } | undefined => this.#uiPanes.find(pane => pane.id === id);
    const pane = find();
    if (!pane) return;
    this.#sheet = {
      id: "pane",
      head: pane.title,
      size: "md",
      body: () => {
        const now = find();
        const nodes = now?.tree ? uiNodes(now.tree, this.#pluginPress, "pane") : [];
        return nodes.length ? nodes : [h("text", { key: "empty", spans: [s(now ? "The plugin drew nothing in this pane." : "The plugin closed this pane.", "muted")] })];
      },
      extra: () => [
        h("button", {
          key: "shut",
          text: "Close pane",
          size: "md",
          title: "Close the pane for the plugin too",
          onClick: () => {
            this.#closeSheet();
            void this.#cc.request("ui_close", { id, client_id: UI_CLIENT }, 15_000).catch(() => null).then(() => this.#refreshPluginUi());
          },
        }),
      ],
    };
    this.schedule();
  }

  /** `/widgets`: what plugins draw, by keyboard: the buttons of their band and the panes they opened. */
  #pickWidgets(): void {
    const buttons = uiButtons(this.#uiBand);
    const items: PickerItem[] = [
      ...buttons.map((button, index) => ({ id: `b${index}`, label: button.label, detail: button.press.plugin, group: "buttons" })),
      ...this.#uiPanes.map((pane, index) => ({ id: `p${index}`, label: pane.title, detail: pane.plugin ? `pane · ${pane.plugin}` : "pane", group: "panes" })),
    ];
    this.#openPicker({
      props: { title: "Plugin widgets", subtitle: items.length ? `${buttons.length} buttons · ${this.#uiPanes.length} panes` : "No plugin draws anything here", icon: "plug", noun: "widgets", size: "md", layout: "rows", placeholder: "Search widgets…" },
      items,
      searchable: true,
      actions: [
        { id: "run", label: "Press", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No plugin draws anything here",
      choose: id => {
        this.#picker = null;
        const index = Number(id.slice(1));
        if (id.startsWith("b") && buttons[index]) this.#pluginPress(buttons[index]!.press);
        else if (id.startsWith("p") && this.#uiPanes[index]) this.#openPane(this.#uiPanes[index]!.id);
        this.schedule();
      },
    });
  }

  #fatal(message: string): void {
    this.conv.busy = false;
    this.conv.retry = null;
    if (this.#lastError !== message) {
      this.#lastError = message;
      this.conv.add({ kind: "notice", text: message, tone: "error" }, "n");
    }
    this.#starting = false;
    this.schedule();
  }

  async quit(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#tick) clearInterval(this.#tick);
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
    this.#saveHistory();
    this.#shellChild?.kill("SIGTERM");
    if (this.#replayTimer) clearInterval(this.#replayTimer);
    dropTraces();
    if (this.#rewindPage) await this.#rewindPage.close({ keep: false });
    await Promise.race([this.#cc?.stop() ?? Promise.resolve(), new Promise(done => setTimeout(done, 2600))]);
    await this.#session.close();
  }

  // ───────────────────────────────────────────────────────────── Claude's records

  #onMessage(record: Record<string, any>): void {
    if (record.session_id && typeof record.session_id === "string" && record.type !== "conversation_reset") this.conv.sessionId = record.session_id;
    switch (record.type) {
      case "conversation_reset":
        this.#denyAll();
        this.conv.reset();
        this.#fold.clear();
        this.#foldRev += 1;
        this.#attachments = [];
        void this.#refreshContext(true);
        break;
      case "system":
        if (record.subtype === "init") {
          this.#tools = Array.isArray(record.tools) ? record.tools.map(String) : this.#tools;
          this.#mcp = Array.isArray(record.mcp_servers) ? record.mcp_servers : this.#mcp;
          this.#plugins = Array.isArray(record.plugins) ? record.plugins : this.#plugins;
          if (record.output_style) this.#outputStyle = String(record.output_style);
          if (record.claude_code_version) this.#claudeVersion = String(record.claude_code_version);
          const before = this.conv.model;
          this.conv.onMessage(record);
          if (before !== this.conv.model) void this.#refreshSettings();
        } else if (record.subtype === "commands_changed") this.#setCommands(record.commands);
        else if (record.subtype === "ui_invalidate" || record.subtype === "ui_panes") void this.#refreshPluginUi();
        else if (record.subtype === "bridge_state") {
          // Remote control's connection: when it drops for good, the link is no longer worth showing.
          if (this.#remoteLink && /^(failed|disconnected|stopped|closed)$/.test(String(record.state))) {
            this.#remoteLink = null;
            if (this.#sheet?.id === "remote") this.#sheet = null;
            this.toast(`Remote control ${String(record.state)}${record.detail ? `: ${firstLine(String(record.detail), 160)}` : ""}`, "warning");
          }
        }
        else if (record.subtype === "ui_notify") this.toast(`${firstLine(record.title || record.plugin || "Plugin", 60)}: ${firstLine(record.text ?? "", 220)}`);
        else if (record.subtype === "ui_log") {
          if (record.text) this.conv.add({ kind: "notice", text: `${String(record.plugin ?? "plugin")}: ${String(record.text).slice(0, 2000)}`, tone: "muted" }, "n");
        }
        else this.conv.onMessage(record);
        break;
      case "result": {
        const wasBusy = this.conv.busy;
        this.conv.onMessage(record);
        this.#settlePending = true;
        void this.#refreshContext(true).then(() => this.#runStatusLine());
        void this.#refreshPluginUi();
        // A command Claude Code ran may have changed the model or effort under us.
        if (!wasBusy || record.num_turns === 0) void this.#refreshSettings().then(() => this.schedule());
        if (wasBusy && !this.#visible) this.#notify(`${PROFILE.name} is done`, firstLine(this.conv.lastAnswer(), 120));
        break;
      }
      case "user": {
        this.conv.onMessage(record);
        if (!this.#traceFiles.size || !Array.isArray(record.message?.content)) break;
        for (const block of record.message.content) {
          const file = block?.type === "tool_result" ? this.#traceFiles.get(String(block.tool_use_id)) : undefined;
          if (!file) continue;
          this.#traceFiles.delete(String(block.tool_use_id));
          const trace = takeTrace(file);
          const item = this.conv.findToolDeep(String(block.tool_use_id));
          if (trace && item) {
            item.details = { ...(item.details ?? {}), trace };
            this.conv.bump(item);
          }
        }
        break;
      }
      default:
        this.conv.onMessage(record);
    }
    this.schedule();
  }

  /** Claude Code asks the surface something: a permission, a question, an MCP server's form. */
  #onRequest(id: string, request: Record<string, any>): void {
    switch (request.subtype) {
      case "can_use_tool":
        if (request.tool_name === "AskUserQuestion") this.#ask(id, request);
        else this.#permit(id, request);
        break;
      case "elicitation":
        this.#elicit(id, request);
        break;
      case "hook_callback": {
        // Our one hook: with tracing on, a Bash call gets the prelude that records which lines run.
        const input = request.input ?? {};
        const command = input.tool_input?.command;
        const toolUseId = String(request.tool_use_id ?? input.tool_use_id ?? "");
        if (request.callback_id === "trace" && this.#traceCalls && toolUseId && typeof command === "string" && command.trim() && !usesTracing(command)) {
          const file = traceFile();
          this.#traceFiles.set(toolUseId, file);
          this.#cc.respond(id, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input.tool_input, command: traced(command, file) } } });
        } else this.#cc.respond(id, {});
        break;
      }
      default:
        this.#cc.respondError(id, `claude-tsp does not handle ${String(request.subtype)}`);
    }
    this.schedule();
  }

  /** Claude Code withdrew a request (the turn was interrupted, another client answered). */
  #onCancel(id: string): void {
    const approval = this.#approvals.find(entry => entry.id === id);
    if (approval) {
      this.#approvals.splice(this.#approvals.indexOf(approval), 1);
      this.conv.setAwaiting(approval.toolUseId, false);
    }
    const question = this.#questions.find(entry => entry.id === id);
    if (question) {
      this.#questions.splice(this.#questions.indexOf(question), 1);
      this.conv.setAwaiting(question.toolUseId, false);
    }
    this.schedule();
  }

  /** Answers every open request with a refusal: the session is ending or being replaced. */
  #denyAll(): void {
    for (const approval of this.#approvals.splice(0)) this.#cc?.respond(approval.id, { behavior: "deny", message: "The request was cancelled.", interrupt: true });
    for (const question of this.#questions.splice(0)) this.#cc?.respond(question.id, { behavior: "deny", message: "The questions were cancelled.", interrupt: true });
  }

  // ───────────────────────────────────────────────────────────── permissions

  /** A label for a rule Claude Code offers to save with the approval. */
  #suggestionLabel(suggestion: Record<string, any>): string {
    const where: Record<string, string> = { session: "this session", localSettings: "this project (just you)", projectSettings: "this project", userSettings: "all projects" };
    const scope = where[String(suggestion.destination)] ?? String(suggestion.destination ?? "");
    switch (suggestion.type) {
      case "setMode":
        return suggestion.mode === "acceptEdits" ? `Yes, and accept all edits for ${scope}` : `Yes, and switch to ${MODES[String(suggestion.mode)]?.label ?? suggestion.mode} mode`;
      case "addDirectories":
        return `Yes, and allow ${(suggestion.directories ?? []).map((dir: string) => showPath(dir, this.#cwd)).join(", ")} for ${scope}`;
      case "addRules":
      case "replaceRules": {
        const rules = (suggestion.rules ?? []).map((rule: any) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : String(rule.toolName)));
        return `Yes, and don't ask again for ${rules.join(", ")} in ${scope}`;
      }
      default:
        return `Yes, and remember for ${scope}`;
    }
  }

  /** What a call would do, drawn the way its result will be. */
  #preview(tool: string, input: Record<string, any>): (Node | null)[] {
    const path = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    switch (tool) {
      case "Bash":
        return [h("code", { key: "command", lang: "bash", wrap: true, text: untraced(String(input.command ?? "")) })];
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit": {
        const hunks = diffHunks({}, input.new_source !== undefined ? { old_string: "", new_string: String(input.new_source) } : input);
        return hunks.length ? [h("diff", { key: "diff", path: path || undefined, hunks })] : [h("text", { key: "path", truncate: "middle", spans: [s(showPath(path, this.#cwd), "mono", { href: fileHref(path, this.#cwd) })] })];
      }
      case "Write":
        return [h("code", { key: "content", path: path || undefined, numbers: true, wrap: true, text: String(input.content ?? "").slice(0, 60_000) })];
      case "ExitPlanMode":
        return [h("md", { key: "plan", role: "claude.plan", text: String(input.plan ?? "") })];
      case "WebFetch":
        return [h("text", { key: "url", wrap: "char", spans: [s(String(input.url ?? ""), "mono", /^https?:/.test(String(input.url)) ? { href: String(input.url) } : {})] }), input.prompt ? h("text", { key: "prompt", wrap: "word", spans: [s(firstLine(input.prompt, 300), "muted")] }) : null];
      case "WebSearch":
        return [h("text", { key: "query", wrap: "word", spans: [s(String(input.query ?? ""), "mono")] })];
      case "Read":
      case "Glob":
      case "Grep":
      case "LS":
        return [h("text", { key: "what", wrap: "char", spans: [s([input.pattern, path ? showPath(path, this.#cwd) : ""].filter(Boolean).join("  in  "), "mono")] })];
      default: {
        const keys = Object.keys(input);
        if (!keys.length) return [];
        return [this.#session.caps.kinds.includes("json") ? h("json", { key: "input", value: input as never }) : h("code", { key: "input", lang: "json", wrap: true, text: JSON.stringify(input, null, 2).slice(0, 20_000) })];
      }
    }
  }

  /** A tool permission request, as the approval panel above the composer. */
  #permit(id: string, request: Record<string, any>): void {
    const tool = String(request.tool_name ?? "tool");
    const input: Record<string, any> = request.input && typeof request.input === "object" ? request.input : {};
    const toolUseId = String(request.tool_use_id ?? "");
    const allow = (extra: Record<string, any> = {}) => (): Record<string, any> => ({ behavior: "allow", updatedInput: input, ...extra });
    const deny = (message: string, interrupt: boolean) => (): Record<string, any> => ({ behavior: "deny", message, interrupt });
    const refusal = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
    let title: string;
    let choices: Choice[];
    if (tool === "ExitPlanMode") {
      title = "Ready to code? Here is Claude's plan";
      choices = [
        ...(this.#models.find(model => model.value === this.#modelValue)?.supportsAutoMode ? [{ id: "auto", label: "Yes, and use auto mode", deny: false, answer: allow({ updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] }) }] : []),
        { id: "edits", label: "Yes, and accept edits automatically", deny: false, answer: allow({ updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }) },
        { id: "manual", label: "Yes, and approve each edit", deny: false, answer: allow({ updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] }) },
        { id: "tell", label: "No, keep planning: tell Claude what to change", deny: true, answer: null },
      ];
    } else {
      const display = String(request.display_name ?? toolTitle(tool));
      const verb: Record<string, string> = { Bash: "Run this command?", Edit: "Make this edit?", MultiEdit: "Make these edits?", Write: input.file_path && existsSync(String(input.file_path)) ? "Overwrite this file?" : "Create this file?", NotebookEdit: "Edit this notebook?", WebFetch: "Fetch this page?", WebSearch: "Search the web?", Read: "Read this file?" };
      title = request.title ? String(request.title) : (verb[tool] ?? `Allow ${display}?`);
      const suggestions: Record<string, any>[] = request.suppress_always_allow_rule ? [] : Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
      choices = [
        { id: "yes", label: "Yes", deny: false, answer: allow() },
        ...suggestions.slice(0, 3).map((suggestion, index) => ({ id: `s${index}`, label: this.#suggestionLabel(suggestion), deny: false, answer: allow({ updatedPermissions: [suggestion] }) })),
        { id: "no", label: "No", deny: true, detail: "stops the turn", answer: deny(refusal, true) },
        { id: "tell", label: "No, and tell Claude what to do instead", deny: true, answer: null },
      ];
    }
    const shownPath = String(input.file_path ?? input.notebook_path ?? "");
    const details = [request.description && tool !== "Bash" && !(shownPath && shownPath.endsWith(String(request.description))) ? String(request.description) : "", typeof input.description === "string" && tool === "Bash" ? input.description : "", request.blocked_path ? `Outside the allowed folders: ${showPath(String(request.blocked_path), this.#cwd)}` : ""].filter(Boolean);
    // eslint-disable-next-line no-control-regex
    const reason = request.decision_reason ? String(request.decision_reason).replace(/\x1b\[[0-9;]*m/g, "") : "";
    const agent = request.agent_id ? this.conv.agents().find(item => item.taskId === request.agent_id) : undefined;
    const lines = tool === "Bash" ? String(input.command ?? "").split("\n").length : tool === "Write" ? String(input.content ?? "").split("\n").length : JSON.stringify(input).length / 80;
    const approval: Approval = {
      id,
      toolUseId,
      title,
      ...(request.agent_id ? { origin: `subagent${agent?.agentType ? ` · ${agent.agentType}` : ""}` } : {}),
      ...(reason && request.decision_reason_type !== "mode" ? { reason } : {}),
      preview: () => this.#preview(tool, input),
      details,
      choices,
      selected: request.default_to_no ? "no" : choices[0]!.id,
      expanded: false,
      expandable: lines > 12 || tool === "ExitPlanMode" || tool === "Edit" || tool === "MultiEdit",
    };
    this.#approvals.push(approval);
    this.conv.setAwaiting(toolUseId, true);
    if (!this.#visible) this.#notify(`${PROFILE.name} needs your approval`, `${title} ${firstLine(input.command ?? input.file_path ?? input.url ?? "", 100)}`);
  }

  /** Answers an approval with one of its choices; `null` refuses and stops the turn. */
  #answerApproval(approval: Approval, choiceId: string | null): void {
    const choice = approval.choices.find(entry => entry.id === choiceId);
    const settle = (response: Record<string, any>): void => {
      const at = this.#approvals.indexOf(approval);
      if (at < 0) return;
      this.#approvals.splice(at, 1);
      this.conv.setAwaiting(approval.toolUseId, false);
      this.#cc.respond(approval.id, { ...response, toolUseID: approval.toolUseId });
      this.schedule();
    };
    if (!choice) return settle({ behavior: "deny", message: "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed.", interrupt: true });
    if (choice.answer) return settle(choice.answer());
    // "No, and tell Claude…": the refusal carries what the user types.
    this.#openField({
      title: "What should Claude do instead?",
      detail: "Your note is sent with the refusal; the turn goes on.",
      placeholder: "Tell Claude what to change",
      multiline: false,
      text: "",
      done: value => {
        if (value === null) return;
        settle({ behavior: "deny", message: value.trim() ? `The user doesn't want to proceed with this tool use. The tool use was rejected. The user said:\n${value.trim()}` : "The user doesn't want to proceed with this tool use. The tool use was rejected.", interrupt: !value.trim() });
      },
    });
  }

  // ───────────────────────────────────────────────────────────── questions

  /** AskUserQuestion: the question panel takes the composer's place. */
  #ask(id: string, request: Record<string, any>): void {
    const input: Record<string, any> = request.input && typeof request.input === "object" ? request.input : {};
    const questions = (Array.isArray(input.questions) ? input.questions : []).map((question: any) => ({
      question: String(question?.question ?? ""),
      header: String(question?.header ?? ""),
      multi: Boolean(question?.multiSelect),
      options: (Array.isArray(question?.options) ? question.options : []).map((option: any) => ({ label: String(option?.label ?? ""), description: String(option?.description ?? "") })),
    }));
    if (!questions.length) {
      this.#cc.respond(id, { behavior: "allow", updatedInput: input });
      return;
    }
    this.#questions.push({ id, toolUseId: String(request.tool_use_id ?? ""), input, questions, at: 0, picked: questions.map(() => new Set<string>()), other: questions.map(() => ""), selected: 0, editor: null });
    this.conv.setAwaiting(String(request.tool_use_id ?? ""), true);
    this.#completion = null;
    if (!this.#visible) this.#notify(`${PROFILE.name} has a question`, firstLine(questions[0]!.question, 120));
  }

  #finishQuestion(question: Question, answered: boolean): void {
    const at = this.#questions.indexOf(question);
    if (at < 0) return;
    this.#questions.splice(at, 1);
    this.conv.setAwaiting(question.toolUseId, false);
    const answers: Record<string, string> = {};
    if (answered) {
      question.questions.forEach((entry, index) => {
        const parts = [...question.picked[index]!, ...(question.other[index]!.trim() ? [question.other[index]!.trim()] : [])];
        if (parts.length) answers[entry.question] = parts.join(", ");
      });
    }
    this.#cc.respond(question.id, { behavior: "allow", updatedInput: { ...question.input, answers }, toolUseID: question.toolUseId });
    this.schedule();
  }

  /** The options of the question shown now, the free answer last. */
  #questionOptions(question: Question): { id: string; label: string; detail?: string; checked: boolean }[] {
    const entry = question.questions[question.at]!;
    const picked = question.picked[question.at]!;
    const other = question.other[question.at]!;
    return [
      ...entry.options.map((option, index) => ({ id: `o${index}`, label: option.label, ...(option.description ? { detail: option.description } : {}), checked: picked.has(option.label) })),
      { id: "other", label: other ? `Other: ${firstLine(other, 60)}` : "Other…", detail: "Type your own answer", checked: Boolean(other) },
    ];
  }

  /** Takes option `index` of the question shown: a single choice moves on, a multiple one toggles. */
  #takeOption(question: Question, index: number): void {
    const entry = question.questions[question.at]!;
    question.selected = index;
    if (index >= entry.options.length) {
      question.editor = new TextEditor();
      question.editor.set(question.other[question.at]!);
      return;
    }
    const picked = question.picked[question.at]!;
    const label = entry.options[index]!.label;
    if (entry.multi) {
      if (picked.has(label)) picked.delete(label);
      else picked.add(label);
      return;
    }
    picked.clear();
    picked.add(label);
    question.other[question.at] = "";
    this.#nextQuestion(question);
  }

  #nextQuestion(question: Question): void {
    if (question.editor) {
      question.other[question.at] = question.editor.text.trim();
      if (question.other[question.at] && !question.questions[question.at]!.multi) question.picked[question.at]!.clear();
      question.editor = null;
    }
    if (question.at >= question.questions.length - 1) return this.#finishQuestion(question, true);
    question.at += 1;
    question.selected = 0;
  }

  #questionKey(question: Question, key: Key): boolean {
    const options = this.#questionOptions(question);
    if (question.editor) {
      if (key.name === "escape") {
        question.editor = null;
        return true;
      }
      if (key.name === "enter") {
        this.#nextQuestion(question);
        return true;
      }
      this.#textKey(question.editor, key, false);
      return true;
    }
    switch (key.name) {
      case "up":
        question.selected = Math.max(0, question.selected - 1);
        return true;
      case "down":
        question.selected = Math.min(options.length - 1, question.selected + 1);
        return true;
      case "space":
        this.#takeOption(question, question.selected);
        return true;
      case "enter":
        if (question.questions[question.at]!.multi && question.selected < options.length - 1) this.#nextQuestion(question);
        else this.#takeOption(question, question.selected);
        return true;
      case "tab":
        if (key.shift) {
          if (question.at > 0) question.at -= 1;
          question.selected = 0;
        } else this.#nextQuestion(question);
        return true;
      case "escape":
        this.#finishQuestion(question, false);
        return true;
      default:
        if (!key.ctrl && !key.alt && /^[1-9]$/.test(key.name) && Number(key.name) <= options.length) {
          this.#takeOption(question, Number(key.name) - 1);
          return true;
        }
        return true;
    }
  }

  /** An MCP server asks for input: a link to open, or a form filled one field at a time. */
  #elicit(id: string, request: Record<string, any>): void {
    const server = String(request.display_name ?? request.mcp_server_name ?? "MCP server");
    const title = `${server}: ${firstLine(request.message ?? request.title ?? "needs your input", 160)}`;
    if (request.mode === "url" && request.url) {
      this.#openPicker({
        props: { title, subtitle: String(request.url), noun: "options", size: "md", layout: "rows", preview: "none" },
        items: [
          { id: "accept", label: "I have opened the link and finished there", detail: String(request.url) },
          { id: "copy", label: "Copy the link" },
          { id: "decline", label: "Decline" },
        ],
        searchable: false,
        actions: [
          { id: "confirm", label: "Select", keys: ["enter"], primary: true },
          { id: "close", label: "Cancel", keys: ["esc"], end: true },
        ],
        choose: (choice, picker) => {
          if (choice === "copy") return this.copy(String(request.url), "Link");
          picker.options.cancel = undefined;
          this.#picker = null;
          this.#cc.respond(id, { action: choice === "accept" ? "accept" : "decline" });
        },
        cancel: () => this.#cc.respond(id, { action: "cancel" }),
      });
      return;
    }
    const properties: Record<string, any> = request.requested_schema?.properties && typeof request.requested_schema.properties === "object" ? request.requested_schema.properties : {};
    const order: string[] = Array.isArray(request.property_order) ? request.property_order.filter((name: string) => name in properties) : Object.keys(properties);
    const content: Record<string, unknown> = {};
    const step = (index: number): void => {
      const name = order[index];
      if (name === undefined) {
        this.#cc.respond(id, { action: "accept", content });
        return;
      }
      const schema = properties[name] ?? {};
      this.#openField({
        title: `${server}: ${String(schema.title ?? name)}`,
        detail: [firstLine(request.message ?? "", 200), schema.description ? String(schema.description) : "", Array.isArray(schema.enum) ? `One of: ${schema.enum.join(", ")}` : ""].filter(Boolean).join("\n"),
        placeholder: schema.type === "boolean" ? "yes or no" : String(schema.default ?? ""),
        multiline: false,
        text: schema.default !== undefined ? String(schema.default) : "",
        done: value => {
          if (value === null) return this.#cc.respond(id, { action: "cancel" });
          const text = value.trim();
          content[name] = schema.type === "boolean" ? /^(y|yes|true|1)$/i.test(text) : schema.type === "number" || schema.type === "integer" ? Number(text) : text;
          step(index + 1);
        },
      });
    };
    if (!order.length) this.#cc.respond(id, { action: "accept", content: {} });
    else step(0);
  }

  // ───────────────────────────────────────────────────────────── rendering

  /**
   * Tern paces frames by acknowledging them. If an acknowledgement is lost
   * the surface would wait for it forever, so after five seconds of waiting
   * the outstanding frames are taken as received and drawing goes on.
   */
  #unstall(): void {
    if (!this.#surface.blocked) {
      this.#blockedSince = 0;
      return;
    }
    this.#blockedSince ||= Date.now();
    if (Date.now() - this.#blockedSince < 5000) return;
    this.#blockedSince = 0;
    this.#surface.acknowledge(this.#surface.seq);
  }

  /** Redraws soon; many changes in one tick make one frame. */
  schedule(): void {
    this.#unstall();
    if (this.#renderTimer || this.#stopping) return;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      this.render();
    }, 16);
  }

  #blob = (image: { data?: string; mimeType?: string }): string | undefined => {
    if (!image?.data || !this.#session.caps.features.includes("blobs")) return undefined;
    const known = this.#blobs.get(image);
    if (known) return known;
    try {
      const id = this.#session.blob(Buffer.from(image.data, "base64"), image.mimeType || "image/png");
      this.#blobs.set(image, id);
      return id;
    } catch {
      return undefined;
    }
  };

  #logoBlob: string | undefined;
  /** The two spacers around the welcome block: the same nodes every frame. */
  #mainHead = { top: h("spacer", { key: "top", size: "sm" }), gap: h("spacer", { key: "gap", size: "sm" }) };
  #welcomeNode: { sig: string; node: Node } | null = null;

  #logo(): string | undefined {
    if (!this.#session.caps.features.includes("blobs")) return undefined;
    try {
      this.#logoBlob ??= this.#session.blob(Buffer.from(LOGO_SVG, "utf8"), "image/svg+xml");
    } catch {
      return undefined;
    }
    return this.#logoBlob;
  }

  #accountLine(): string {
    const plan = this.#account.subscriptionType ? `Claude ${String(this.#account.subscriptionType).replace(/^claude\s+/i, "").replace(/^./, ch => ch.toUpperCase())}` : this.#account.apiProvider && this.#account.apiProvider !== "firstParty" ? String(this.#account.apiProvider) : "";
    return [plan, this.#account.organization && !/'s Organization$/.test(String(this.#account.organization)) ? String(this.#account.organization) : ""].filter(Boolean).join(" · ");
  }

  #welcome(): Node {
    const logo = this.#logo();
    const sig = `${this.#claudeVersion}|${logo}|${this.#accountLine()}`;
    if (this.#welcomeNode?.sig !== sig) this.#welcomeNode = { sig, node: welcome({ name: PROFILE.name, version: VERSION, claudeVersion: this.#claudeVersion, tip: this.#tip, account: this.#accountLine(), logo }) };
    return this.#welcomeNode.node;
  }

  #viewCtx(): ViewCtx {
    return {
      cwd: this.#cwd,
      kinds: new Set(this.#session.caps.kinds),
      hour12: this.#session.caps.hour12,
      expandAll: this.#expandAll,
      hideThinking: this.#hideThinking,
      showImages: this.#showImages,
      showUsage: this.#showUsage,
      showCharts: this.#showCharts,
      compactTools: this.#compactTools,
      fold: this.#fold,
      shell: this.#shellPrefs,
      foldRev: this.#foldRev,
      blob: this.#blob,
      on: {
        toggle: (id, collapsed) => {
          this.#fold.set(id, collapsed);
          this.#foldRev += 1;
          this.schedule();
        },
        copy: (text, what) => this.copy(text, what),
        rewind: item => void this.#rewindTo(item),
        editTurn: item => {
          this.editor.set(item.text);
          this.toast("Message copied to the composer");
        },
        retry: () => void this.#retry(),
        pickModel: () => this.#pickModel(),
        login: () => void this.#login(""),
        openAgent: item => this.#openAgent(item),
        stopTask: item => void this.#stopTask(item.taskId ?? "", firstLine(item.args?.description ?? "subagent", 60)),
        open: () => undefined,
        shell: (id, value) => this.#shellControl(id, value),
      },
    };
  }

  /**
   * A control of a command pane: how it is shown, and the replay of its run.
   * Replay moves a cursor through the trace's steps, one per 80 ms when
   * playing, and the pane is redrawn as the run stood at that step.
   */
  #shellControl(id: string, value: string): void {
    const item = this.conv.items.find(entry => entry.id === id) ?? this.conv.agents().flatMap(agent => agent.sub?.items ?? []).find(entry => entry.id === id);
    const steps: number = item?.details?.trace?.steps?.length ?? 0;
    const prefs: ShellPrefs = { ...(this.#shellPrefs.get(id) ?? { view: "pseudo", color: true }) };
    const [verb, arg] = value.split(":");
    switch (verb) {
      case "view":
        if (arg === "raw" || arg === "pseudo") prefs.view = arg;
        break;
      case "layer":
        if (arg === "color") prefs.color = !prefs.color;
        break;
      case "inspect":
        if (item) this.#inspectShell(item);
        return;
      case "play":
        if (!steps) return;
        if (prefs.cursor === undefined || prefs.cursor >= steps) prefs.cursor = 0;
        prefs.playing = true;
        break;
      case "pause":
        prefs.playing = false;
        break;
      case "step":
        prefs.playing = false;
        prefs.cursor = Math.min(steps, (prefs.cursor ?? 0) + 1);
        break;
      case "reset":
        prefs.playing = false;
        prefs.cursor = 0;
        break;
      case "live":
        prefs.playing = false;
        delete prefs.cursor;
        break;
      case "seek":
        prefs.playing = false;
        prefs.cursor = Math.max(0, Math.min(steps, Number(arg) || 0));
        break;
      case "speed":
        prefs.speed = Math.max(0.25, Math.min(8, Number(arg) || 1));
        break;
      default:
        return;
    }
    this.#shellPrefs.set(id, prefs);
    this.#foldRev += 1;
    const playing = [...this.#shellPrefs.values()].some(entry => entry.playing);
    if (playing && !this.#replayTimer) this.#replayTimer = setInterval(() => this.#replayTick(), 80);
    this.schedule();
  }

  #replayTick(): void {
    let playing = false;
    const all = [...this.conv.items, ...this.conv.agents().flatMap(agent => agent.sub?.items ?? [])];
    for (const [id, prefs] of this.#shellPrefs) {
      if (!prefs.playing) continue;
      const steps: number = all.find(entry => entry.id === id)?.details?.trace?.steps?.length ?? 0;
      const next = (prefs.cursor ?? 0) + Math.max(1, Math.round(prefs.speed ?? 1));
      // At the end the pane goes back to showing the finished run.
      if (next >= steps) this.#shellPrefs.set(id, { ...prefs, playing: false, cursor: steps });
      else {
        this.#shellPrefs.set(id, { ...prefs, cursor: next });
        playing = true;
      }
    }
    if (!playing && this.#replayTimer) {
      clearInterval(this.#replayTimer);
      this.#replayTimer = null;
    }
    this.#foldRev += 1;
    this.schedule();
  }

  /** The command pane on a sheet of its own, with the replay controls and the whole output. */
  #inspectShell(item: Item): void {
    const script = String(item.kind === "tool" ? (item.args?.command ?? "") : item.text).trimEnd();
    this.#inspecting = item.id;
    this.#sheet = {
      id: "shell",
      head: firstLine(script, 80) || "Command",
      size: "lg",
      body: () => [
        commandPane(item, script, "omp.tool.bash", this.#viewCtx(), true),
        item.output ? h("ansi", { key: "output", role: "omp.tool.bash.output", text: item.output.slice(-200_000), preview: { lines: 16 } }) : null,
        !item.details?.trace ? h("text", { key: "note", wrap: "word", spans: [s(item.kind === "bash" ? "This run was not traced (bash 5 is needed), so there are no steps to replay." : "This run was not traced, so there are no steps to replay. /trace turns tracing of Claude's Bash calls on.", "muted")] }) : null,
      ],
      extra: () => [h("button", { key: "copy", text: "Copy output", size: "md", onClick: () => this.copy(item.output ?? "", "Output") })],
    };
    this.schedule();
  }

  #inspectLast(): void {
    const last = this.conv.items.findLast(item => (item.kind === "tool" && item.name === "Bash") || item.kind === "bash");
    if (last) this.#inspectShell(last);
    else this.toast("No shell command in this session yet", "warning");
  }

  #activity(): string {
    if (this.#approvals.length) return "Waiting for your approval";
    if (this.#questions.length) return "Waiting for your answer";
    for (let index = this.conv.items.length - 1; index >= 0; index -= 1) {
      const item = this.conv.items[index]!;
      if (item.kind === "user") break;
      if (item.kind === "agent" && !item.background && (item.agentStatus === "running" || item.agentStatus === "pending")) return `Running ${item.agentType && item.agentType !== "general-purpose" ? item.agentType : "a subagent"}${item.activity ? `: ${firstLine(item.activity, 50)}` : ""}`;
      if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) return toolActivity({ ...item, args: { ...item.args, ...(item.args?.file_path ? { file_path: showPath(String(item.args.file_path), this.#cwd) } : {}) } });
      if (item.kind === "thinking" && item.status === "running") return "Thinking";
      if (item.kind === "assistant" && item.status === "running") return "Writing";
    }
    if (this.conv.hook) return `Running hook ${firstLine(this.conv.hook, 60)}`;
    return this.conv.shell ? `Running ${firstLine(this.conv.shell.text, 60)}` : "Working";
  }

  #blocked(): boolean {
    return Boolean(this.#picker || this.#approvals.length || this.#questions.length || this.#field || this.#sheet || this.#prefs || this.#rewind);
  }

  #dockState(): DockState {
    return {
      editor: this.editor,
      attachments: this.#attachments,
      vimMode: this.#vimKeys ? this.#vim.label : "",
      drawn: this.#vimKeys ? this.#vim.drawn() : null,
      modelName: this.#modelName(),
      modelIcon: this.#modelIcon(),
      effort: this.#thinkingOff ? "off" : this.conv.effort,
      reasoning: this.#levels().length > 1 || this.#thinkingOff,
      blocked: this.#blocked(),
      starting: this.#starting,
      activity: this.#activity(),
      showTasks: this.#showTasks,
      stashed: Boolean(this.#stash),
      blob: this.#blob,
    };
  }

  #dockActions(): DockActions {
    return {
      submit: () => void this.#submit(),
      interrupt: () => void this.#interrupt(),
      pickModel: () => this.#pickModel(),
      cycleEffort: () => void this.#cycleEffort(),
      cycleMode: () => void this.#cycleMode(),
      showContext: () => void this.#showContext(),
      showSession: () => void this.#showSession(),
      showUsage: () => void this.#showUsage_(),
      showBackground: () => this.#pickBackground(),
      dequeue: () => void this.#dequeue(),
      detach: index => {
        this.#attachments.splice(index, 1);
        this.schedule();
      },
      edit: event => {
        if (this.editor.applyEdit(event)) this.#updateCompletion();
        this.schedule();
      },
      undo: () => {
        this.editor.undo();
        this.schedule();
      },
      send: event => {
        // An explicit prompt from Tern: blank is a no-op, and the draft it
        // replaces is kept for recall rather than lost.
        const text = event.text ?? "";
        if (!text.trim() || this.#blocked()) return;
        if (this.editor.text.trim()) this.editor.remember(this.editor.expanded());
        this.editor.clear();
        void this.#submit(text);
      },
    };
  }

  render(): void {
    if (this.#stopping || this.#surface.closed) return;
    const ctx = this.#viewCtx();
    const conv = this.conv;
    const built = this.#transcript.build(conv, ctx);
    const blocks = new Set(built.map(node => String(node.props["key"])));
    const rewind = this.#rewind;
    const main: Node[] = [this.#mainHead.top, this.#welcome(), this.#mainHead.gap, ...built];
    const approval = this.#approvals[0];
    const above = approval
      ? approvalPanel(
          { title: approval.title, ...(approval.origin ? { origin: approval.origin } : {}), ...(approval.reason ? { reason: approval.reason } : {}), preview: approval.preview(), details: approval.details, choices: approval.choices, selected: approval.selected, expanded: approval.expanded, expandable: approval.expandable },
          {
            take: id => this.#answerApproval(approval, id),
            approve: () => this.#answerApproval(approval, approval.choices.find(choice => !choice.deny)?.id ?? null),
            deny: () => this.#answerApproval(approval, null),
            expand: () => {
              approval.expanded = !approval.expanded;
              this.schedule();
            },
          },
        )
      : null;
    // A turn that ended on an error keeps it in view above the composer until the next turn.
    const failed = conv.busy ? undefined : conv.items.findLast(item => item.kind !== "usage");
    const pinned = failed?.kind === "error" ? failed : undefined;
    if (pinned && this.#banner.id !== pinned.id) this.#banner = { id: pinned.id, expanded: false, dismissed: false };
    const banner =
      pinned && !this.#banner.dismissed
        ? errorBanner(pinned.text, this.#banner.expanded, {
            details: () => ((this.#banner.expanded = !this.#banner.expanded), this.schedule()),
            dismiss: () => ((this.#banner.dismissed = true), this.schedule()),
          })
        : null;
    const field = this.#field;
    const question = field ? undefined : this.#questions[0];
    if (rewind) this.#renderRewind(rewind, built);
    const instead = field
      ? fieldDialog(
          { title: field.title, detail: field.detail, placeholder: field.placeholder, multiline: field.multiline, editor: field.editor, ...(field.link ? { link: field.link } : {}) },
          {
            submit: () => this.#closeField(field.editor.text),
            cancel: () => this.#closeField(null),
            edit: (event: EditEvent) => {
              field.editor.applyEdit(event);
              this.schedule();
            },
            undo: () => {
              field.editor.undo();
              this.schedule();
            },
          },
        )
      : question
        ? questionPanel(
            {
              index: question.at,
              total: question.questions.length,
              header: question.questions[question.at]!.header,
              question: question.questions[question.at]!.question,
              multi: question.questions[question.at]!.multi,
              options: this.#questionOptions(question),
              selected: this.#questionOptions(question)[question.selected]?.id ?? "o0",
              other: question.editor,
              answered: question.picked.filter(set => set.size).length,
            },
            {
              take: id => {
                const index = this.#questionOptions(question).findIndex(option => option.id === id);
                if (index >= 0) this.#takeOption(question, index);
                this.schedule();
              },
              next: () => (this.#nextQuestion(question), this.schedule()),
              back: () => {
                if (question.at > 0) question.at -= 1;
                question.selected = 0;
                question.editor = null;
                this.schedule();
              },
              cancel: () => this.#finishQuestion(question, false),
              edit: (event: EditEvent) => {
                question.editor?.applyEdit(event);
                this.schedule();
              },
              undo: () => {
                question.editor?.undo();
                this.schedule();
              },
            },
          )
        : null;
    const layer: (Node | null)[] = [];
    const completion = this.#completion;
    if (completion && !this.#blocked()) layer.push(completionPopup(completion.items, completion.selected, index => this.#acceptCompletion(index, true)));
    if (this.#picker) {
      const picker = this.#picker;
      layer.push(
        pickerNode(picker.view(), {
          select: id => {
            picker.selected = id;
            picker.confirm = null;
            this.schedule();
          },
          activate: id => {
            picker.selected = id;
            void this.#choose(picker);
          },
          change: () => undefined,
        }),
      );
    }
    if (this.#prefs) layer.push(this.#prefsView());
    if (this.#sheet) {
      const open = this.#sheet;
      layer.push(sheet(open.id, open.head, open.size, open.body(), () => this.#closeSheet(), open.extra?.() ?? []));
    }
    layer.push(...toastNodes(this.#toasts));
    this.#surface.render({ dock: dock(conv, this.#dockState(), this.#dockActions(), [banner, field ? null : above, field || above ? null : this.#pluginBand()], instead), layer: h("col", { key: "layer" }, layer) });

    const mainOps = this.#main.ops(main, this.#surface.id);
    if (mainOps.length) this.#surface.send(mainOps);
    if (this.#settlePending && !conv.busy) {
      this.#settlePending = false;
      if (this.#session.caps.features.includes("settle")) {
        const live = new Set<string>();
        for (const item of conv.items) {
          live.add(item.id);
          const done = item.kind === "agent" ? item.agentStatus !== "running" && item.agentStatus !== "pending" : item.status !== "running" && item.status !== "pending";
          // Only a block's first item is a node of `main`; the rest live inside it.
          if (done && !this.#settled.has(item.id) && blocks.has(item.id)) {
            this.#settled.add(item.id);
            this.#surface.settle(`main.${item.id}`);
          }
        }
        for (const id of this.#settled) if (!live.has(id)) this.#settled.delete(id);
      }
    }
    const focus = this.#picker || this.#prefs || this.#sheet || this.#rewind ? null : field ? fieldInputId(field.multiline) : question ? (question.editor ? QUESTION_INPUT_ID : null) : EDITOR_ID;
    if (focus !== this.#focus) {
      this.#focus = focus;
      this.#surface.focus(focus);
    }
    // The retry wait counts down without an event to cause it.
    const ticking = Boolean(conv.retry);
    if (ticking && !this.#tick) this.#tick = setInterval(() => this.schedule(), 500);
    else if (!ticking && this.#tick) {
      clearInterval(this.#tick);
      this.#tick = null;
    }
  }

  toast(text: string, tone: Toast["tone"] = "info", action?: Toast["action"]): void {
    if (!text) return;
    const toast: Toast = { id: ++this.#toastSeq, text: text.length > 300 ? `${text.slice(0, 299)}…` : text, tone, ...(action ? { action } : {}) };
    this.#toasts.push(toast);
    setTimeout(
      () => {
        this.#toasts = this.#toasts.filter(entry => entry !== toast);
        this.schedule();
      },
      action ? 6200 : 2600,
    );
    this.schedule();
  }

  /** Copies through the terminal's clipboard (OSC 52). */
  copy(text: string, what = "Text"): void {
    if (!text) {
      this.toast("Nothing to copy", "warning");
      return;
    }
    process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
    this.toast(`${what} copied`);
  }

  /** A desktop notification (OSC 99) for a pane the user is not looking at. */
  #notify(title: string, body: string): void {
    if (process.env.CLAUDE_TSP_NOTIFICATIONS === "0") return;
    const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, " ");
    process.stdout.write(`\x1b]99;i=claude:d=0:p=title;${clean(title)}\x1b\\\x1b]99;i=claude:d=1:p=body;${clean(body)}\x1b\\`);
  }

  // ───────────────────────────────────────────────────────────── TSP events

  #onEvent(event: TspEvent): void {
    // The transcript is outside the SDK's view, so its nodes' handlers are run here.
    if (this.#main.dispatch(event)) return;
    switch (event.ev) {
      case "visible":
        this.#visible = event.visible;
        break;
      case "resize":
        if (typeof event.visible === "boolean") this.#visible = event.visible;
        break;
      case "toggle":
        // A fold with no handler of its own: remember it by node id so a redraw keeps it.
        this.#fold.set(event.id.split(".").at(-1) ?? event.id, event.collapsed === true);
        break;
      case "action":
        if (event.id === "layer.picker" && this.#picker) void this.#pickerAction(this.#picker, event.act, typeof event.value === "string" ? event.value : undefined);
        else if (event.id === "layer.prefs" && this.#prefs) this.#prefsAction(event.act, typeof event.value === "string" ? event.value : undefined);
        break;
      case "select":
        if (event.id === "layer.prefs" && this.#prefs) this.#prefs.focus = event.item;
        break;
      case "change":
        if (event.id === "layer.prefs" && this.#prefs) void this.#prefsChange(String(event.item), event.value);
        break;
      case "error":
        // Tern rejected an op, so its document and ours may differ: send the
        // whole view again, at most once a few seconds.
        if (Date.now() - this.#resyncAt > 3000) {
          this.#resyncAt = Date.now();
          this.#main.reset();
          this.#surface.render(null);
          this.#focus = undefined;
        }
        if (process.env.CLAUDE_TSP_TRACE) {
          try {
            writeFileSync(process.env.CLAUDE_TSP_TRACE, `${new Date().toISOString()} TSP error ${JSON.stringify(event.raw)}\n`, { flag: "a" });
          } catch {
            /* tracing is best effort */
          }
        }
        break;
      default:
        break;
    }
  }

  // ───────────────────────────────────────────────────────────── keys

  async #onKey(pressed: Key): Promise<void> {
    // Tern's scripted sessions send Ctrl as Meta; `CLAUDE_TSP_META_AS_CTRL=1` lets a scenario drive the Ctrl shortcuts.
    const key = META_AS_CTRL && pressed.meta ? { ...pressed, ctrl: true, meta: false } : pressed;
    this.#keySeq += 1;
    if (process.env.CLAUDE_TSP_KEYLOG) appendFileSync(process.env.CLAUDE_TSP_KEYLOG, `${JSON.stringify(pressed)}\n`);
    if (this.#keymap.action(key) === "app.clear") return this.#ctrlC();
    if (this.#sheet) return this.#sheetKey(key);
    if (this.#prefs) return this.#prefsKey(key);
    if (this.#picker) return this.#pickerKey(this.#picker, key);
    if (this.#rewind) return this.#rewindKey(this.#rewind, key);
    if (this.#field) return this.#fieldKey(this.#field, key);
    if (this.#questions[0]) return void this.#questionKey(this.#questions[0], key);
    if (this.#approvals[0] && this.#approvalKey(this.#approvals[0], key)) return;
    return this.#composerKey(key);
  }

  async #ctrlC(): Promise<void> {
    const now = Date.now();
    if (this.#sheet) return this.#closeSheet();
    if (this.#prefs) {
      this.#prefs = null;
      return;
    }
    if (this.#picker) return this.#closePicker();
    if (this.#rewind) return this.#closeRewind();
    if (this.#field) return this.#closeField(null);
    if (this.#questions[0]) return this.#finishQuestion(this.#questions[0], false);
    if (this.#approvals[0]) return this.#answerApproval(this.#approvals[0], null);
    if (now - this.#lastCtrlC < 1500) return this.quit();
    this.#lastCtrlC = now;
    if (!this.editor.empty) {
      this.editor.remember(this.editor.expanded());
      this.editor.clear();
      this.#attachments = [];
      this.#completion = null;
    } else if (this.conv.busy || this.conv.shell || this.conv.retry) await this.#interrupt();
    this.toast("Press Ctrl+C again to exit");
  }

  #approvalKey(approval: Approval, key: Key): boolean {
    const at = approval.choices.findIndex(choice => choice.id === approval.selected);
    if (key.ctrl && (key.name === "enter" || key.name === "q")) {
      this.#answerApproval(approval, approval.choices.find(choice => !choice.deny)?.id ?? null);
      return true;
    }
    if (key.ctrl && key.name === "o") {
      approval.expanded = !approval.expanded;
      return true;
    }
    if (key.shift && key.name === "tab") {
      // As in Claude Code: Shift+Tab on an edit takes "accept all edits".
      const edits = approval.choices.find(choice => /accept (all )?edits/i.test(choice.label));
      if (edits) {
        this.#answerApproval(approval, edits.id);
        return true;
      }
    }
    // While a draft is being typed the keys belong to the composer.
    if (!this.editor.empty) return false;
    switch (key.name) {
      case "up":
        approval.selected = approval.choices[Math.max(0, at - 1)]?.id ?? approval.selected;
        return true;
      case "down":
        approval.selected = approval.choices[Math.min(approval.choices.length - 1, at + 1)]?.id ?? approval.selected;
        return true;
      case "enter":
        this.#answerApproval(approval, approval.selected);
        return true;
      case "escape":
        this.#answerApproval(approval, null);
        return true;
      default:
        if (!key.ctrl && !key.alt && /^[1-9]$/.test(key.name)) {
          const choice = approval.choices[Number(key.name) - 1];
          if (choice) {
            this.#answerApproval(approval, choice.id);
            return true;
          }
        }
        return false;
    }
  }

  #fieldKey(field: Field, key: Key): void {
    const editor = field.editor;
    if (key.name === "escape") return this.#closeField(null);
    if (key.name === "enter") {
      if (field.multiline && !key.ctrl && !key.meta) editor.insert("\n");
      else this.#closeField(editor.text);
      return;
    }
    this.#textKey(editor, key, field.multiline);
  }

  /** The editing keys shared by the composer and dialogs; true when handled. */
  #textKey(editor: TextEditor, key: Key, multiline: boolean): boolean {
    switch (this.#keymap.action(key)) {
      case "tui.editor.cursorLeft":
        editor.left();
        return true;
      case "tui.editor.cursorRight":
        editor.right();
        return true;
      case "tui.editor.cursorWordLeft":
        editor.left(false, true);
        return true;
      case "tui.editor.cursorWordRight":
        editor.right(false, true);
        return true;
      case "tui.editor.cursorLineStart":
        editor.home();
        return true;
      case "tui.editor.cursorLineEnd":
        editor.end();
        return true;
      case "tui.editor.deleteCharBackward":
        editor.backspace();
        return true;
      case "tui.editor.deleteCharForward":
        editor.deleteForward();
        return true;
      case "tui.editor.deleteWordBackward":
        editor.backspace(true);
        return true;
      case "tui.editor.deleteWordForward":
        editor.deleteForward(true);
        return true;
      case "tui.editor.deleteToLineStart":
        editor.killToStart();
        return true;
      case "tui.editor.deleteToLineEnd":
        editor.killToEnd();
        return true;
      case "tui.editor.yank":
        editor.yank();
        return true;
      case "tui.editor.undo":
        editor.undo();
        return true;
      case "tui.editor.redo":
        editor.redo();
        return true;
      case "tui.input.newLine":
        if (multiline) editor.insert("\n");
        return true;
      default:
        break;
    }
    // Shift extends the selection; these are not remapped.
    switch (key.name) {
      case "paste":
        if (key.text) editor.paste(multiline ? key.text : key.text.replace(/\s*\n\s*/g, " "));
        return true;
      case "left":
        editor.left(key.shift, key.ctrl || key.alt);
        return true;
      case "right":
        editor.right(key.shift, key.ctrl || key.alt);
        return true;
      case "home":
        if (key.ctrl) editor.moveTo(0, key.shift);
        else editor.home(key.shift);
        return true;
      case "end":
        if (key.ctrl) editor.moveTo(editor.text.length, key.shift);
        else editor.end(key.shift);
        return true;
      case "up":
        return editor.vertical(-1, key.shift);
      case "down":
        return editor.vertical(1, key.shift);
      default:
        break;
    }
    if (key.ctrl && key.shift && !key.alt && key.name === "a") {
      editor.selectAll();
      return true;
    }
    if (!key.ctrl && !key.alt && !key.meta && key.text) {
      editor.insert(key.text);
      return true;
    }
    return false;
  }

  async #composerKey(key: Key): Promise<void> {
    const editor = this.editor;
    const completion = this.#completion;
    const plain = !key.ctrl && !key.alt && !key.meta;

    if (completion) {
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        completion.selected = (completion.selected - 1 + completion.items.length) % completion.items.length;
        return;
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        completion.selected = (completion.selected + 1) % completion.items.length;
        return;
      }
      if (key.name === "tab" && !key.shift) return this.#acceptCompletion(completion.selected, false);
      if (key.name === "enter" && plain && !key.shift) return this.#acceptCompletion(completion.selected, true);
      if (key.name === "escape") {
        this.#completionDismissed = editor.text;
        this.#completion = null;
        return;
      }
    }

    if (this.#vimKeys) {
      // Outside Insert mode the arrows are Vim's motions; in it they stay the editor's.
      const arrows: Record<string, string> = { left: "h", right: "l", up: "k", down: "j", home: "0", end: "$", backspace: "h", space: " " };
      const insert = this.#vim.mode === "insert";
      const typed = key.name === "escape" ? "escape" : plain ? (insert ? undefined : (arrows[key.name] ?? key.text)) : undefined;
      if (typed !== undefined && this.#vim.key(typed)) {
        this.#updateCompletion();
        return;
      }
      // Normal mode never types: only Enter and the application's shortcuts pass.
      if (!insert && plain && key.text && key.name !== "enter") return;
    }
    const action = this.#keymap.action(key);
    if (action && (await this.#run(action))) {
      this.#updateCompletion();
      return;
    }

    switch (key.name) {
      case "enter":
        // A trailing backslash continues the line, as in Claude Code.
        if (action === "tui.input.submit" && editor.cursor === editor.text.length && editor.text.endsWith("\\")) {
          editor.backspace();
          editor.insert("\n");
        } else if (action === "tui.input.submit") await this.#submit();
        else if (action === "tui.input.newLine") editor.insert("\n");
        this.#updateCompletion();
        return;
      case "escape": {
        if (editor.selection()) return editor.moveTo(editor.cursor);
        // Esc twice on an empty draft opens the rewind page, as in Claude Code.
        const now = Date.now();
        if (editor.empty && !this.conv.busy && now - this.#lastEscape < 600) {
          this.#lastEscape = 0;
          await this.#rewindTo();
        } else this.#lastEscape = now;
        return;
      }
      case "tab":
        if (key.shift) return;
        if (editor.empty && this.conv.suggestion && !this.conv.busy) editor.set(this.conv.suggestion);
        else if (!this.#openFileCompletion()) editor.insert("  ");
        return;
      case "up":
        if (plain && !key.shift && !editor.vertical(-1)) editor.recall(-1);
        else if (key.shift) editor.vertical(-1, true);
        this.#updateCompletion();
        return;
      case "down":
        if (plain && !key.shift && !editor.vertical(1)) editor.recall(1);
        else if (key.shift) editor.vertical(1, true);
        this.#updateCompletion();
        return;
      case "page_up":
      case "page_down":
        if (this.#session.caps.features.includes("scroll")) this.#surface.scroll("main", key.name === "page_up" ? "page-up" : "page-down");
        return;
      case "paste":
        if (key.text !== undefined) this.#paste(key.text);
        this.#updateCompletion();
        return;
      default:
        break;
    }
    if (this.#textKey(editor, key, true)) this.#updateCompletion();
  }

  /** Runs a bound action from the composer; false when it does not apply now, so the key types as usual. */
  async #run(action: Action): Promise<boolean> {
    const editor = this.editor;
    switch (action) {
      case "app.interrupt":
        if (!this.conv.busy && !this.conv.shell && !this.conv.retry) return false;
        await this.#interrupt();
        return true;
      case "app.exit":
        if (!editor.empty || this.conv.busy) return false;
        await this.quit();
        return true;
      case "app.editor.external":
        await this.#externalEditor();
        return true;
      case "app.clipboard.pasteImage":
        this.#pasteClipboard();
        return true;
      case "app.session.new":
        await this.#newSession();
        return true;
      case "app.session.tree":
        this.#pickTree();
        return true;
      case "app.session.fork":
        this.#pickFork();
        return true;
      case "app.session.resume":
        this.#pickSession();
        return true;
      case "app.model.select":
        this.#pickModel();
        return true;
      case "app.model.cycleForward":
        await this.#cycleModel();
        return true;
      case "app.mode.cycle":
        await this.#cycleMode();
        return true;
      case "app.thinking.cycle":
        await this.#cycleEffort();
        return true;
      case "app.effort.increase":
      case "app.effort.decrease": {
        // As in Claude Code: one step up or down, stopping at the ends.
        const levels = this.#levels();
        const next = levels[levels.indexOf(this.conv.effort) + (action === "app.effort.increase" ? 1 : -1)];
        if (levels.length < 2) this.toast(`${this.#modelName()} has no effort levels`, "warning");
        else if (next) await this.#setEffort(next);
        return true;
      }
      case "app.fast.toggle":
        if (this.#remote.some(command => command.name === "fast")) this.#sendCommand("/fast");
        else this.toast("Fast mode is not available for this model or account", "warning");
        return true;
      case "app.agents.kill":
        await this.#killAgents();
        return true;
      case "app.thinking.switch":
        await this.#setThinking(this.#thinkingOff);
        return true;
      case "app.thinking.toggle":
        this.#hideThinking = !this.#hideThinking;
        this.#foldRev += 1;
        this.#saveDisplay();
        this.toast(this.#hideThinking ? "Thinking hidden" : "Thinking shown");
        return true;
      case "app.tasks.toggle":
        this.#showTasks = !this.#showTasks;
        this.#saveDisplay();
        this.toast(this.#showTasks ? "Task list shown" : "Task list hidden");
        return true;
      case "app.background":
        await this.#background();
        return true;
      case "app.stash":
        this.#toggleStash();
        return true;
      case "app.tools.expand":
        this.#expandAll = !this.#expandAll;
        this.#fold.clear();
        this.#foldRev += 1;
        this.#saveDisplay();
        this.toast(this.#expandAll ? "Expanded every block" : "Collapsed to defaults");
        return true;
      case "app.message.copy":
        this.copy(this.conv.lastAnswer(), "Answer");
        return true;
      case "app.message.followUp":
        await this.#followUp();
        return true;
      case "app.message.dequeue":
        await this.#dequeue();
        return true;
      case "app.history.search":
        this.#pickHistory();
        return true;
      case "app.retry":
        await this.#retry();
        return true;
      case "app.settings":
        this.#openPrefs();
        return true;
      default:
        return false;
    }
  }

  /** Ctrl+S: sets the draft aside, or brings the one set aside back. */
  #toggleStash(): void {
    if (this.#stash && this.editor.empty && !this.#attachments.length) {
      this.editor.set(this.#stash.text);
      this.#attachments = this.#stash.attachments;
      this.#stash = null;
      this.toast("Draft restored");
    } else if (!this.editor.empty || this.#attachments.length) {
      this.#stash = { text: this.editor.expanded(), attachments: this.#attachments };
      this.editor.clear();
      this.#attachments = [];
      this.toast("Draft set aside: Ctrl+S brings it back");
    } else this.toast("Nothing to set aside", "warning");
  }

  // ───────────────────────────────────────────────────────────── completion

  #commands(): Command[] {
    const conv = this.conv;
    const percent = (): string => (conv.contextWindow ? `${Math.round((conv.contextTokens / conv.contextWindow) * 100)}%` : "");
    const local: Command[] = [
      { name: "model", description: "Switch model for this session", icon: "model", value: () => this.#modelName(), run: args => this.#pickModel(args) },
      { name: "effort", description: "Set how hard the model thinks", icon: "gauge", value: () => conv.effort, run: args => this.#setEffort(args) },
      { name: "thinking", description: "Turn extended thinking on or off for this session", icon: "gauge", value: () => (this.#thinkingOff ? "off" : "on"), hint: "[on|off]", run: args => this.#setThinking(args.trim() ? /^(on|true|1)$/i.test(args.trim()) : this.#thinkingOff) },
      { name: "mode", description: "Set the permission mode: ask, accept edits, plan, auto", icon: "shield", value: () => MODES[conv.permissionMode]?.label ?? conv.permissionMode, run: args => this.#setModeArg(args) },
      { name: "plan", description: "Plan mode: Claude explores and proposes before it changes anything", icon: "plan", run: args => this.#planCommand(args) },
      { name: "resume", description: "Resume a different session", icon: "history", run: args => this.#pickSession(args) },
      { name: "continue", description: "Resume the most recent session of this folder", icon: "history", run: () => this.#continueLast() },
      { name: "new", description: "Start a new conversation (the current one stays on disk)", icon: "plus", run: () => this.#newSession() },
      { name: "clear", description: "Start a new conversation (the current one stays on disk)", icon: "eraser", run: () => this.#newSession() },
      { name: "rewind", description: "Go back to an earlier message and restore the files", icon: "rewind", run: () => this.#rewindTo() },
      { name: "fork", description: "Start a new session from an earlier message", icon: "fork", run: () => this.#pickFork() },
      { name: "tree", description: "Jump to any point of this session, on any branch", icon: "branch", run: () => this.#pickTree() },
      { name: "branch", description: "Copy this conversation into a new session", icon: "copy", run: () => this.#branch() },
      { name: "context", description: "Show what fills the context window", icon: "context", value: percent, run: () => this.#showContext() },
      { name: "usage", description: "Show your plan's usage limits and what uses them", icon: "gauge", run: () => this.#showUsage_() },
      { name: "cost", description: "Show what this session has cost", icon: "info", value: () => money(conv.cost), run: () => this.#showSession() },
      { name: "status", description: "Show the session, account, model and version", icon: "info", run: () => this.#showSession() },
      { name: "rename", description: "Name this session", icon: "edit", value: () => conv.sessionName, hint: "[name]", run: args => this.#rename(args) },
      { name: "agents", description: "Show this session's subagents and the agent types available", icon: "users", value: () => (conv.agents().length ? String(conv.agents().length) : ""), run: () => this.#pickAgents() },
      { name: "tasks", description: "Show background work and stop it", icon: "list", value: () => (this.#backgroundCount() ? String(this.#backgroundCount()) : ""), run: () => this.#pickBackground() },
      { name: "todos", description: "Show the task list", icon: "list", run: () => this.#showTodos() },
      { name: "mcp", description: "Show MCP servers; reconnect or switch them off", icon: "plug", value: () => (this.#mcp.length ? String(this.#mcp.length) : ""), run: () => this.#pickMcp() },
      { name: "permissions", description: "Show the allow, ask and deny rules in force", icon: "shield", run: () => this.#pickPermissions() },
      { name: "skills", description: "Browse the skills and commands Claude can run", icon: "sparkles", run: () => this.#pickSkills() },
      { name: "output-style", description: "Choose how Claude writes its replies", icon: "edit", value: () => this.#outputStyle, run: args => this.#pickOutputStyle(args) },
      { name: "add-dir", description: "Let Claude work in another folder too", icon: "folder", hint: "<path>", run: args => this.#addDir(args) },
      { name: "outline", description: "Jump to a message or tool call in the transcript", icon: "list", run: () => this.#pickOutline() },
      { name: "copy", description: "Copy a message from this session", icon: "copy", run: () => this.#pickCopy() },
      { name: "export", description: "Save this conversation as Markdown", icon: "export", hint: "[file]", run: args => this.#export(args) },
      { name: "inspect", description: "Open the last shell command in the inspector and replay its run", icon: "terminal", run: () => this.#inspectLast() },
      { name: "ide", description: "Connect to an IDE running the Claude Code extension", icon: "plug", run: () => this.#pickIde() },
      { name: "keybindings", description: "Edit this surface's key bindings", icon: "keyboard", run: () => this.#editKeys() },
      { name: "terminal-setup", description: "Shift+Enter for a new line (nothing to install in Tern)", icon: "keyboard", run: () => this.toast("Tern already sends Shift+Enter as a new line: nothing to set up") },
      { name: "trace", description: "Trace Claude's Bash calls so their runs can be replayed step by step", icon: "terminal", value: () => (this.#traceCalls ? "on" : "off"), run: () => void this.#prefsChange("trace-calls", !this.#traceCalls) },
      { name: "btw", description: "Ask a side question without adding it to the conversation", icon: "message", hint: "<question>", run: args => this.#sideQuestion(args) },
      { name: "attach", description: "Attach an image to the next message", icon: "image", hint: "<image path>", run: args => this.#attachPath(args) },
      { name: "retry", description: "Send the last message again", icon: "refresh", run: () => this.#retry() },
      { name: "config", description: "Open settings", icon: "settings", run: () => this.#openPrefs() },
      { name: "settings", description: "Open settings", icon: "settings", run: () => this.#openPrefs() },
      { name: "vim", description: "Turn Vim keys in the composer on or off", icon: "keyboard", value: () => (this.#vimKeys ? "on" : "off"), run: () => void this.#prefsChange("vim-keys", !this.#vimKeys) },
      { name: "theme", description: "The surface follows Tern's theme; this picks the accent", icon: "appearance", value: () => (this.#clay ? "Claude" : "Tern"), run: () => void this.#prefsChange("clay", !this.#clay) },
      { name: "doctor", description: "Check the health of the Claude Code installation", icon: "info", run: () => this.#doctor() },
      { name: "sandbox", description: "Choose how commands are sandboxed", icon: "shield", run: () => this.#sandbox() },
      // claude-pi runs with Claude Code's non-essential traffic off: remote control and feedback reports are not offered there.
      ...(PROFILE.pi
        ? []
        : ([
          { name: "remote-control", description: "Continue this session from claude.ai or the mobile app", icon: "plug", hint: "[name|off]", value: () => (this.#remoteLink ? "on" : ""), run: args => void this.#remoteControl(args) },
          { name: "feedback", description: "Send feedback about Claude Code", icon: "info", hint: "[report]", run: args => void this.#feedback(args) },
          { name: "bug", description: "Send feedback about Claude Code", icon: "info", hint: "[report]", run: args => void this.#feedback(args) },
          ] as Command[])),
      { name: "release-notes", description: "Show Claude Code's release notes", icon: "info", run: () => this.#releaseNotes() },
      { name: "stats", description: "Show your usage statistics", icon: "gauge", run: () => this.#showStats() },
      { name: "upgrade", description: "Upgrade your plan", icon: "key", run: () => this.#upgrade() },
      { name: "background", description: "Send this session to the background and start a new one here", icon: "list", run: () => void this.#sendToBackground() },
      { name: "bg", description: "Send this session to the background and start a new one here", icon: "list", run: () => void this.#sendToBackground() },
      { name: "subtask", description: "Send a subagent off with your full context; its result comes back here", icon: "list", hint: "<task>", value: () => (this.#subtasks ? `${this.#subtasks} running` : ""), run: args => void this.#subtask(args) },
      { name: "stop-all", description: "Stop every subagent and background task", icon: "list", run: () => this.#killAgents() },
      { name: "workflows", description: "Browse running and completed workflows", icon: "list", run: () => this.#pickWorkflows() },
      { name: "rate-limit-options", description: "Manage usage limits and upgrade options", icon: "gauge", run: () => void this.#limitOptions() },
      { name: "pro-trial-expired", description: "Options when a plan's Claude Code trial has ended", icon: "gauge", run: () => void this.#limitOptions() },
      { name: "setup-bedrock", description: "Configure Amazon Bedrock authentication, region and model pin", icon: "key", run: () => void this.#setupProvider("bedrock") },
      { name: "setup-vertex", description: "Configure Google Vertex AI project, region and model pin", icon: "key", run: () => void this.#setupProvider("vertex") },
      ...(PROFILE.pi ? [] : ([{ name: "teleport", description: "Resume a cloud session from claude.ai, or send this one to the cloud", icon: "history", hint: "[session]", run: (args: string) => void this.#teleport(args) }] as Command[])),
      { name: "diff", description: "Show the uncommitted changes of this folder", icon: "diff", run: () => this.#showDiff() },
      { name: "cd", description: "Move this session to a new working directory", icon: "folder", hint: "<folder>", run: args => void this.#changeDir(args) },
      { name: "install-slack-app", description: "Install the Claude Slack app", icon: "plug", run: () => this.#slackApp() },
      { name: "mobile", description: "Get the Claude mobile app", icon: "plug", run: () => this.#mobileApp() },
      { name: "ios", description: "Get the Claude mobile app", icon: "plug", run: () => this.#mobileApp() },
      { name: "android", description: "Get the Claude mobile app", icon: "plug", run: () => this.#mobileApp() },
      { name: "stickers", description: "Order Claude Code stickers", icon: "info", run: () => this.#stickers() },
      { name: "radio", description: "Listen to Claude FM lo-fi radio", icon: "info", run: () => this.#radio() },
      { name: "privacy-settings", description: "View and change your privacy settings", icon: "shield", run: () => this.#privacy() },
      { name: "install-github-app", description: "Set up Claude GitHub Actions for a repository", icon: "plug", run: () => void this.#installGithubApp() },
      { name: "hooks", description: "Show the hooks configured for this session", icon: "plug", run: () => this.#pickHooks() },
      { name: "widgets", description: "Press a button or open a pane that a plugin drew", icon: "plug", run: () => this.#pickWidgets() },
      { name: "memory", description: "Open Claude's memory files (CLAUDE.md) in your editor", icon: "file", run: () => this.#pickMemory() },
      { name: "plugin", description: "Show plugins; enable or disable them", icon: "package", value: () => (this.#plugins.length ? String(this.#plugins.length) : ""), run: () => this.#pickPlugins() },
      { name: "statusline", description: "Draw Claude Code's configured status line among the composer's facts", icon: "info", value: () => (this.#statusLine ? "on" : "off"), run: () => void this.#prefsChange("status-line", !this.#statusLine) },
      { name: "login", description: "Sign in to your Anthropic account", icon: "key", hint: "[--console|--sso]", run: args => this.#login(args) },
      { name: "logout", description: "Sign out of your Anthropic account", icon: "key", run: () => this.#logout() },
      { name: "tui", description: "Open this session in Claude Code's own terminal UI, then return here", icon: "terminal", hint: "[/command]", run: args => this.#tui(args) },
      { name: "hotkeys", description: "Show keyboard shortcuts", icon: "keyboard", run: () => this.#showHotkeys() },
      { name: "help", description: "Show keyboard shortcuts and commands", icon: "help", run: () => this.#showHotkeys() },
      { name: "exit", description: `Exit ${PROFILE.name}`, icon: "x", run: () => this.quit() },
      { name: "quit", description: `Exit ${PROFILE.name}`, icon: "x", run: () => this.quit() },
    ];
    const names = new Set(local.map(command => command.name));
    const remote = this.#remote.filter(command => !names.has(command.name) && !command.name.startsWith("__"));
    for (const command of remote) names.add(command.name);
    const tui: Command[] = Object.entries(TUI_COMMANDS)
      .filter(([name]) => !names.has(name))
      .map(([name, description]) => ({ name, description: `${description} (opens Claude Code's terminal UI)`, icon: "terminal", run: (args: string) => this.#tui(`/${name}${args ? ` ${args}` : ""}`) }));
    return [...local, ...remote, ...tui];
  }

  /** Opens, refreshes or closes the popup to match the draft at the caret. */
  #updateCompletion(): void {
    const text = this.editor.text;
    if (text === this.#completionDismissed) return;
    this.#completionDismissed = "";
    const keep = this.#completion?.items[this.#completion.selected]?.id;
    let next: CompletionState | null = null;
    if (/^\/[^\s]*$/.test(text) && this.editor.cursor === text.length) {
      const query = text.slice(1);
      const ranked = rank(query, this.#commands(), command => command.name).sort((a, b) => Number(b.item.name.startsWith(query)) - Number(a.item.name.startsWith(query)));
      const items = ranked.slice(0, 100).map(({ item }) => ({
        id: item.name,
        label: item.hint ? `${item.name} ${item.hint}` : item.name,
        mark: item.name.startsWith(query) ? query.length : 0,
        detail: item.description,
        value: item.value?.() || undefined,
        icon: item.icon,
      }));
      if (items.length) next = { kind: "command", from: 0, items, selected: 0 };
    } else {
      const before = text.slice(0, this.editor.cursor);
      const match = before.match(/(?:^|\s)@([^\s@]*)$/);
      if (match) {
        const query = match[1] ?? "";
        const from = before.length - query.length - 1;
        const files = this.#files.list(() => {
          this.#updateCompletion();
          this.schedule();
        });
        const ranked = rank(query, files, file => file).slice(0, 50);
        const items = ranked.map(({ item }) => ({ id: item, label: item, icon: item.endsWith("/") ? "folder" : "file" }));
        if (items.length) next = { kind: "file", from, items, selected: 0 };
      }
    }
    if (next && keep) {
      const at = next.items.findIndex(item => item.id === keep);
      if (at > 0 && this.#completion?.selected !== 0) next.selected = at;
    }
    this.#completion = next;
  }

  /** Tab on a path-like word with no popup: open file completion for it. */
  #openFileCompletion(): boolean {
    const before = this.editor.text.slice(0, this.editor.cursor);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return false;
    this.#updateCompletion();
    return true;
  }

  #acceptCompletion(index: number, run: boolean): void {
    const completion = this.#completion;
    const item = completion?.items[index];
    if (!completion || !item) return;
    const editor = this.editor;
    if (completion.kind === "command") {
      const command = this.#commands().find(entry => entry.name === item.id);
      this.#completion = null;
      editor.set(`/${item.id} `);
      // Enter on a command that needs nothing more runs it at once.
      // Enter runs it at once, unless it is one of ours that cannot run without an argument (Tab only completes).
      if (run && command && !(command.run && /^</.test(command.hint ?? ""))) void this.#submit();
      return;
    }
    const directory = item.id.endsWith("/");
    editor.splice(completion.from, editor.cursor, `@${item.id}${directory ? "" : " "}`);
    this.#completion = null;
    if (directory) this.#updateCompletion();
    this.schedule();
  }

  // ───────────────────────────────────────────────────────────── prompts

  /** The content of a user message: its text, then its images. */
  #content(text: string, images: Image[]): string | Record<string, any>[] {
    if (!images.length) return text;
    return [...(text ? [{ type: "text", text }] : []), ...images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))];
  }

  async #submit(explicit?: string, priority: Queued["priority"] = this.#steer): Promise<void> {
    const editor = this.editor;
    const text = (explicit ?? editor.expanded()).trim();
    const images = this.#attachments;
    if (!text && !images.length) return;
    if (this.#starting || this.#cc?.exited) {
      this.toast(this.#starting ? `${PROFILE.name} is still starting` : `${PROFILE.name} is not running: /new starts it again`, "warning");
      if (explicit !== undefined) editor.set(text);
      return;
    }
    if (explicit === undefined) {
      editor.remember(editor.text);
      editor.clear();
    }
    this.#completion = null;
    this.#completionDismissed = "";
    if (text.startsWith("/") && !text.startsWith("//")) {
      const [, name = "", args = ""] = text.match(/^\/(\S*)\s*([\s\S]*)$/) ?? [];
      const command = this.#commands().find(entry => entry.name === name);
      if (command?.run) {
        await command.run(args.trim());
        return;
      }
      // Anything else is Claude Code's: a built-in, a skill, a plugin's command.
      this.#attachments = [];
      return this.#sendCommand(text);
    }
    if (text.startsWith("!")) {
      const excluded = text.startsWith("!!");
      const command = text.slice(excluded ? 2 : 1).trim();
      if (command) return this.#shell(command, excluded);
      return;
    }
    this.#attachments = [];
    this.#banner.dismissed = true;
    if (this.conv.busy) {
      const queued = this.conv.enqueue(text, images, priority);
      this.#cc.user(this.#content(text, images), { uuid: queued.uuid, priority });
      return;
    }
    const item = this.conv.addUser(text, images);
    this.conv.busy = true;
    this.conv.runStartedAt = Date.now();
    this.conv.suggestion = "";
    this.#cc.user(this.#content(text, images), { uuid: item.uuid });
  }

  /** Sends a slash command for Claude Code to run; its echo is the user's row. */
  #sendCommand(text: string): void {
    if (this.conv.busy) {
      this.toast("Wait for Claude to finish, or stop it, before running a command", "warning");
      this.editor.set(text);
      return;
    }
    const item = this.conv.addUser(text);
    this.#cc.user(text, { uuid: item.uuid });
  }

  async #followUp(): Promise<void> {
    if (!this.editor.expanded().trim() && !this.#attachments.length) return;
    if (!this.conv.busy) return this.#submit();
    await this.#submit(undefined, "later");
    this.toast("Queued for after the current turn");
  }

  /** Takes the queued messages back into the composer. */
  async #dequeue(): Promise<void> {
    const queued = [...this.conv.queue];
    if (!queued.length) {
      this.toast("No queued messages to restore");
      return;
    }
    const kept: Queued[] = [];
    for (const entry of queued) {
      try {
        const result = await this.#cc.request("cancel_async_message", { message_uuid: entry.uuid }, 8000);
        if (result?.cancelled === false) continue;
        kept.push(entry);
      } catch {
        /* already taken */
      }
    }
    this.conv.queue = this.conv.queue.filter(entry => !kept.includes(entry));
    if (kept.length) {
      this.editor.set([this.editor.text, ...kept.map(entry => entry.text)].filter(Boolean).join("\n\n"));
      for (const entry of kept) for (const image of entry.images) this.#attachments.push({ ...image, name: "image" });
      this.toast("Restored queued messages to the editor");
    } else this.toast("Claude had already taken them", "warning");
    this.conv.touch();
  }

  /** `!command`: runs in the user's shell; its output is shared with Claude unless it was `!!`. */
  async #shell(command: string, excluded: boolean): Promise<void> {
    if (this.conv.shell) {
      this.toast("A command is already running", "warning");
      return;
    }
    const item = this.conv.startShell(command, excluded);
    let stdout = "";
    let stderr = "";
    const cap = 2_000_000;
    const done = (code: number | null, cancelled: boolean, error?: string): void => {
      this.#shellChild = null;
      this.conv.finishShell(item, code, cancelled, error);
      if (!excluded && !this.#cc.exited) {
        // The same record Claude Code keeps of a `!command`, sent without starting a turn.
        const uuid = randomUUID();
        this.conv.silence(uuid);
        const clip = (text: string): string => (text.length > 30_000 ? `${text.slice(0, 30_000)}\n… (truncated)` : text);
        this.#cc.user(`<bash-input>${command}</bash-input>\n<bash-stdout>${clip(stdout)}</bash-stdout><bash-stderr>${clip(stderr)}${code ? `\nExit code ${code}` : ""}</bash-stderr>`, { uuid, shouldQuery: false });
      }
      this.schedule();
    };
    // Your own commands are always traced when bash can: nothing asks permission for them.
    const file = usesTracing(command) ? "" : traceFile();
    const finish = done;
    const done_ = (code: number | null, cancelled: boolean, error?: string): void => {
      const trace = file ? takeTrace(file) : null;
      if (trace) item.details = { ...(item.details ?? {}), trace };
      finish(code, cancelled, error);
    };
    try {
      const child = spawn(file ? "bash" : process.env.SHELL || "bash", ["-c", file ? traced(command, file) : command], { cwd: this.#cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CLAUDECODE: "1", TERM: "dumb" } });
      this.#shellChild = child;
      const take = (which: "out" | "err") => (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        if (which === "out") stdout = (stdout + text).slice(-cap);
        else stderr = (stderr + text).slice(-cap);
        item.output = ((item.output || "") + text).slice(-cap);
        this.conv.bump(item);
        this.schedule();
      };
      child.stdout!.on("data", take("out"));
      child.stderr!.on("data", take("err"));
      child.on("error", error => done_(null, false, error.message));
      child.on("close", (code, signal) => done_(code, Boolean(signal)));
    } catch (error) {
      done_(null, false, (error as Error).message);
    }
  }

  async #interrupt(): Promise<void> {
    if (this.conv.shell && this.#shellChild?.pid) {
      try {
        process.kill(-this.#shellChild.pid, "SIGTERM");
      } catch {
        this.#shellChild.kill("SIGTERM");
      }
      return;
    }
    if (!this.conv.busy && !this.conv.retry && !this.conv.compacting) return;
    try {
      await this.#cc.request("interrupt", {}, 8000);
    } catch (error) {
      this.toast(`Could not stop: ${(error as Error).message}`, "error");
    }
  }

  /** Ctrl+B: sends what runs in the foreground (a command, a subagent) to the background. */
  async #background(): Promise<void> {
    if (!this.conv.busy) {
      if (this.#backgroundCount()) this.#pickBackground();
      else this.toast("Nothing is running", "warning");
      return;
    }
    try {
      await this.#cc.request("background_tasks", {}, 8000);
      this.toast("Sent to the background");
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
  }

  async #stopTask(taskId: string, what: string): Promise<void> {
    if (!taskId) return;
    try {
      await this.#cc.request("stop_task", { task_id: taskId }, 8000);
      this.toast(`Stopped ${what}`);
    } catch (error) {
      this.toast(`Could not stop ${what}: ${firstLine((error as Error).message, 120)}`, "error");
    }
  }

  /** Sends the last user message again, replacing a failed answer. */
  async #retry(): Promise<void> {
    if (this.conv.busy) return;
    const last = [...this.conv.items].reverse().find(item => item.kind === "user");
    if (!last) {
      this.toast("Nothing to retry", "warning");
      return;
    }
    for (const item of [...this.conv.items]) if (item.kind === "error") this.conv.remove(item);
    await this.#submit(last.text);
  }

  #paste(text: string): void {
    const trimmed = text.trim();
    // A pasted image path (a file dropped on the pane) attaches the image.
    if (trimmed && !trimmed.includes("\n") && isImagePath(trimmed)) {
      this.#attachImage(readImageFile(trimmed.replace(/^['"]|['"]$/g, "")));
      return;
    }
    if (!text) return this.#pasteClipboard();
    this.editor.paste(text);
  }

  #attachImage(image: Attachment | null): boolean {
    if (!image) return false;
    if (this.#attachments.length >= 8) {
      this.toast("At most 8 images per message", "warning");
      return true;
    }
    this.#attachments.push(image);
    return true;
  }

  #pasteClipboard(): void {
    if (this.#attachImage(readClipboardImage())) return;
    for (const path of readClipboardFilePaths()) if (isImagePath(path) && this.#attachImage(readImageFile(path))) return;
    const text = readClipboardText();
    if (!text) {
      this.toast("The clipboard has no image or text", "warning");
      return;
    }
    if (isImagePath(text.trim()) && this.#attachImage(readImageFile(text.trim()))) return;
    this.editor.paste(text);
  }

  #attachPath(args: string): void {
    const raw = args.trim().replace(/^['"]|['"]$/g, "");
    if (!raw) {
      this.toast("Usage: /attach <image path>", "warning");
      return;
    }
    const path = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(this.#cwd, raw);
    if (!this.#attachImage(readImageFile(path))) this.toast(`Not a readable image: ${raw}`, "error");
  }

  /**
   * Hands the pane to another program and takes it back when it exits.
   *
   * The surface is closed with its transcript kept, so Tern gives the pane
   * back to the grid, and this process stops reading the tty so the child has
   * it alone. Afterwards the surface is adopted again: the transcript is
   * still there, and the dock is drawn anew.
   */
  /** Opens a file in the user's editor in this pane; false when there is no editor to run. */
  async #editFile(path: string): Promise<boolean> {
    const command = process.env.VISUAL || process.env.EDITOR || ["nano", "vim", "vi"].find(name => (process.env.PATH ?? "").split(":").some(dir => dir && existsSync(join(dir, name))));
    if (!command) {
      this.toast(`Set $EDITOR to edit ${showPath(path, this.#cwd)} from here`, "warning");
      return false;
    }
    const [bin, ...rest] = command.split(" ").filter(Boolean);
    try {
      await this.#external(bin!, [...rest, path]);
      return true;
    } catch (error) {
      this.toast(`Could not run ${command}: ${(error as Error).message}`, "error");
      return false;
    }
  }

  async #external(bin: string, args: string[], env: Record<string, string> = {}, note = ""): Promise<void> {
    const adopt = this.#session.caps.features.includes("adopt");
    if (adopt) await this.#surface.close({ keep: true });
    else this.#surface.suspend();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    if (note) process.stdout.write(`${note}\n`);
    try {
      await new Promise<void>((done, fail) => {
        const child = spawn(bin, args, { stdio: "inherit", cwd: this.#cwd, env: { ...process.env, ...env } });
        child.on("error", fail);
        child.on("exit", () => done());
      });
    } finally {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      // The child may have switched bracketed paste off on its way out.
      process.stdout.write("\x1b[?2004h");
      if (adopt) this.#surface = this.#session.open({ ...SURFACE, adopt: true });
      else this.#surface.resume();
      this.#applyStyles();
      this.#main.reset();
      this.#focus = undefined;
      this.schedule();
    }
  }

  /** Edits the draft in `$VISUAL`/`$EDITOR`. */
  async #externalEditor(): Promise<void> {
    const command = process.env.VISUAL || process.env.EDITOR;
    if (!command) {
      this.toast("Set $VISUAL or $EDITOR to edit the draft in your editor", "warning");
      return;
    }
    const path = join(stateDir(), `draft-${process.pid}.md`);
    const [bin, ...rest] = command.split(" ").filter(Boolean);
    try {
      writeFileSync(path, this.editor.expanded(), { mode: 0o600 });
      await this.#external(bin!, [...rest, path]);
      this.editor.set(readFileSync(path, "utf8").replace(/\n$/, ""));
    } catch (error) {
      this.toast(`Could not run ${command}: ${(error as Error).message}`, "error");
    } finally {
      rmSync(path, { force: true });
    }
  }

  /**
   * What only Claude Code's own terminal UI can do (signing in, the plugin
   * manager, the hook and memory editors): this session is handed to it, on
   * the same conversation, and taken back when it exits.
   */
  async #tui(args: string): Promise<void> {
    if (this.conv.busy) {
      this.toast("Wait for Claude to finish, or stop it, first", "warning");
      return;
    }
    const sessionId = this.conv.sessionId;
    const stored = sessionId && existsSync(sessionFile(this.#cwd, sessionId));
    const state: SpawnState = { model: this.#modelValue || null, permissionMode: this.conv.permissionMode, effort: this.conv.effort || null, ...(stored ? { resume: sessionId } : {}) };
    this.#swapping = true;
    this.#denyAll();
    try {
      await this.#cc.stop();
      await this.#external(stockPath(), [...spawnArgs(this.#launch, state), ...(args.trim() ? [args.trim()] : [])], {}, `claude-tsp: Claude Code's own UI has this session now. /exit returns here.`);
    } catch (error) {
      this.toast(`Could not open Claude Code: ${(error as Error).message}`, "error");
    } finally {
      this.#swapping = false;
    }
    // The terminal UI may have gone on in this session or started another: take up the newest.
    const latest = latestSession(this.#cwd);
    const resume = latest && (!stored || latest.mtime >= Date.now() - 6 * 3600_000) ? latest.id : stored ? sessionId : null;
    await this.#start(resume ? { ...state, resume } : { ...state, resume: null, sessionId: randomUUID() }, resume ? sessionFile(this.#cwd, resume) : null);
  }

  /**
   * `/login`: Claude Code's own sign-in (`claude auth login`), drawn here. It
   * prints the page to open and waits for the code that page gives; the
   * session's process is started again afterwards so it uses the new sign-in.
   */
  async #login(args: string): Promise<void> {
    if (this.conv.busy) {
      this.toast("Wait for Claude to finish, or stop it, before signing in", "warning");
      return;
    }
    const flags = args.split(/\s+/).filter(flag => ["--console", "--claudeai", "--sso"].includes(flag));
    const child = spawn(stockPath(), ["auth", "login", ...flags], { cwd: this.#cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let output = "";
    let asked = false;
    let finished = false;
    const done = new Promise<number | null>(resolve => {
      child.on("error", () => resolve(null));
      child.on("exit", code => resolve(code));
    });
    child.stdin.on("error", () => undefined);
    const take = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const url = output.match(/https:\/\/[^\s\x07\x1b]+oauth[^\s\x07\x1b]*/)?.[0];
      if (!url || asked) return;
      asked = true;
      process.stdout.write(`\x1b]52;c;${Buffer.from(url, "utf8").toString("base64")}\x07`);
      this.#openField({
        title: "Sign in to Claude",
        detail: "Open the page below (it is also on your clipboard), sign in, and paste the code it gives you here.",
        link: url,
        placeholder: "Paste the code",
        multiline: false,
        text: "",
        done: value => {
          if (finished) return;
          if (value === null || !value.trim()) {
            child.kill("SIGTERM");
            this.toast("Sign-in cancelled");
            return;
          }
          child.stdin.write(`${value.trim()}\n`);
          this.toast("Checking the code…");
        },
      });
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const code = await done;
    finished = true;
    if (this.#field?.title === "Sign in to Claude") this.#field = null;
    if (code === 0) {
      this.toast("Signed in", "success");
      const id = this.conv.sessionId;
      const stored = id && existsSync(sessionFile(this.#cwd, id));
      await this.#restart(stored ? { resume: id } : { sessionId: randomUUID() }, stored ? sessionFile(this.#cwd, id) : null);
    } else if (code !== null && asked) {
      // eslint-disable-next-line no-control-regex
      const reason = output.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\n").map(line => line.trim()).filter(line => line && !/^(Opening browser|If the browser|Paste code)/.test(line)).at(-1);
      if (reason) this.toast(`Sign-in failed: ${firstLine(reason, 200)}`, "error");
    } else if (code === null || !asked) this.toast(`Could not start the sign-in: ${firstLine(output.trim() || "claude auth login did not answer", 200)}`, "error");
    this.schedule();
  }

  /** `/logout`: asks first, then signs out with `claude auth logout`. */
  #logout(): void {
    this.#openPicker({
      props: { title: "Sign out of your Anthropic account?", subtitle: this.#account.email ? String(this.#account.email) : "", noun: "options", size: "md", layout: "rows", preview: "none" },
      items: [
        { id: "no", label: "Stay signed in" },
        { id: "yes", label: "Sign out", tone: "error", detail: "Claude Code will ask you to sign in again" },
      ],
      selected: "no",
      searchable: false,
      actions: this.#chooseActions("Select"),
      choose: id => {
        this.#picker = null;
        if (id !== "yes") return;
        execFile(stockPath(), ["auth", "logout"], { cwd: this.#cwd, timeout: 20_000 }, (error, stdout, stderr) => {
          if (error) this.toast(`Could not sign out: ${firstLine(stderr || error.message, 160)}`, "error");
          else {
            this.#account = {};
            this.toast(firstLine(stdout, 120) || "Signed out");
          }
          this.schedule();
        });
      },
    });
  }

  // ───────────────────────────────────────────────────────────── model, effort, mode

  /** Alt+T, as in Claude Code: extended thinking on or off for the session. */
  async #setThinking(on: boolean): Promise<void> {
    try {
      await this.#cc.request("set_max_thinking_tokens", { max_thinking_tokens: on ? null : 0 });
      this.#thinkingOff = !on;
      this.toast(on ? "Thinking on" : "Thinking off");
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
  }

  /** Stops every subagent and background task at once, as Claude Code's kill-agents key does. */
  async #killAgents(): Promise<void> {
    const ids = new Set<string>([...this.conv.background.keys()]);
    for (const item of this.conv.items) if (item.kind === "agent" && item.taskId && (item.agentStatus === "running" || item.agentStatus === "pending")) ids.add(item.taskId);
    if (!ids.size) {
      this.toast("Nothing is running in the background");
      return;
    }
    await Promise.all([...ids].map(id => this.#cc.request("stop_task", { task_id: id }, 20_000).catch(() => null)));
    this.toast(`Stopped ${ids.size} ${ids.size === 1 ? "task" : "tasks"}`);
    this.schedule();
  }

  async #cycleEffort(): Promise<void> {
    const levels = this.#levels();
    if (levels.length < 2) {
      this.toast(`${this.#modelName()} has no effort levels`, "warning");
      return;
    }
    const at = levels.indexOf(this.conv.effort);
    await this.#setEffort(levels[(at + 1) % levels.length]!);
  }

  async #setEffort(args: string): Promise<void> {
    const level = args.trim().toLowerCase();
    if (!level) return this.#pickEffort();
    const levels = this.#levels();
    if (!levels.includes(level)) {
      this.toast(levels.length ? `Unknown level "${level}". Available: ${levels.join(", ")}` : `${this.#modelName()} has no effort levels`, "warning");
      return;
    }
    if (this.#local()) {
      // The plugin's own command sets it; its store is read back once the command has run.
      const command = this.#remote.find(entry => entry.name === "deepseek-effort") ?? this.#remote.find(entry => entry.name === "glm-effort");
      if (!command || this.conv.busy) {
        this.toast(command ? "Wait for Claude to finish first" : "The claude-pi plugin is not loaded", "warning");
        return;
      }
      const uuid = randomUUID();
      this.conv.silence(uuid);
      this.#cc.user(`/${command.name} ${level}`, { uuid });
      this.conv.effort = level;
      this.toast(`Effort: ${level}`);
      return;
    }
    try {
      await this.#cc.request("apply_flag_settings", { settings: { effortLevel: level } });
      await this.#refreshSettings();
      this.conv.effort ||= level;
      this.toast(`Effort: ${this.conv.effort}`);
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
  }

  async #cycleModel(): Promise<void> {
    const models = this.#models.filter(model => model.value !== "default");
    if (models.length < 2) {
      this.toast("Only one model is available", "warning");
      return;
    }
    const at = models.findIndex(model => model.value === this.#modelValue);
    await this.#setModel(models[(at + 1) % models.length]!);
  }

  async #setModel(model: ModelInfo): Promise<void> {
    try {
      const result = await this.#cc.request("set_model", { model: model.value });
      if (result?.model) this.conv.model = String(result.model);
      this.#modelValue = model.value;
      await this.#refreshSettings(model.value);
      void this.#refreshContext(true);
      this.toast(`Model: ${this.#modelName(model)}`);
    } catch (error) {
      this.toast(`Could not switch model: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  /** Sets the permission mode; false when Claude Code refused it (said so unless `quiet`). */
  async #setMode(mode: string, quiet = false): Promise<boolean> {
    if (mode === "bypassPermissions" && !this.#launch.allowBypass) {
      this.toast("Start with --allow-dangerously-skip-permissions to be able to bypass permissions", "warning");
      return false;
    }
    try {
      const result = await this.#cc.request("set_permission_mode", { mode });
      this.conv.permissionMode = String(result?.mode ?? mode);
      this.conv.touch();
      if (this.conv.permissionMode !== mode && mode !== "default") return false;
      this.toast(`${MODES[this.conv.permissionMode]?.label ?? this.conv.permissionMode} mode`);
      return true;
    } catch (error) {
      if (!quiet) this.toast(firstLine((error as Error).message, 160), "error");
      return false;
    }
  }

  async #cycleMode(): Promise<void> {
    const auto = this.#modelInfo()?.supportsAutoMode === true;
    const cycle = [...MODE_CYCLE.filter(mode => mode !== "auto" || auto), ...(this.#launch.allowBypass ? ["bypassPermissions"] : [])];
    const at = cycle.indexOf(this.conv.permissionMode === "manual" ? "default" : this.conv.permissionMode);
    // A mode Claude Code refuses here (auto without the entitlement) is stepped over.
    for (let step = 1; step <= cycle.length; step += 1) {
      const mode = cycle[(at + step) % cycle.length]!;
      if (await this.#setMode(mode, step < cycle.length)) return;
    }
  }

  #setModeArg(args: string): void | Promise<void> {
    const want = args.trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (!want) return this.#pickMode();
    const alias: Record<string, string> = { ask: "default", default: "default", manual: "default", normal: "default", edits: "acceptEdits", acceptedits: "acceptEdits", accept: "acceptEdits", plan: "plan", auto: "auto", bypass: "bypassPermissions", bypasspermissions: "bypassPermissions", yolo: "bypassPermissions", dontask: "dontAsk" };
    const mode = alias[want];
    if (!mode) {
      this.toast(`Unknown mode "${args.trim()}". Try ask, edits, plan or auto`, "warning");
      return;
    }
    return void this.#setMode(mode);
  }

  /** `/plan`: plan mode on (or off when it is on); with text, on and sent. */
  async #planCommand(args: string): Promise<void> {
    if (!args && this.conv.permissionMode === "plan") return void (await this.#setMode("default"));
    if (this.conv.permissionMode !== "plan") await this.#setMode("plan");
    if (args) await this.#submit(args);
  }

  // ───────────────────────────────────────────────────────────── pickers

  #openPicker(options: PickerOptions): Picker {
    if (this.#picker) this.#closePicker();
    this.#completion = null;
    this.#picker = new Picker(options);
    this.schedule();
    return this.#picker;
  }

  #closePicker(): void {
    const picker = this.#picker;
    this.#picker = null;
    picker?.options.cancel?.();
    this.schedule();
  }

  async #choose(picker: Picker): Promise<void> {
    if (picker.confirm) return this.#pickerAction(picker, picker.confirm.act, undefined);
    const id = picker.selected;
    if (!id) return;
    const item = picker.items.find(entry => entry.id === id);
    if (item?.disabled) return;
    await picker.options.choose(id, picker);
    this.schedule();
  }

  async #pickerAction(picker: Picker, act: string, value: string | undefined): Promise<void> {
    if (act === "close" || act === "cancel") return this.#closePicker();
    if (act === "tab" && value) {
      picker.tab = value;
      picker.refilter(true);
    } else if (act === "scope" && value) {
      picker.scope = value;
      picker.refilter(true);
    } else if (picker.options.actions.find(action => action.id === act)?.primary) await this.#choose(picker);
    else await picker.options.act?.(act, picker.selected, picker);
    this.schedule();
  }

  async #pickerKey(picker: Picker, key: Key): Promise<void> {
    const result = picker.key(key);
    if (result.type === "close") this.#closePicker();
    else if (result.type === "choose") await this.#choose(picker);
    else if (result.type === "act") await this.#pickerAction(picker, result.act, undefined);
  }

  /** Asks Claude Code for what a sheet shows; `null` when it failed or the user moved on meanwhile. */
  async #load(subtype: string, timeout = 20_000): Promise<any | null> {
    const ticket = this.#keySeq;
    const slow = setTimeout(() => ticket === this.#keySeq && this.toast("Asking Claude Code…"), 700);
    try {
      const result = await this.#cc.request(subtype, {}, timeout);
      return ticket === this.#keySeq ? result : null;
    } catch (error) {
      if (ticket === this.#keySeq) this.toast(firstLine((error as Error).message, 160), "error");
      return null;
    } finally {
      clearTimeout(slow);
    }
  }

  /** The standard pair of actions of a picker that chooses one thing. */
  #chooseActions(label: string): PickerOptions["actions"] {
    return [
      { id: "use", label, keys: ["enter"], primary: true },
      { id: "close", label: "Close", keys: ["esc"], end: true },
    ];
  }

  #kv(k: string, v: string): { k: ReturnType<typeof s>[]; v: ReturnType<typeof s>[] } {
    return { k: [s(k, "muted")], v: [s(v, "mono")] };
  }

  #pickModel(query = ""): void {
    if (!this.#models.length) {
      this.toast("Claude Code listed no models", "warning");
      return;
    }
    // `/model sonnet` switches at once when it names one.
    const direct = query.trim() ? this.#models.find(model => model.value === query.trim() || model.displayName.toLowerCase() === query.trim().toLowerCase()) : undefined;
    if (direct) return void this.#setModel(direct);
    const byId = new Map(this.#models.map(model => [model.value, model]));
    const current = this.#modelValue;
    const items: PickerItem[] = this.#models.map(model => ({
      id: model.value,
      label: model.value === "default" ? "Default" : this.#modelName(model),
      detail: model.value === "default" ? `${this.#modelName(model)} · recommended` : firstLine(model.description.replace(/^[^·]*·\s*/, ""), 90),
      mark: { text: this.#modelName(model), seed: this.#modelIcon(model), icon: this.#modelIcon(model) },
      search: `${model.value} ${model.displayName} ${model.description} ${model.resolvedModel ?? ""}`,
      facts: { id: /^claude-/.test(model.value) ? model.value : (model.resolvedModel ?? model.value) },
      badges: [...(model.supportsEffort ? [{ text: "effort" }] : []), ...(model.supportsFastMode ? [{ text: "fast" }] : []), ...(model.supportsAutoMode ? [{ text: "auto mode" }] : [])],
    }));
    const picker = this.#openPicker({
      props: { title: "Models", icon: "cpu", noun: "models", size: "lg", layout: "rows", preview: "side", placeholder: "Search models…", columns: [{ id: "id", head: "Id", format: "dim", priority: 1 }] },
      items,
      selected: current || null,
      current: current ? [current] : [],
      searchable: true,
      actions: this.#chooseActions("Use model"),
      empty: "No models match",
      preview: id => {
        const model = id ? byId.get(id) : undefined;
        if (!model) return [];
        return [
          h("text", { key: "title", role: "omp.picker.title", text: this.#modelName(model) }),
          h("text", { key: "id", truncate: "middle", title: "Copy model id", spans: [s(model.resolvedModel ?? model.value, "mono")], onClick: () => this.copy(model.resolvedModel ?? model.value, "Model id") }),
          h("text", { key: "about", wrap: "word", spans: [s(model.description, "muted")] }),
          h("row", { key: "badges", gap: "xs", wrap: true }, [
            model.value === current ? h("badge", { key: "current", text: "current", tone: "success" }) : null,
            model.supportsEffort ? h("badge", { key: "effort", text: "effort" }) : null,
            model.supportsAdaptiveThinking ? h("badge", { key: "adaptive", text: "adaptive thinking" }) : null,
            model.supportsFastMode ? h("badge", { key: "fast", text: "fast mode" }) : null,
            model.supportsAutoMode ? h("badge", { key: "auto", text: "auto mode" }) : null,
          ]),
          model.supportedEffortLevels?.length ? h("kv", { key: "facts", items: [this.#kv("Effort levels", model.supportedEffortLevels.join(" · "))] }) : null,
        ].filter((node): node is Node => node !== null);
      },
      choose: async id => {
        const model = byId.get(id);
        this.#picker = null;
        if (model) await this.#setModel(model);
      },
    });
    if (query) {
      picker.query.set(query);
      picker.refilter(true);
    }
  }

  #pickEffort(): void {
    const levels = this.#levels();
    if (levels.length < 2) {
      this.toast(`${this.#modelName()} has no effort levels`, "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Effort", icon: "gauge", noun: "levels", size: "md", layout: "rows", preview: "none" },
      items: levels.map(level => ({ id: level, label: level, detail: EFFORT_DETAIL[level] ?? "" })),
      selected: this.conv.effort || null,
      current: this.conv.effort ? [this.conv.effort] : [],
      searchable: false,
      actions: this.#chooseActions("Select"),
      choose: async id => {
        this.#picker = null;
        await this.#setEffort(id);
      },
    });
  }

  #pickMode(): void {
    const auto = this.#modelInfo()?.supportsAutoMode === true;
    const modes = ["default", "acceptEdits", "plan", ...(auto ? ["auto"] : []), "dontAsk", ...(this.#launch.allowBypass ? ["bypassPermissions"] : [])];
    const current = this.conv.permissionMode === "manual" ? "default" : this.conv.permissionMode;
    this.#openPicker({
      props: { title: "Permission mode", icon: "shield", noun: "modes", size: "md", layout: "rows", preview: "none" },
      items: modes.map(mode => ({ id: mode, label: MODES[mode]!.label, detail: MODES[mode]!.hint, icon: MODES[mode]!.icon })),
      selected: current,
      current: [current],
      searchable: false,
      actions: this.#chooseActions("Select"),
      choose: async id => {
        this.#picker = null;
        await this.#setMode(id);
      },
    });
  }

  #sessionItems(rows: SessionRow[]): PickerItem[] {
    return rows.map(row => ({
      id: row.path,
      label: row.name || row.title || "(empty session)",
      detail: [row.cwd === this.#cwd ? "" : showPath(row.cwd, ""), row.name ? row.title : row.preview].filter(Boolean).join(" · ") || undefined,
      icon: "session",
      search: `${row.title} ${row.name} ${row.cwd} ${row.id}`,
      group: row.cwd === this.#cwd ? "here" : "elsewhere",
      facts: { when: row.when, size: row.size },
      ...(row.branch ? { badges: [{ text: row.branch }] } : {}),
    }));
  }

  #pickSession(query = ""): void {
    let rows = listSessions(this.#cwd);
    const byPath = (): Map<string, SessionRow> => new Map(rows.map(row => [row.path, row]));
    let index = byPath();
    const current = this.conv.sessionId ? sessionFile(this.#cwd, this.conv.sessionId) : "";
    const picker = this.#openPicker({
      props: {
        icon: "history",
        noun: "sessions",
        size: "lg",
        layout: "cards",
        preview: "side",
        placeholder: `Search sessions in ${showPath(this.#cwd, "").split("/").at(-1)}…`,
        columns: [
          { id: "when", format: "dim" },
          { id: "size", format: "dim" },
        ],
      },
      items: this.#sessionItems(rows),
      current: current ? [current] : [],
      searchable: true,
      scopes: [
        { id: "here", label: "This folder", icon: "folder", test: item => item.group === "here" },
        { id: "all", label: "All projects", icon: "list", test: () => true },
      ],
      scope: rows.some(row => row.cwd === this.#cwd) ? "here" : "all",
      actions: [
        { id: "resume", label: "Resume", keys: ["enter"], primary: true },
        { id: "fork", label: "Fork", keys: ["ctrl", "f"] },
        { id: "delete", label: "Delete", keys: ["ctrl", "d"], danger: true },
        { id: "scope", label: "All projects", keys: ["ctrl", "a"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No sessions yet",
      preview: id => {
        const row = id ? index.get(id) : undefined;
        if (!row) return [];
        return [
          h("text", { key: "title", role: "omp.picker.title", text: row.name || row.title || "(empty session)" }),
          h("text", { key: "meta", spans: [s(`${row.size} · ${row.when}${row.branch ? ` · ${row.branch}` : ""}`, "muted")] }),
          h("text", { key: "cwd", truncate: "middle", spans: [s(showPath(row.cwd, ""), "mono dim")] }),
          h("md", { key: "recent", text: row.previewMessages.map(message => `**${message.role === "user" ? "You" : "Claude"}** ${message.text}`).join("\n\n") }),
        ];
      },
      choose: async id => {
        const row = index.get(id);
        this.#picker = null;
        if (row && id !== current) await this.#resume(row, false);
      },
      act: async (act, id, picker) => {
        const row = id ? index.get(id) : undefined;
        if (act === "scope") {
          picker.scope = picker.scope === "all" ? "here" : "all";
          picker.refilter(true);
        } else if (act === "fork" && row) {
          this.#picker = null;
          await this.#resume(row, true);
        } else if (act === "delete" && row) {
          if (row.path === current) {
            this.toast("The open session cannot be deleted", "warning");
            return;
          }
          picker.confirm = { text: `Delete “${firstLine(row.name || row.title || "this session", 60)}”? This removes the session file.`, act: "delete-confirm", label: "Delete" };
        } else if (act === "delete-confirm" && row) {
          picker.confirm = null;
          try {
            rmSync(row.path);
            rmSync(row.path.replace(/\.jsonl$/, ""), { recursive: true, force: true });
            rows = rows.filter(entry => entry !== row);
            index = byPath();
            picker.setItems(this.#sessionItems(rows));
            this.toast("Session deleted");
          } catch (error) {
            this.toast(`Could not delete: ${(error as Error).message}`, "error");
          }
        }
      },
    });
    if (query) {
      picker.query.set(query);
      picker.refilter(true);
    }
  }

  /** Opens a stored session: in its own folder, as itself or as a copy. */
  async #resume(row: SessionRow, fork: boolean): Promise<void> {
    if (this.conv.busy) await this.#interrupt();
    if (row.cwd && row.cwd !== this.#cwd && existsSync(row.cwd)) {
      this.#cwd = row.cwd;
      this.#files = new FileIndex(row.cwd);
      this.toast(`Working in ${showPath(row.cwd, "")}`);
    }
    await this.#restart({ resume: row.id, fork }, row.path);
    if (fork) this.toast("Forked into a new session");
  }

  async #continueLast(): Promise<void> {
    const row = listSessions(this.#cwd, 60).find(entry => entry.cwd === this.#cwd && entry.id !== this.conv.sessionId);
    if (!row) {
      this.toast("No earlier session in this folder", "warning");
      return;
    }
    await this.#resume(row, false);
  }

  /** `/clear`: Claude Code starts a new conversation in the same process. */
  async #newSession(): Promise<void> {
    if (this.conv.busy) await this.#interrupt();
    this.#attachments = [];
    if (this.#cc.exited) return this.#start({ model: this.#modelValue || null, permissionMode: this.conv.permissionMode, effort: this.conv.effort || null, sessionId: randomUUID() });
    const uuid = randomUUID();
    this.conv.silence(uuid);
    this.#cc.user("/clear", { uuid });
  }

  /** `/branch`: this conversation, copied into a new session. */
  async #branch(): Promise<void> {
    const id = this.conv.sessionId;
    if (!id || !existsSync(sessionFile(this.#cwd, id))) {
      this.toast("Nothing to copy yet", "warning");
      return;
    }
    if (this.conv.busy) await this.#interrupt();
    await this.#restart({ resume: id, fork: true }, sessionFile(this.#cwd, id));
    this.toast("Copied into a new session");
  }

  #rename(args: string): void {
    const apply = async (name: string): Promise<void> => {
      try {
        await this.#cc.request("rename_session", { title: name, source: "host" });
        this.conv.sessionName = name;
        this.toast(`Session named “${firstLine(name, 60)}”`);
      } catch (error) {
        this.toast(`Could not rename: ${firstLine((error as Error).message, 160)}`, "error");
      }
      this.schedule();
    };
    if (args.trim()) return void apply(args.trim());
    this.#openField({ title: "Name this session", placeholder: "Session name", multiline: false, text: this.conv.sessionName, done: value => void (value?.trim() && apply(value.trim())) });
  }

  async #addDir(args: string): Promise<void> {
    const raw = args.trim().replace(/^['"]|['"]$/g, "");
    if (!raw) {
      this.toast("Usage: /add-dir <path>", "warning");
      return;
    }
    const path = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(this.#cwd, raw);
    if (!existsSync(path)) {
      this.toast(`No such folder: ${raw}`, "error");
      return;
    }
    // Working folders are fixed when Claude Code starts: the session goes on in a process that has this one too.
    this.#launch.base.push("--add-dir", path);
    const id = this.conv.sessionId;
    const stored = id && existsSync(sessionFile(this.#cwd, id));
    if (this.conv.busy) await this.#interrupt();
    await this.#restart(stored ? { resume: id } : { sessionId: randomUUID() }, stored ? sessionFile(this.#cwd, id) : null);
    this.toast(`Added ${showPath(path, this.#cwd)}`);
  }

  // ───────────────────────────────────────────────────────────── rewind, fork

  /** The user messages a conversation can go back to. */
  #rewindPoints(): Item[] {
    return this.conv.items.filter(item => item.kind === "user" && item.uuid && item.confirmed !== false && !/^\/\S/.test(item.text));
  }

  /**
   * Opens the rewind page: the transcript stays in view with the chosen
   * message marked and what follows it dimmed, until Enter goes back to it.
   */
  async #rewindTo(item?: Item): Promise<void> {
    if (this.conv.busy) {
      this.toast("Stop Claude before rewinding", "warning");
      return;
    }
    const entries = this.#rewindPoints();
    if (!entries.length) {
      this.toast("Nothing to rewind to yet", "warning");
      return;
    }
    const at = item ? entries.indexOf(item) : entries.length - 1;
    this.#completion = null;
    this.#rewind = { entries, at: at < 0 ? entries.length - 1 : at, mode: "both", files: new Map() };
    this.#revealRewind();
  }

  /** What going back to the chosen message would do to the files, asked once per message. */
  #rewindFiles(rewind: RewindState): string {
    const item = rewind.entries[rewind.at]!;
    const known = rewind.files.get(item.id);
    if (known !== undefined) return known;
    rewind.files.set(item.id, "Checking the files…");
    void this.#cc
      .request("rewind_files", { user_message_id: item.uuid, dry_run: true }, 15_000)
      .then(result => {
        const count = Array.isArray(result?.filesChanged) ? result.filesChanged.length : 0;
        rewind.files.set(item.id, result?.canRewind === false ? "No file checkpoint here: files are left as they are." : count ? `${count} ${count === 1 ? "file is" : "files are"} restored (+${result.insertions ?? 0} −${result.deletions ?? 0}).` : "No files changed since.");
      })
      .catch(() => rewind.files.set(item.id, "No file checkpoint here: files are left as they are."))
      .finally(() => this.schedule());
    return rewind.files.get(item.id)!;
  }

  /**
   * The rewind page: a screen of its own replaying the transcript, the chosen
   * message marked and everything after it dimmed, over the panel that
   * confirms. The session's own surface stays as it is underneath.
   */
  #renderRewind(rewind: RewindState, built: readonly Node[]): void {
    const page = (this.#rewindPage ??= (() => {
      const opened = this.#session.open({ id: `${SURFACE.id}-rewind`, mode: "screen", title: "Rewind", role: "omp.rewind", font: "sans" });
      if (this.#session.caps.features.includes("styles")) opened.stylesheet("claude-tsp", stylesheet(this.#clay));
      return opened;
    })());
    const order = new Map(this.conv.items.map((item, index) => [item.id, index]));
    const pick = order.get(rewind.entries[rewind.at]!.id) ?? 0;
    let dropped = 0;
    const blocks = built.map(node => {
      const at = order.get(String(node.props["key"])) ?? -1;
      if (at < pick) return node;
      if (at > pick) dropped += 1;
      return new TernNode(node.kind, { ...node.props, mark: at === pick ? "pick" : "drop" }, node.children, node.handlers, node.slots);
    });
    const panel = rewindPanel(
      { text: firstLine(rewind.entries[rewind.at]!.text, 200), dropped, index: rewind.at + 1, total: rewind.entries.length, files: this.#rewindFiles(rewind), mode: rewind.mode },
      {
        confirm: () => void this.#confirmRewind(),
        cancel: () => this.#closeRewind(),
        mode: () => {
          rewind.mode = rewind.mode === "both" ? "conversation" : rewind.mode === "conversation" ? "files" : "both";
          this.schedule();
        },
      },
    );
    page.render({ main: h("col", { key: "main" }, blocks), dock: h("col", { key: "dock" }, [panel]) });
  }

  #closeRewind(): void {
    this.#rewind = null;
    const page = this.#rewindPage;
    this.#rewindPage = null;
    void page?.close({ keep: false });
    this.#focus = undefined;
    this.schedule();
  }

  #revealRewind(): void {
    const rewind = this.#rewind;
    if (!rewind) return;
    this.render();
    this.#rewindPage?.reveal(`main.${rewind.entries[rewind.at]!.id}`, "nearest");
  }

  #rewindKey(rewind: RewindState, key: Key): Promise<void> | void {
    switch (key.name) {
      case "escape":
        return this.#closeRewind();
      case "enter":
        return this.#confirmRewind();
      case "tab":
        rewind.mode = rewind.mode === "both" ? "conversation" : rewind.mode === "conversation" ? "files" : "both";
        return;
      case "up":
      case "k":
        rewind.at = Math.max(0, rewind.at - 1);
        return this.#revealRewind();
      case "down":
      case "j":
        rewind.at = Math.min(rewind.entries.length - 1, rewind.at + 1);
        return this.#revealRewind();
      case "home":
        rewind.at = 0;
        return this.#revealRewind();
      case "end":
        rewind.at = rewind.entries.length - 1;
        return this.#revealRewind();
      default:
        return;
    }
  }

  async #confirmRewind(): Promise<void> {
    const rewind = this.#rewind;
    const item = rewind?.entries[rewind.at];
    this.#closeRewind();
    if (!rewind || !item) return;
    try {
      if (rewind.mode !== "conversation") {
        const result = await this.#cc.request("rewind_files", { user_message_id: item.uuid }, 30_000).catch(() => null);
        if (rewind.mode === "files") {
          this.toast(result?.canRewind === false ? "No file checkpoint at that message" : "Files restored", result?.canRewind === false ? "warning" : "info");
          return;
        }
      }
      await this.#goBack(item, false);
      this.toast("Rewound: edit the message and send");
    } catch (error) {
      this.toast(`Could not rewind: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  /** Continues the session from just before `item`, as itself or as a copy; the message returns to the composer. */
  async #goBack(item: Item, fork: boolean): Promise<void> {
    const id = this.conv.sessionId;
    const at = this.conv.items.indexOf(item);
    // The session is resumed at the last thing Claude said before the message.
    const before = this.conv.items.slice(0, at).findLast(entry => (entry.kind === "assistant" || entry.kind === "tool" || entry.kind === "agent") && entry.uuid);
    const path = id ? sessionFile(this.#cwd, id) : "";
    if (!before?.uuid || !path || !existsSync(path)) await this.#restart({ sessionId: randomUUID() }, null);
    else await this.#resumeAt(id, before.uuid, path, fork);
    this.editor.set(item.text);
    this.#attachments = (item.images ?? []).map((image, index) => ({ ...image, name: `image ${index + 1}` }));
  }

  #pickFork(): void {
    if (this.conv.busy) {
      this.toast("Stop Claude before forking", "warning");
      return;
    }
    const entries = this.#rewindPoints();
    if (!entries.length) {
      this.toast("No messages to fork from yet", "warning");
      return;
    }
    const byId = new Map(entries.map(item => [item.id, item]));
    this.#openPicker({
      props: { title: "Fork from a message", icon: "fork", noun: "messages", size: "lg", layout: "timeline", preview: "side", placeholder: "Search your messages…" },
      items: entries.map(item => ({ id: item.id, label: firstLine(item.text, 110) || "(image)", node: "user" as const, facts: { when: clock(item.at, this.#session.caps.hour12) } })),
      selected: entries.at(-1)?.id ?? null,
      actions: this.#chooseActions("Fork here"),
      preview: id => (id && byId.get(id) ? [h("md", { key: "text", text: byId.get(id)!.text })] : []),
      choose: async id => {
        this.#picker = null;
        const item = byId.get(id);
        if (!item) return;
        try {
          await this.#goBack(item, true);
          this.toast("Forked: edit the message and send");
        } catch (error) {
          this.toast(`Could not fork: ${firstLine((error as Error).message, 160)}`, "error");
        }
      },
    });
  }

  /** Continues the session from one of its messages; if Claude Code refuses the point, the session is opened as it was. */
  async #resumeAt(id: string, uuid: string, path: string, fork = false): Promise<void> {
    await this.#restart({ resume: id, resumeAt: uuid, fork }, path, uuid);
    if (!this.#cc.exited) return;
    this.#lastError = "";
    await this.#restart({ resume: id }, path);
    this.toast("Claude Code could not continue from that message; the session is as it was", "warning");
  }

  /** `/tree`: every message of the session, old branches included; Enter continues from one. */
  #pickTree(): void {
    if (this.conv.busy) {
      this.toast("Stop Claude before moving in the session", "warning");
      return;
    }
    const id = this.conv.sessionId;
    const path = id ? sessionFile(this.#cwd, id) : "";
    if (!path || !existsSync(path)) {
      this.toast("This session has no history yet", "warning");
      return;
    }
    let entries: Record<string, any>[];
    try {
      entries = readEntries(path);
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
      return;
    }
    const nodes = sessionTree(entries);
    if (!nodes.length) {
      this.toast("This session has no history yet", "warning");
      return;
    }
    const byId = new Map(nodes.map(node => [node.uuid, node]));
    const leaf = nodes.findLast(node => node.live)?.uuid ?? null;
    let summary = "";
    this.#openPicker({
      props: { title: "Session tree", icon: "branch", noun: "messages", size: "lg", layout: "tree", preview: "side", placeholder: "Search the session…" },
      items: nodes.map(node => ({ id: node.uuid, label: plainLabel(firstLine(node.text, 110)), node: node.role, depth: node.depth, search: node.text.slice(0, 2000), ...(node.live ? {} : { badges: [{ text: "other branch", tone: "muted" }] }) })),
      selected: leaf,
      current: leaf ? [leaf] : [],
      searchable: true,
      actions: [
        { id: "go", label: "Go here", keys: ["enter"], primary: true },
        { id: "summarize", label: "Go here, summarizing what is left", keys: ["ctrl", "s"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: uuid => (uuid && byId.get(uuid) ? [h("md", { key: "text", text: byId.get(uuid)!.text.slice(0, 20_000) })] : []),
      act: async (act, uuid, picker) => {
        if (act !== "summarize" || !uuid || uuid === leaf) return;
        // The branch being left is put into a few lines by Claude, beside the conversation, before the move.
        picker.state = "loading";
        picker.message = "Summarizing the branch you are leaving…";
        this.schedule();
        try {
          const result = await this.#cc.request("side_question", { question: `I am going back to an earlier point of this conversation, the message that begins "${firstLine(byId.get(uuid)?.text ?? "", 160)}". Summarize what happened after that point, for continuing from there: what was decided, which files or commands were touched and how, and what was left open. Plain sentences, under 150 words, no preamble.` }, 180_000);
          summary = String(result?.response ?? "").trim();
        } catch (error) {
          this.toast(`Could not summarize: ${firstLine((error as Error).message, 160)}`, "warning");
        }
        picker.state = "ready";
        if (this.#picker === picker) await picker.options.choose(uuid, picker);
      },
      choose: async uuid => {
        const node = byId.get(uuid);
        this.#picker = null;
        if (!node) return;
        try {
          // Claude Code resumes only at a message of the live branch: a message on a branch that was
          // left is reached by going to where that branch forked, with the message back in the composer.
          const byUuid = new Map(entries.filter(entry => entry.uuid).map(entry => [String(entry.uuid), entry]));
          const liveUuids = new Set(nodes.filter(entry => entry.live).map(entry => entry.uuid));
          const liveChain = new Set(liveBranch(entries).map(entry => String(entry.uuid)));
          let at: Record<string, any> | undefined = node.role === "assistant" && node.live ? byUuid.get(uuid) : byUuid.get(String(byUuid.get(uuid)?.parentUuid ?? ""));
          while (at && !(at.type === "assistant" && liveChain.has(String(at.uuid)))) at = byUuid.get(String(at.parentUuid ?? at.logicalParentUuid ?? ""));
          if (at?.uuid) await this.#resumeAt(id, String(at.uuid), path);
          else await this.#restart({ sessionId: randomUUID() }, null);
          if (node.role === "user") this.editor.set(node.text);
          else if (!liveUuids.has(uuid)) this.toast("Claude Code continues only from the live branch: moved to where that branch forked", "warning");
          if (summary && !this.#cc.exited) this.#cc.user(branchSummaryMessage(summary), { uuid: randomUUID(), shouldQuery: false });
          this.toast(summary ? "Moved, with a summary of the branch you left" : node.live ? "Moved back in the session" : "Switched to the other branch");
        } catch (error) {
          this.toast(`Could not go there: ${firstLine((error as Error).message, 160)}`, "error");
        }
      },
    });
  }

  // ───────────────────────────────────────────────────────────── more pickers

  #pickCopy(): void {
    const rows = this.conv.items.filter(item => (item.kind === "user" || item.kind === "assistant") && item.text.trim());
    if (!rows.length) {
      this.toast("Nothing to copy yet", "warning");
      return;
    }
    const byId = new Map(rows.map(item => [item.id, item]));
    this.#openPicker({
      props: { title: "Copy a message", icon: "copy", noun: "messages", size: "lg", layout: "timeline", preview: "side", placeholder: "Search messages…" },
      items: rows.map(item => ({ id: item.id, label: plainLabel(firstLine(item.text, 110)), node: item.kind === "user" ? ("user" as const) : ("assistant" as const), facts: { when: clock(item.at, this.#session.caps.hour12) }, search: item.text.slice(0, 2000) })),
      selected: rows.at(-1)?.id ?? null,
      searchable: true,
      actions: this.#chooseActions("Copy"),
      preview: id => (id && byId.get(id) ? [h("md", { key: "text", text: byId.get(id)!.text })] : []),
      choose: id => {
        this.#picker = null;
        const item = byId.get(id);
        if (item) this.copy(item.text, item.kind === "user" ? "Message" : "Answer");
      },
    });
  }

  /** The transcript's landmarks (your messages, tool calls, subagents, failures); Enter scrolls to one. */
  #pickOutline(): void {
    const rows = this.conv.items.flatMap((item): PickerItem[] => {
      const args = item.args ?? {};
      switch (item.kind) {
        case "user":
          return [{ id: item.id, label: firstLine(item.text, 110) || "(image)", node: "user", facts: { when: clock(item.at, this.#session.caps.hour12) } }];
        case "tool":
          // Reads are grouped under the first of a run, which is not always this one.
          if (item.name === "Read" || /^Task(Create|Update|Get|List)$/.test(String(item.name))) return [];
          return [{ id: item.id, label: `${toolTitle(String(item.name))}  ${firstLine(args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url ?? "", 90)}`.trim(), node: "tool", depth: 1, ...(item.status === "error" ? { tone: "error" } : {}) }];
        case "agent":
          return [{ id: item.id, label: `${item.agentType ?? "agent"}  ${firstLine(args.description ?? args.prompt ?? "", 90)}`.trim(), node: "tool", depth: 1 }];
        case "bash":
          return [{ id: item.id, label: `!${firstLine(item.text, 100)}`, node: "tool", depth: 1 }];
        case "error":
          return [{ id: item.id, label: firstLine(item.text, 110), node: "marker", tone: "error", depth: 1 }];
        case "compaction":
          return [{ id: item.id, label: "Compacted", node: "marker" }];
        default:
          return [];
      }
    });
    if (!rows.length) {
      this.toast("Nothing in the transcript yet", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Outline", icon: "list", noun: "entries", size: "md", layout: "timeline", preview: "none", placeholder: "Search the transcript…" },
      items: rows,
      selected: rows.at(-1)?.id ?? null,
      searchable: true,
      actions: this.#chooseActions("Go there"),
      choose: id => {
        this.#picker = null;
        this.render();
        const target = this.#main.locate(id);
        if (target) this.#surface.reveal(target, "start");
      },
    });
  }

  #pickHistory(): void {
    const history = [...new Set([...this.editor.history].reverse())];
    if (!history.length) {
      this.toast("No prompt history yet", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Prompt history", icon: "history", noun: "prompts", size: "lg", layout: "rows", preview: "below", placeholder: "Search your prompts…" },
      items: history.map((text, index) => ({ id: String(index), label: firstLine(text, 140), search: text.slice(0, 2000) })),
      searchable: true,
      actions: this.#chooseActions("Use prompt"),
      preview: id => (id !== null && history[Number(id)]?.includes("\n") ? [h("code", { key: "text", text: history[Number(id)]!, wrap: true })] : []),
      choose: id => {
        this.#picker = null;
        this.editor.set(history[Number(id)] ?? "");
      },
    });
  }

  /** This session's subagent runs, and the agent types Claude can start. */
  #pickAgents(): void {
    const runs = this.conv.agents();
    const types = this.#agentTypes;
    if (!runs.length && !types.length) {
      this.toast("No subagents", "warning");
      return;
    }
    const items: PickerItem[] = [
      ...runs.map(item => ({
        id: item.id,
        label: firstLine(item.args?.description ?? item.agentType ?? "agent", 100),
        detail: [item.agentType, item.model, item.background ? "background" : ""].filter(Boolean).join(" · "),
        dot: item.agentStatus === "done" ? "success" : item.agentStatus === "failed" ? "error" : item.agentStatus === "aborted" ? "muted" : "pending",
        facts: { tools: item.stats?.tools ? String(item.stats.tools) : "", tok: item.stats?.tokens ? tokens(item.stats.tokens) : "" },
        group: "runs",
      })),
      ...types.map(type => ({ id: `type:${type.name}`, label: type.name, detail: firstLine(type.description, 120), icon: "users", group: "types", ...(type.model ? { badges: [{ text: type.model }] } : {}) })),
    ];
    this.#openPicker({
      props: { title: "Subagents", icon: "users", noun: "subagents", size: "lg", layout: "rows", preview: "side", columns: [{ id: "tools", head: "Tools", format: "num" }, { id: "tok", head: "Tokens", format: "num" }] },
      items,
      tabs: [
        { id: "runs", label: "This session", test: item => item.group === "runs" },
        { id: "types", label: "Agent types", test: item => item.group === "types" },
      ],
      tab: runs.length ? "runs" : "types",
      actions: [
        { id: "open", label: "Open", keys: ["enter"], primary: true },
        { id: "stop", label: "Stop", keys: ["ctrl", "x"], danger: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No subagents in this session yet",
      preview: id => {
        const type = id?.startsWith("type:") ? types.find(entry => `type:${entry.name}` === id) : undefined;
        if (type) return [h("text", { key: "title", role: "omp.picker.title", text: type.name }), h("md", { key: "about", text: type.description })];
        const item = runs.find(agent => agent.id === id);
        return item?.output ? [h("md", { key: "output", text: item.output.slice(0, 8000) })] : [h("text", { key: "none", spans: [s(item ? "No report yet" : "", "muted")] })];
      },
      choose: id => {
        const item = runs.find(agent => agent.id === id);
        if (item) {
          this.#picker = null;
          this.#openAgent(item);
        } else if (id.startsWith("type:")) {
          this.#picker = null;
          this.editor.set(`Use the ${id.slice(5)} agent to `);
        }
      },
      act: async (act, id) => {
        const item = runs.find(agent => agent.id === id);
        if (act === "stop" && item?.taskId && (item.agentStatus === "running" || item.agentStatus === "pending")) await this.#stopTask(item.taskId, firstLine(item.args?.description ?? "subagent", 60));
      },
    });
  }

  #backgroundCount(): number {
    return this.conv.background.size + this.conv.items.filter(item => item.kind === "agent" && item.background && (item.agentStatus === "running" || item.agentStatus === "pending")).length;
  }

  /** What runs behind the conversation: background commands, monitors and subagents. */
  #pickBackground(): void {
    const agents = this.conv.items.filter(item => item.kind === "agent" && item.taskId && (item.agentStatus === "running" || item.agentStatus === "pending"));
    const tasks = [...this.conv.background.values()];
    if (!agents.length && !tasks.length) {
      this.toast("Nothing is running in the background", "warning");
      return;
    }
    const outputs = new Map<string, string>();
    const items = (): PickerItem[] => [
      ...tasks.map(task => ({ id: task.id, label: firstLine(task.description, 100), detail: task.type.replace(/^local_/, "").replace(/_/g, " "), dot: "pending", facts: { age: duration(Date.now() - task.startedAt) } })),
      ...agents.map(item => ({ id: item.taskId!, label: firstLine(item.args?.description ?? item.agentType ?? "agent", 100), detail: ["subagent", item.agentType, item.background ? "background" : ""].filter(Boolean).join(" · "), dot: "pending", facts: { age: duration(Date.now() - (item.startedAt ?? item.at)) } })),
    ];
    this.#openPicker({
      props: { title: "Running", icon: "list", noun: "tasks", size: "lg", layout: "rows", preview: "side", columns: [{ id: "age", head: "Running", format: "dim" }] },
      items: items(),
      searchable: false,
      actions: [
        { id: "open", label: "Show output", keys: ["enter"], primary: true },
        { id: "stop", label: "Stop", keys: ["ctrl", "x"], danger: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => {
        const text = id ? outputs.get(id) : undefined;
        return [text ? h("ansi", { key: "output", text: text.slice(-20_000) }) : h("text", { key: "none", spans: [s("Enter shows what it has printed so far", "muted")] })];
      },
      choose: async id => {
        const agent = agents.find(item => item.taskId === id);
        if (agent) {
          this.#picker = null;
          return this.#openAgent(agent);
        }
        try {
          const result = await this.#cc.request("get_task_output", { task_id: id }, 10_000);
          outputs.set(id, String(result?.output ?? result?.text ?? JSON.stringify(result, null, 2)));
        } catch (error) {
          outputs.set(id, firstLine((error as Error).message, 200));
        }
      },
      act: async (act, id, picker) => {
        if (act !== "stop" || !id) return;
        await this.#stopTask(id, "the task");
        this.conv.background.delete(id);
        picker.setItems(items().filter(item => item.id !== id));
        if (!picker.items.length) this.#picker = null;
      },
    });
  }

  async #pickMcp(): Promise<void> {
    // What the session reported at its start draws at once; the full status replaces it when it arrives.
    let servers: any[] = this.#mcp.map(server => ({ ...server }));
    const fresh = this.#cc.request("mcp_status", {}, 30_000).catch(() => null);
    if (!servers.length) {
      const status = await fresh;
      servers = status?.mcpServers ?? [];
      if (!servers.length) {
        this.toast("No MCP servers are configured. `claude mcp add` adds one.", "warning");
        return;
      }
    }
    const tone: Record<string, string> = { connected: "success", failed: "error", "needs-auth": "warning", pending: "pending", disabled: "muted" };
    const items = (): PickerItem[] =>
      servers.map(server => ({
        id: String(server.name),
        label: String(server.name),
        detail: [server.status, server.transport ?? server.config?.type, server.scope, server.source].filter(Boolean).join(" · "),
        dot: tone[String(server.status)] ?? "muted",
        facts: { tools: Array.isArray(server.tools) ? String(server.tools.length) : "" },
      }));
    const reload = async (picker: Picker): Promise<void> => {
      servers = (await this.#cc.request("mcp_status", {}, 15_000).catch(() => ({ mcpServers: servers }))).mcpServers ?? servers;
      picker.setItems(items());
    };
    void fresh.then(status => {
      if (!status?.mcpServers || this.#picker !== opened) return;
      servers = status.mcpServers;
      this.#mcp = servers.map(server => ({ name: String(server.name), status: String(server.status) }));
      opened.setItems(items());
      this.schedule();
    });
    const opened = this.#openPicker({
      props: { title: "MCP servers", icon: "plug", noun: "servers", size: "lg", layout: "rows", preview: "side", columns: [{ id: "tools", head: "Tools", format: "num" }] },
      items: items(),
      searchable: servers.length > 8,
      actions: [
        { id: "reconnect", label: "Reconnect", keys: ["enter"], primary: true },
        { id: "toggle", label: "Enable / disable", keys: ["ctrl", "t"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => {
        const server = servers.find(entry => entry.name === id);
        if (!server) return [];
        const tools: any[] = Array.isArray(server.tools) ? server.tools : [];
        return [
          h("text", { key: "title", role: "omp.picker.title", text: String(server.name) }),
          h("kv", { key: "facts", items: [this.#kv("Status", String(server.status)), ...(server.serverInfo?.name ? [this.#kv("Server", `${server.serverInfo.name} ${server.serverInfo.version ?? ""}`.trim())] : []), ...(server.scope ? [this.#kv("Scope", String(server.scope))] : []), ...(server.error ? [this.#kv("Error", firstLine(server.error, 200))] : [])] }),
          tools.length ? h("md", { key: "tools", text: tools.slice(0, 60).map(tool => `- \`${tool.name}\`${tool.description ? ` ${firstLine(tool.description, 100)}` : ""}`).join("\n") }) : h("text", { key: "none", spans: [s("No tools listed", "muted")] }),
        ];
      },
      choose: async (id, picker) => {
        try {
          await this.#cc.request("mcp_reconnect", { serverName: id }, 30_000);
          this.toast(`Reconnected ${id}`);
        } catch (error) {
          this.toast(`${id}: ${firstLine((error as Error).message, 160)}`, "error");
        }
        await reload(picker);
      },
      act: async (act, id, picker) => {
        const server = servers.find(entry => entry.name === id);
        if (act !== "toggle" || !server) return;
        try {
          await this.#cc.request("mcp_toggle", { serverName: id, enabled: server.status === "disabled" }, 30_000);
        } catch (error) {
          this.toast(`${id}: ${firstLine((error as Error).message, 160)}`, "error");
        }
        await reload(picker);
      },
    });
  }

  async #pickPermissions(): Promise<void> {
    const source: Record<string, string> = { userSettings: "user settings", projectSettings: "project settings", localSettings: "local settings", policySettings: "managed", flagSettings: "command line", cliArg: "command line", session: "this session", toolsNarrowing: "--tools", command: "command" };
    // The picker opens at once and fills in when Claude Code has listed its rules.
    const build = (state: Record<string, any>): PickerItem[] => {
      // Tools left out with --tools are not rules anyone wrote.
      const rules: any[] = (Array.isArray(state.rules) ? state.rules : []).filter((rule: any) => rule.source !== "toolsNarrowing");
      listedRules = rules;
      const dirs: any[] = Array.isArray(state.workspaceDirectories) ? state.workspaceDirectories : [];
      return [
      ...rules.map((rule, index) => ({
        id: `r${index}`,
        label: String(rule.rule ?? ""),
        mono: true,
        detail: [source[String(rule.source)] ?? String(rule.source ?? ""), rule.notInEffect ? "not in effect" : ""].filter(Boolean).join(" · "),
        dot: rule.behavior === "allow" ? "success" : rule.behavior === "deny" ? "error" : "warning",
        group: String(rule.behavior),
      })),
      ...dirs.map((dir, index) => ({ id: `d${index}`, label: showPath(String(dir.path ?? dir), ""), mono: true, detail: source[String(dir.source)] ?? String(dir.source ?? ""), icon: "folder", group: "dirs" })),
      { id: "cwd", label: showPath(String(state.originalCwd ?? this.#cwd), ""), mono: true, detail: "where the session started", icon: "folder", group: "dirs" },
      ];
    };
    let listedRules: any[] = [];
    let items = build({});
    const count = (group: string): number => items.filter(item => item.group === group).length;
    void this.#cc
      .request("list_permission_rules", {}, 60_000)
      .then(listed => {
        if (this.#picker !== opened) return;
        items = build(listed?.state ?? {});
        opened.state = "ready";
        opened.tab = count("allow") ? "allow" : count("ask") ? "ask" : count("deny") ? "deny" : "dirs";
        opened.setItems(items);
      })
      .catch(error => {
        if (this.#picker !== opened) return;
        opened.state = "error";
        opened.message = firstLine((error as Error).message, 160);
      })
      .finally(() => this.schedule());
    const opened = this.#openPicker({
      props: { title: "Permissions", subtitle: `Mode: ${MODES[this.conv.permissionMode]?.label ?? this.conv.permissionMode}`, icon: "shield", noun: "rules", size: "lg", layout: "rows", preview: "none", placeholder: "Search rules…" },
      items,
      searchable: true,
      tabs: [
        { id: "allow", label: "Allow", test: item => item.group === "allow" },
        { id: "ask", label: "Ask", test: item => item.group === "ask" },
        { id: "deny", label: "Deny", test: item => item.group === "deny" },
        { id: "dirs", label: "Folders", test: item => item.group === "dirs" },
      ],
      tab: "allow",
      actions: [
        { id: "copy", label: "Copy rule", keys: ["enter"], primary: true },
        { id: "mode", label: "Change mode", keys: ["ctrl", "t"] },
        { id: "add", label: "Add rule", keys: ["ctrl", "n"] },
        { id: "remove", label: "Remove rule", keys: ["ctrl", "d"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No rules here",
      choose: id => this.copy(items.find(item => item.id === id)?.label ?? "", "Rule"),
      act: (act, id, picker) => {
        if (act === "mode") {
          this.#picker = null;
          this.#pickMode();
        } else if (act === "add") {
          const behavior = (["allow", "ask", "deny"].includes(picker.tab ?? "") ? picker.tab : "allow") as Behavior;
          this.#picker = null;
          void this.#addRule(behavior);
        } else if (act === "remove") {
          const index = id?.startsWith("r") ? Number(id.slice(1)) : -1;
          const rule = listedRules[index];
          if (!rule) return;
          if (!(String(rule.source) in SCOPES)) {
            this.toast(`This rule comes from ${source[String(rule.source)] ?? String(rule.source)} and cannot be removed here`, "warning");
            return;
          }
          try {
            const path = settingsPath(rule.source as Scope, configDir(), this.#cwd);
            if (!removeRule(path, rule.behavior as Behavior, String(rule.rule))) throw new Error(`it is not in ${showPath(path, "")}`);
            this.toast(`Removed ${String(rule.rule)}`, "success");
          } catch (error) {
            this.toast(`Could not remove the rule: ${firstLine((error as Error).message, 160)}`, "error");
            return;
          }
          this.#picker = null;
          void this.#rulesSettled(String(rule.rule), false).then(() => this.#pickPermissions());
        }
      },
    });
    opened.state = "loading";
    opened.message = "Asking Claude Code for its rules…";
  }

  /** A new permission rule: what it matches, then which settings file holds it. */
  async #addRule(behavior: Behavior): Promise<void> {
    const typed = await this.#askText({ title: `Add a rule: ${behavior}`, detail: "A tool name, or a tool with a pattern: `Bash(npm run test:*)`, `Read(~/.zshrc)`, `WebFetch(domain:example.com)`, `mcp__server__tool`.", placeholder: "Bash(npm run test:*)" });
    const rule = typed?.trim();
    if (!rule) return;
    if (!validRule(rule)) {
      this.toast("A rule is a tool name, optionally with a pattern in brackets", "warning");
      return;
    }
    const scope = await this.#pickOne({ title: `Where should "${firstLine(rule, 60)}" be saved?`, subtitle: `${behavior[0]!.toUpperCase()}${behavior.slice(1)} rule`, icon: "shield" }, (Object.keys(SCOPES) as Scope[]).reverse().map(scope => ({ id: scope, label: SCOPES[scope], detail: showPath(settingsPath(scope, configDir(), this.#cwd), "") })));
    if (!scope) return;
    try {
      const path = settingsPath(scope as Scope, configDir(), this.#cwd);
      this.toast(addRule(path, behavior, rule) ? `Rule added to ${showPath(path, "")}` : "That rule is already there", "success");
    } catch (error) {
      this.toast(`Could not add the rule: ${firstLine((error as Error).message, 160)}`, "error");
      return;
    }
    if (!(await this.#rulesSettled(rule, true))) this.toast("Saved, but this session does not read that settings file (it was started with --setting-sources): the rule applies to sessions that do", "warning");
    await this.#pickPermissions();
  }

  /** Waits until Claude Code has noticed a settings file change: the rule listed, or gone. False when it never does. */
  async #rulesSettled(rule: string, present: boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const listed = await this.#cc.request("list_permission_rules", {}, 20_000).catch(() => null);
      const rules: any[] = Array.isArray(listed?.state?.rules) ? listed.state.rules : [];
      if (rules.some(entry => String(entry.rule) === rule) === present) return true;
    }
    return false;
  }

  /** The skills and commands Claude Code runs itself; choosing one puts it in the composer. */
  #pickSkills(): void {
    const local = new Set(this.#commands().filter(command => command.run).map(command => command.name));
    const remote = this.#remote.filter(command => !local.has(command.name) && !command.name.startsWith("__"));
    if (!remote.length) {
      this.toast("No skills or commands are available", "warning");
      return;
    }
    this.#openPicker({
      props: { title: "Skills and commands", icon: "sparkles", noun: "commands", size: "lg", layout: "rows", preview: "below", placeholder: "Search skills…" },
      items: remote.map(command => ({ id: command.name, label: `/${command.name}`, mono: true, detail: firstLine(command.description, 110), icon: command.icon, search: command.description, group: command.icon === "sparkles" ? "skills" : "builtin", ...(command.hint ? { badges: [{ text: command.hint }] } : {}) })),
      searchable: true,
      tabs: [
        { id: "all", label: "All", test: () => true },
        { id: "skills", label: "Skills and plugins", test: item => item.group === "skills" },
        { id: "builtin", label: "Built in", test: item => item.group === "builtin" },
      ],
      actions: this.#chooseActions("Use"),
      preview: id => {
        const command = remote.find(entry => entry.name === id);
        return command ? [h("text", { key: "about", wrap: "word", spans: [s(command.description, "muted")] })] : [];
      },
      choose: id => {
        this.#picker = null;
        this.editor.set(`/${id} `);
      },
    });
  }

  #pickOutputStyle(args: string): void {
    const apply = async (style: string): Promise<void> => {
      try {
        await this.#cc.request("update_settings", { source: "localSettings", settings: { outputStyle: style } });
        this.#outputStyle = style;
        this.toast(`Output style: ${style}`);
      } catch (error) {
        this.toast(firstLine((error as Error).message, 200), "error");
      }
      this.schedule();
    };
    const named = this.#outputStyles.find(style => style.toLowerCase() === args.trim().toLowerCase());
    if (named) return void apply(named);
    if (!this.#outputStyles.length) {
      this.toast("No output styles are available", "warning");
      return;
    }
    const about: Record<string, string> = { default: "Claude completes coding tasks efficiently and concisely", Explanatory: "Claude explains its choices and the codebase's patterns", Learning: "Claude pauses and asks you to write small pieces of code", Concise: "Short answers", Proactive: "Claude takes the next step without being asked" };
    this.#openPicker({
      props: { title: "Output style", subtitle: "Saved for this project", icon: "edit", noun: "styles", size: "md", layout: "rows", preview: "none" },
      items: this.#outputStyles.map(style => ({ id: style, label: style, detail: about[style] ?? "" })),
      selected: this.#outputStyle,
      current: [this.#outputStyle],
      searchable: false,
      actions: this.#chooseActions("Select"),
      choose: async id => {
        this.#picker = null;
        await apply(id);
      },
    });
  }

  // ───────────────────────────────────────────────────────────── dialogs, sheets

  #openField(options: { title: string; detail?: string; link?: string; placeholder: string; multiline: boolean; text: string; done(value: string | null): void }): void {
    if (this.#field) this.#closeField(null);
    const lines = options.title.split("\n");
    const editor = new TextEditor();
    editor.set(options.text);
    this.#field = { title: lines[0]?.trim() ?? "", detail: [lines.slice(1).join("\n").trim(), options.detail ?? ""].filter(Boolean).join("\n"), placeholder: options.placeholder, multiline: options.multiline, editor, done: options.done, ...(options.link ? { link: options.link } : {}) };
    this.schedule();
  }

  #closeField(value: string | null): void {
    const field = this.#field;
    if (!field) return;
    this.#field = null;
    field.done(value);
    this.schedule();
  }

  #closeSheet(): void {
    this.#sheet = null;
    this.schedule();
  }

  #sheetKey(key: Key): void {
    if (key.name === "escape" || key.name === "enter" || key.name === "q") return this.#closeSheet();
    if (this.#sheet?.id === "shell") {
      // The inspector: Space plays or pauses, the arrows step, Home starts over.
      const id = this.#inspecting;
      const control = ({ space: this.#shellPrefs.get(id)?.playing ? "pause" : "play", right: "step", home: "reset", end: "live" } as Record<string, string>)[key.name];
      if (control) return this.#shellControl(id, control);
      if (key.name === "left") return this.#shellControl(id, `seek:${Math.max(0, (this.#shellPrefs.get(id)?.cursor ?? 0) - 1)}`);
    }
    if (!this.#session.caps.features.includes("scroll") || !this.#sheet) return;
    const id = `layer.${this.#sheet.id}`;
    const by = ({ up: "line-up", down: "line-down", page_up: "page-up", page_down: "page-down", home: "start", end: "end", space: "page-down" } as const)[key.name as "up"];
    if (by) this.#surface.scroll(id, by);
  }

  /** `/status` and `/cost`: the session, the account, and what the session spent. */
  async #showSession(): Promise<void> {
    const conv = this.conv;
    // The sheet opens at once; the cost and time rows fill in when Claude Code has counted them.
    let session: Record<string, any> = {};
    let models: [string, any][] = [];
    let counted = false;
    void this.#cc
      .request("get_usage", {}, 60_000)
      .then(usage => {
        session = usage?.session ?? {};
        models = Object.entries<any>(session.model_usage ?? {});
      })
      .catch(() => undefined)
      .finally(() => ((counted = true), this.schedule()));
    const path = conv.sessionId ? sessionFile(this.#cwd, conv.sessionId) : "";
    this.#sheet = {
      id: "session",
      head: conv.sessionName || "Session",
      size: "md",
      body: () => [
        conv.contextWindow ? h("meter", { key: "context", style: "bar", size: "lg", value: Math.min(1, conv.contextTokens / conv.contextWindow), label: `${Math.round((conv.contextTokens / conv.contextWindow) * 100)}%`, total: tokens(conv.contextWindow), thresholds: { warn: 0.7, bad: 0.9 } }) : null,
        h("kv", {
          key: "facts",
          items: [
            this.#kv("Model", `${this.#modelName()}  (${conv.model})`),
            this.#kv("Effort", conv.effort || "default"),
            this.#kv("Mode", MODES[conv.permissionMode]?.label ?? conv.permissionMode),
            this.#kv("Output style", this.#outputStyle),
            this.#kv("Cost", money(session.total_cost_usd ?? conv.cost) || "$0.00"),
            ...(counted
              ? [this.#kv("Time", `${duration(session.total_api_duration_ms ?? 0) || "0s"} in the API · ${duration(session.total_duration_ms ?? 0) || "0s"} in all`), this.#kv("Code changes", `+${session.total_lines_added ?? 0} −${session.total_lines_removed ?? 0} lines`)]
              : [this.#kv("Time", "counting…")]),
            ...models.map(([name, model]) => this.#kv(modelLabel(name), `${tokens(model.inputTokens)} in · ${tokens(model.outputTokens)} out · ${tokens(model.cacheReadInputTokens)} cache read · ${tokens(model.cacheCreationInputTokens)} cache write${model.costUSD ? ` · ${money(model.costUSD)}` : ""}`)),
            this.#kv("Account", [this.#account.email, this.#accountLine()].filter(Boolean).join(" · ") || "not signed in"),
            this.#kv("Folder", showPath(this.#cwd, "")),
            this.#kv("Session id", conv.sessionId || "not started"),
            this.#kv("File", path && existsSync(path) ? showPath(path, "") : "not saved yet"),
            this.#kv("Claude Code", `${this.#claudeVersion || "unknown"}  ·  claude-tsp ${VERSION}`),
            ...(this.#mcp.length ? [this.#kv("MCP", this.#mcp.map(server => `${server.name} (${server.status})`).join(", "))] : []),
            this.#kv("Config", showPath(configDir(), "")),
          ],
        }),
      ],
      extra: () => [h("button", { key: "copy", text: "Copy session id", size: "md", onClick: () => this.copy(conv.sessionId, "Session id") })],
    };
    this.schedule();
  }

  /** `/usage`: the plan's windows, and what Claude Code says is spending them. */
  async #showUsage_(): Promise<void> {
    // The limits already known draw at once; what uses them is counted by Claude Code and added when it answers.
    let usage: Record<string, any> | null = null;
    let counted = false;
    const windows = new Map(this.conv.rateWindows);
    void this.#cc
      .request("get_usage", {}, 60_000)
      .then(result => {
        usage = result;
        for (const [name, window] of Object.entries<any>(result?.rate_limits ?? {})) {
          if (window && typeof window.utilization === "number") windows.set(name, { utilization: window.utilization > 1 ? window.utilization / 100 : window.utilization, resetsAt: Number(window.resets_at ?? window.resetsAt) || 0 });
        }
      })
      .catch(() => undefined)
      .finally(() => ((counted = true), this.schedule()));
    const label: Record<string, string> = { five_hour: "5-hour window", seven_day: "7-day window", seven_day_opus: "7-day window, Opus", seven_day_sonnet: "7-day window, Sonnet", seven_day_overage_included: "7-day window, with extra usage" };
    const behaviors = (span: string, title: string): (Node | null)[] => {
      const data = usage?.behaviors?.[span];
      const recs: any[] = Array.isArray(data?.recommendations) ? data.recommendations : [];
      if (!data) return [];
      return [
        h("text", { key: `${span}-head`, spans: [s(title, "strong"), s(`  ${data.request_count ?? 0} requests · ${data.session_count ?? 0} sessions`, "muted")] }),
        recs.length ? h("kv", { key: `${span}-recs`, items: recs.map(rec => ({ k: [s(`${rec.pct}%`, "mono")], v: [s(String(rec.title ?? "")), ...(rec.detail ? [s(`  ${rec.detail}`, "muted")] : [])] })) }) : null,
      ];
    };
    this.#sheet = {
      id: "usage",
      head: this.#accountLine() ? `Usage · ${this.#accountLine()}` : "Usage",
      size: "md",
      body: () => [
        ...[...windows].map(([name, window]) =>
          h("col", { key: `w-${name}`, gap: "none" }, [
            h("text", { key: "name", spans: [s(label[name] ?? name.replace(/_/g, " ")), s(window.resetsAt ? `  resets ${new Date(window.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "", "muted")] }),
            h("meter", { key: "meter", style: "bar", value: Math.min(1, window.utilization), label: `${Math.round(window.utilization * 100)}%`, thresholds: { warn: 0.7, bad: 0.9 } }),
          ]),
        ),
        windows.size ? null : h("text", { key: "none", wrap: "word", spans: [s("The plan's limits are reported with the first reply of a session.", "muted")] }),
        counted ? null : h("text", { key: "counting", spans: [s("Counting what used it…", "muted")] }),
        ...behaviors("day", "Last 24 hours"),
        ...behaviors("week", "Last 7 days"),
        h("text", { key: "note", wrap: "word", spans: [s("Shares are approximate, from sessions on this machine, and overlap.", "dim")] }),
      ],
    };
    this.schedule();
  }

  /** `/context`: what fills the window, by Claude Code's own categories. */
  async #showContext(): Promise<void> {
    const usage = await this.#load("get_context_usage");
    if (!usage) return;
    if (!usage?.maxTokens) {
      this.toast("Claude Code did not report the context", "warning");
      return;
    }
    // claude-pi's routed models have their own window; Claude Code reports the one of the Claude model they stand in for.
    const real = PROFILE.pi ? realWindow(this.conv.model) : undefined;
    const window: number = real ?? usage.maxTokens;
    const palette = ["accent", "success", "warning", "info", "user", "pending", "muted"];
    const used = (Array.isArray(usage.categories) ? usage.categories : []).filter((category: any) => category.kind === "used" && category.tokens > 0);
    const other = (Array.isArray(usage.categories) ? usage.categories : []).filter((category: any) => category.kind !== "used" && category.tokens > 0);
    const list = (title: string, rows: any[], name: (row: any) => string): (Node | null)[] =>
      rows.length ? [h("text", { key: `${title}-head`, spans: [s(title, "strong")] }), h("kv", { key: `${title}-rows`, items: rows.slice(0, 40).map(row => ({ k: [s(name(row), "mono")], v: [s(tokens(row.tokens), "mono")] })) })] : [];
    this.#sheet = {
      id: "context",
      head: "Context window",
      size: "md",
      body: () => [
        h("meter", { key: "meter", style: "bar", size: "lg", value: Math.min(1, usage.totalTokens / window), parts: used.map((category: any, index: number) => ({ value: category.tokens / window, token: palette[index % palette.length], label: String(category.name) })), label: `${Math.round((usage.totalTokens / window) * 100)}%`, total: tokens(window), thresholds: { warn: 0.7, bad: 0.9 } }),
        h("kv", {
          key: "rows",
          items: [
            ...used.map((category: any, index: number) => ({ k: [s(String(category.name), palette[index % palette.length])], v: [s(tokens(category.tokens), "mono"), s(`  ${((category.tokens / window) * 100).toFixed(1)}%`, "dim mono")] })),
            // With a routed model's own window, the free space is counted against that window.
            ...other.map((category: any) => ({ k: [s(String(category.name), "muted")], v: [s(tokens(real && /free/i.test(String(category.name)) ? Math.max(0, real - usage.totalTokens) : category.tokens), "mono")] })),
          ],
        }),
        ...list("Memory files", Array.isArray(usage.memoryFiles) ? usage.memoryFiles : [], row => showPath(String(row.path ?? row.name ?? ""), this.#cwd)),
        ...list("MCP tools", Array.isArray(usage.mcpTools) ? usage.mcpTools : [], row => String(row.name)),
        ...list("Agents", Array.isArray(usage.agents) ? usage.agents : [], row => String(row.agentType ?? row.name)),
        h("text", { key: "note", wrap: "word", spans: [s(`${tokens(usage.totalTokens)} of ${tokens(window)} tokens for ${real ? this.#modelName() : modelLabel(usage.model)}.${usage.isAutoCompactEnabled ? ` Claude Code auto-compacts at ${tokens(usage.autoCompactThreshold)}.` : " Auto-compact is off."}`, "muted")] }),
      ],
      extra: () => [h("button", { key: "compact", text: "Compact now", size: "md", onClick: () => (this.#closeSheet(), this.#sendCommand("/compact")) })],
    };
    this.schedule();
  }

  /** `/btw`: a question answered from the conversation so far, beside it; works while Claude is busy. */
  async #sideQuestion(args: string): Promise<void> {
    const question = args.trim();
    if (!question) {
      this.toast("Usage: /btw <question>", "warning");
      return;
    }
    this.toast("Asking on the side…");
    let answer: string;
    try {
      const result = await this.#cc.request("side_question", { question }, 300_000);
      answer = String(result?.response ?? "").trim() || "(no answer)";
    } catch (error) {
      this.toast(`Side question: ${firstLine((error as Error).message, 160)}`, "error");
      return;
    }
    this.#sheet = {
      id: "btw",
      head: firstLine(question, 80),
      size: "md",
      body: () => [h("text", { key: "note", spans: [s("Answered on the side: not part of the conversation.", "muted")] }), h("md", { key: "answer", text: answer })],
      extra: () => [h("button", { key: "copy", text: "Copy", size: "md", onClick: () => this.copy(answer, "Answer") })],
    };
    this.schedule();
  }

  #showTodos(): void {
    const phases = this.conv.todos;
    if (!phases?.length) {
      this.toast("No tasks in this session", "warning");
      return;
    }
    this.#sheet = {
      id: "todos",
      head: "Tasks",
      size: "md",
      body: () => [h("checklist", { key: "list", mode: "full", phases: (this.conv.todos ?? []).map(phase => ({ id: phase.id, title: phase.name, items: phase.items.map(item => ({ id: `${phase.id}.${item.id}`, text: item.text, status: item.status, ...(item.note ? { note: item.note } : {}) })) })) })],
    };
  }

  #showHotkeys(): void {
    const bound = (action: Action, what: string): [string, string][] => (this.#keymap.label(action) ? [[this.#keymap.label(action), what]] : []);
    const rows: [string, string][] = [
      ["Enter", "Send; while Claude works, send for its next step"],
      ["Shift+Enter  or  \\ Enter", "New line"],
      ...bound("app.message.followUp", "Queue for after the current turn"),
      ...bound("app.message.dequeue", "Bring queued messages back to edit"),
      ...bound("app.interrupt", "Stop Claude, or a running !command"),
      ["Esc Esc", "Rewind to an earlier message"],
      ...bound("app.clear", "Clear the draft, or stop; twice to exit"),
      ...bound("app.mode.cycle", "Step the permission mode"),
      ...bound("app.model.select", "Switch model"),
      ...bound("app.thinking.switch", "Turn thinking on or off"),
      ...bound("app.thinking.cycle", "Step the effort"),
      ...bound("app.background", "Send the running command or subagent to the background"),
      ...bound("app.tasks.toggle", "Show or hide the task list"),
      ["↑ / ↓", "Move in the draft, then prompt history"],
      ...bound("app.history.search", "Search prompt history"),
      ["Tab", "Take the suggested prompt; complete a file"],
      ["/", "Commands and skills"],
      ["@", "Files"],
      ["!cmd", "Run a shell command (!! keeps it from Claude)"],
      ...bound("app.stash", "Set the draft aside, or bring it back"),
      ...bound("app.tools.expand", "Expand or collapse every block"),
      ...bound("app.thinking.toggle", "Show or hide thinking"),
      ...bound("app.effort.increase", "More effort"),
      ...bound("app.effort.decrease", "Less effort"),
      ...bound("app.fast.toggle", "Fast mode on or off"),
      ...bound("app.agents.kill", "Stop every subagent and background task"),
      ...bound("app.clipboard.pasteImage", "Paste an image or text from the clipboard"),
      ...bound("app.editor.external", "Edit the draft in $EDITOR"),
      ...bound("app.message.copy", "Copy the last answer"),
      ...bound("app.retry", "Retry the last message"),
      ...bound("app.settings", "Settings"),
      ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo in the draft"],
      ["PgUp / PgDn", "Scroll the transcript"],
      ...bound("app.exit", "Exit (empty draft)"),
    ];
    const commands = this.#commands().filter(command => command.run && !["new", "quit", "settings", "hotkeys"].includes(command.name));
    this.#sheet = {
      id: "hotkeys",
      head: "Keys and commands",
      size: "md",
      body: () => [
        h("kv", { key: "keys", items: rows.map(([key, what]) => ({ k: [s(key, "key")], v: [s(what)] })) }),
        h("text", { key: "head", spans: [s("Commands", "strong"), s(`  ${this.#remote.length} more from Claude Code, skills and plugins: /skills`, "muted")] }),
        h("kv", { key: "commands", items: commands.map(command => ({ k: [s(`/${command.name}`, "mono accent")], v: [s(command.description)] })) }),
      ],
    };
  }

  /** A subagent's own conversation, drawn live as the transcript is. */
  #openAgent(item: Item): void {
    const sub = item.sub;
    // A stored run keeps its messages in a file of its own beside the session.
    if (sub && !sub.items.length && item.taskId && this.conv.sessionId) {
      const path = sidechainFile(this.#cwd, this.conv.sessionId, item.taskId);
      try {
        if (existsSync(path)) this.conv.loadSidechain(item, readEntries(path));
      } catch {
        /* the report below still shows */
      }
    }
    const view = new TranscriptView();
    const title = firstLine(item.args?.description ?? item.agentType ?? "Subagent", 80);
    this.#sheet = {
      id: "agent",
      head: title,
      size: "lg",
      body: () => {
        const nodes = sub ? view.build(sub, this.#viewCtx()) : [];
        const running = item.agentStatus === "running" || item.agentStatus === "pending";
        return [
          h("text", { key: "meta", spans: [s([item.agentType, item.model, item.agentStatus, item.stats?.tools ? `${item.stats.tools} tools` : "", item.stats?.tokens ? `${tokens(item.stats.tokens)} tok` : "", item.stats?.took != null ? duration(item.stats.took) : ""].filter(Boolean).join(" · "), "muted")] }),
          item.args?.prompt && !nodes.length ? h("card", { key: "prompt", role: "omp.user", tone: "user" }, [h("md", { key: "text", text: String(item.args.prompt).slice(0, 20_000) })]) : null,
          h("col", { key: "transcript", gap: "sm" }, nodes),
          !nodes.length && !running && item.output ? h("md", { key: "report", text: item.output.slice(0, 40_000) }) : null,
          !nodes.length && !item.output ? h("text", { key: "note", spans: [s(running ? "This subagent has not written anything yet." : "No transcript was kept for this run.", "muted")] }) : null,
        ];
      },
      extra: () => [
        (item.agentStatus === "running" || item.agentStatus === "pending") && item.taskId ? h("button", { key: "stop", text: "Stop", size: "md", variant: "danger", onClick: () => void this.#stopTask(item.taskId!, title) }) : null,
        h("button", { key: "copy", text: "Copy report", size: "md", onClick: () => this.copy(item.output ?? "", "Report") }),
      ],
    };
    this.schedule();
  }

  /** `/ide`: the IDEs that announce a Claude Code extension; choosing one starts the session again connected to it. */
  #pickIde(): void {
    const dir = join(configDir(), "ide");
    const found: { id: string; name: string; folders: string[]; port: string }[] = [];
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".lock")) continue;
        try {
          const lock = JSON.parse(readFileSync(join(dir, name), "utf8")) as { ideName?: string; workspaceFolders?: string[]; pid?: number };
          // A lock whose IDE is gone is stale.
          if (lock.pid) process.kill(lock.pid, 0);
          found.push({ id: name, name: String(lock.ideName ?? "IDE"), folders: Array.isArray(lock.workspaceFolders) ? lock.workspaceFolders.map(String) : [], port: name.replace(/\.lock$/, "") });
        } catch {
          /* unreadable, or its IDE has exited */
        }
      }
    } catch {
      /* no IDE has ever announced itself */
    }
    if (!found.length) {
      this.toast("No IDE with the Claude Code extension is running. Open your project in VS Code or a JetBrains IDE with the extension, then /ide again", "warning");
      return;
    }
    const connected = this.#launch.base.includes("--ide");
    this.#openPicker({
      props: { title: "Connect to an IDE", subtitle: connected ? "This session starts connected (--ide)" : "", icon: "plug", noun: "IDEs", size: "md", layout: "rows", preview: "none" },
      items: found.map(ide => ({ id: ide.id, label: ide.name, detail: [ide.folders.map(folder => showPath(folder, "")).join(", "), ide.folders.some(folder => this.#cwd === folder || this.#cwd.startsWith(`${folder}/`)) ? "this project" : ""].filter(Boolean).join(" · "), icon: "plug" })),
      searchable: false,
      actions: this.#chooseActions("Connect"),
      choose: async () => {
        this.#picker = null;
        if (!this.#launch.base.includes("--ide")) this.#launch.base.push("--ide");
        await this.#respawn();
        this.toast(this.#mcp.some(server => /ide/i.test(server.name)) ? "Connected to the IDE" : "Started with --ide: Claude Code connects when exactly one IDE has this project open");
      },
    });
  }

  /** `/keybindings`: the surface's own bindings file, started from the defaults, in `$EDITOR`; applied when it closes. */
  async #editKeys(): Promise<void> {
    const path = join(stateDir(), "keybindings.json");
    try {
      if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(DEFAULT_KEYS, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.toast(`Could not write ${showPath(path, "")}: ${(error as Error).message}`, "error");
      return;
    }
    const command = process.env.VISUAL || process.env.EDITOR;
    if (!command) {
      this.copy(path, "Path of the key bindings file");
      this.#showHotkeys();
      return;
    }
    const [bin, ...rest] = command.split(" ").filter(Boolean);
    try {
      await this.#external(bin!, [...rest, path]);
      this.#keymap = Keymap.load(stateDir());
      this.toast("Key bindings applied");
    } catch (error) {
      this.toast(`Could not run ${command}: ${(error as Error).message}`, "error");
    }
  }

  /** `/doctor`: Claude Code's own installation check, in a sheet. */
  #doctor(): void {
    let output = "Checking the installation…";
    this.#sheet = {
      id: "doctor",
      head: "Claude Code doctor",
      size: "md",
      // One text node per line, so long lines break between words rather than mid-word.
      body: () =>
        output
          .replace(/^\s*Claude Code doctor\s*\n/, "")
          .split("\n")
          .map((line, index) => (line.trim() ? h("text", { key: `l${index}`, wrap: "word", spans: [s(line, /^[A-Z][A-Za-z ]+$/.test(line.trim()) ? "strong" : "mono")] }) : h("spacer", { key: `l${index}`, size: "xs" }))),
      extra: () => [h("button", { key: "full", text: "Full checkup in Claude Code", size: "md", onClick: () => (this.#closeSheet(), void this.#tui("/doctor")) }), h("button", { key: "copy", text: "Copy", size: "md", onClick: () => this.copy(output, "Report") })],
    };
    execFile(stockPath(), ["doctor"], { cwd: this.#cwd, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      output = (stdout || stderr || error?.message || "No output").trim();
      this.schedule();
    });
  }

  // ───────────────────────────────────────────────────────────── commands Claude Code draws only in its terminal

  /** A picker as a question: the chosen id, or null when it was closed. */
  #pickOne(props: Record<string, unknown>, items: PickerItem[], selected?: string): Promise<string | null> {
    return new Promise(resolve => {
      let answered = false;
      const answer = (id: string | null): void => {
        if (answered) return;
        answered = true;
        resolve(id);
      };
      this.#openPicker({
        props: { noun: "options", size: "md", layout: "rows", preview: "none", ...props },
        items,
        ...(selected ? { selected } : {}),
        searchable: false,
        actions: this.#chooseActions("Select"),
        choose: id => {
          this.#picker = null;
          answer(id);
        },
        cancel: () => answer(null),
      });
    });
  }

  /** A text dialog as a question: what was typed, or null when it was closed. */
  #askText(options: { title: string; detail?: string; link?: string; placeholder: string; multiline?: boolean; text?: string }): Promise<string | null> {
    return new Promise(resolve => this.#openField({ ...options, multiline: options.multiline ?? false, text: options.text ?? "", done: resolve }));
  }

  /** A sheet that says something and offers a page to open. */
  #linkSheet(id: string, head: string, text: string, url: string, more: () => (Node | null)[] = () => []): void {
    this.#sheet = {
      id,
      head,
      size: "md",
      body: () => [h("text", { key: "text", wrap: "word", text }), h("text", { key: "link", wrap: "char", spans: [s(url, "accent mono", { href: url })] }), ...more()],
      extra: () => [h("button", { key: "copy", text: "Copy link", size: "md", onClick: () => this.copy(url, "Link") })],
    };
    this.schedule();
  }

  /** `/diff`: the uncommitted changes of the workspace, as Claude Code's own diff dialog counts them. */
  async #showDiff(): Promise<void> {
    const answer = await this.#load("get_workspace_diff", 30_000);
    if (!answer) return;
    const diff = answer.diff ?? {};
    const stats = diff.stats ?? {};
    const files: any[] = Array.isArray(diff.perFileStats) ? diff.perFileStats : [];
    const hunks = new Map<string, any[]>((Array.isArray(diff.hunks) ? diff.hunks : []).map((entry: any) => [String(entry.path), entry.hunks ?? []]));
    const base = diff.source?.kind === "working-tree" || !diff.source ? "against HEAD" : `against ${String(diff.source.baseRef ?? diff.source.base ?? diff.source.kind)}`;
    this.#sheet = {
      id: "diff",
      head: files.length ? `Changes  ·  ${stats.filesCount ?? files.length} ${files.length === 1 ? "file" : "files"}  +${stats.linesAdded ?? 0} −${stats.linesRemoved ?? 0}  ${base}` : "Changes",
      size: "lg",
      body: () =>
        files.length
          ? files.flatMap((file, index) => {
              const own = (hunks.get(String(file.path)) ?? []).map((hunk: any) => ({ oldStart: Number(hunk.oldStart) || 1, newStart: Number(hunk.newStart) || 1, lines: (hunk.lines ?? []).map(String) }));
              const note = file.isBinary ? "binary" : file.isUntracked ? "untracked" : String(file.status ?? "");
              return [
                h("row", { key: `f${index}`, role: "claude.diff.file", gap: "sm", align: "center" }, [
                  h("text", { key: "path", truncate: "middle", grow: 1, shrink: 1, spans: [s(String(file.path), "mono strong", { href: fileHref(String(file.path), this.#cwd) })] }),
                  note ? h("badge", { key: "note", text: note }) : null,
                  h("text", { key: "count", spans: [s(`+${file.added ?? 0}`, "success mono"), s(` −${file.removed ?? 0}`, "error mono")] }),
                ]),
                own.length ? h("diff", { key: `d${index}`, path: String(file.path), hunks: own }) : null,
              ];
            })
          : [h("text", { key: "none", spans: [s(answer.diff ? "No uncommitted changes." : "This folder is not a git repository.", "muted")] })],
    };
    this.schedule();
  }

  /** `/cd`: moves the session to another folder; Claude Code relocates the transcript with it. */
  async #changeDir(args: string): Promise<void> {
    if (this.conv.busy) {
      this.toast("Wait for Claude to finish, or stop it, before moving the session", "warning");
      return;
    }
    const typed = args.trim() || (await this.#askText({ title: "Move this session to another folder", detail: "The conversation continues there; files and commands are then relative to it.", placeholder: "~/project" }))?.trim();
    if (!typed) return;
    const path = typed.startsWith("~") ? join(homedir(), typed.slice(1)) : resolve(this.#cwd, typed);
    try {
      let answer = await this.#cc.request("set_cwd", { path }, 30_000);
      if (answer?.status === "needs_trust") {
        const directory = String(answer.directory ?? path);
        const trust = await this.#pickOne({ title: "Do you trust this folder?", subtitle: `${showPath(directory, "")}  ·  Claude Code will be able to read, edit and run files there`, icon: "shield" }, [
          { id: "no", label: "No, stay here" },
          { id: "yes", label: "Yes, I trust this folder" },
        ], "no");
        if (trust !== "yes") return;
        answer = await this.#cc.request("set_cwd", { path, trust_accepted: true, trusted_directory: directory }, 30_000);
      }
      if (answer?.status !== "ok") {
        this.toast(firstLine(String(answer?.message ?? `Could not move there (${String(answer?.reason ?? answer?.status ?? "refused")})`), 220), "error");
        return;
      }
      const cwd = String(answer.cwd ?? path);
      if (answer.changed === false) {
        this.toast("The session is already in that folder");
        return;
      }
      this.#cwd = cwd;
      this.#files = new FileIndex(cwd);
      // A later restart of the process (resume, rewind) must start in the new folder.
      try {
        process.chdir(cwd);
      } catch {
        /* the folder went away: Claude Code will say so on the next command */
      }
      // Tern draws the pane's folder itself: tell it where the program is now.
      process.stdout.write(`\x1b]7;file://${hostname()}${cwd.split("/").map(encodeURIComponent).join("/")}\x07`);
      this.conv.add({ kind: "notice", text: `Moved to ${showPath(cwd, "")}`, tone: "muted" }, "n");
      this.toast(`Now in ${showPath(cwd, "")}`, "success");
    } catch (error) {
      this.toast(`Could not move the session: ${firstLine((error as Error).message, 200)}`, "error");
    }
    this.schedule();
  }

  /** `/install-slack-app`: where the Claude app for Slack is installed. */
  #slackApp(): void {
    this.#linkSheet("slack", "Install the Claude Slack app", "Claude in Slack is installed from the Slack Marketplace, for a workspace you can add apps to. Open the page below.", "https://slack.com/marketplace/A08SF47R6P4-claude");
  }

  /** `/mobile`: where the Claude mobile app is downloaded. */
  #mobileApp(): void {
    this.#linkSheet("mobile", "Claude on your phone", "Get the Claude app from the page below (open it on your phone), sign in with the same account, and your Claude Code sessions are under Code.", "https://claude.ai/mobile?entrypoint=claude_code_cli");
  }

  /** `/stickers`: the page where Claude Code stickers are ordered. */
  #stickers(): void {
    this.#linkSheet("stickers", "Claude Code stickers", "Stickers are ordered on the page below.", "https://www.stickermule.com/claudecode");
  }

  /** `/radio`: Claude FM. */
  #radio(): void {
    this.#linkSheet("radio", "Claude FM", "Lo-fi radio to code to. It plays in your browser: open the page below.", "https://clau.de/radio");
  }

  /** Runs `claude` with this session's own arguments and returns what it printed. */
  #claudeCli(args: string[], timeout = 120_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise(done => {
      execFile(stockPath(), args, { cwd: this.#cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => done({ ok: !error, stdout: String(stdout), stderr: String(stderr || error?.message || "") }));
    });
  }

  /** `/background`: the session goes on as a background session of Claude Code; this pane starts a new one. */
  async #sendToBackground(): Promise<void> {
    const id = this.conv.sessionId;
    if (!id || !existsSync(sessionFile(this.#cwd, id))) {
      this.toast("There is no conversation to send to the background yet", "warning");
      return;
    }
    if (this.conv.busy) {
      this.toast("Wait for Claude to finish, or stop it, first", "warning");
      return;
    }
    const go = await this.#pickOne({ title: "Send this session to the background?", subtitle: "It keeps running under Claude Code's background service; this pane starts a new session", icon: "list" }, [
      { id: "go", label: "Send to the background" },
      { id: "cancel", label: "Cancel" },
    ]);
    if (go !== "go") return;
    this.toast("Sending the session to the background…");
    // The session's process must be gone before another one resumes it.
    const state = { model: this.#modelValue || undefined, permissionMode: this.conv.permissionMode } as SpawnState;
    this.#swapping = true;
    await this.#cc.stop();
    const result = await this.#claudeCli([...spawnArgs(this.#launch, { ...state, resume: id }), "--bg"], 60_000);
    const short = result.stdout.match(/claude attach (\S+)/)?.[1] ?? id.slice(0, 8);
    await this.#restart({ ...state, sessionId: randomUUID() }, null);
    if (result.ok) {
      this.conv.add({ kind: "notice", text: `The previous session runs in the background as ${short}. \`claude attach ${short}\` opens it in a terminal, \`claude stop ${short}\` stops it; /resume brings it back here once stopped.`, tone: "muted" }, "n");
      this.toast(`In the background as ${short}`, "success");
    } else this.toast(`Could not send it to the background: ${firstLine(result.stderr, 200)}`, "error");
    this.schedule();
  }

  /** `/subtask`: a copy of this conversation works on a task on its own; what it reports comes back here. */
  async #subtask(args: string): Promise<void> {
    const id = this.conv.sessionId;
    if (!id || !existsSync(sessionFile(this.#cwd, id))) {
      this.toast("A subtask starts from a conversation: send a message first", "warning");
      return;
    }
    const task = args.trim() || (await this.#askText({ title: "Send a subagent off with your full context", detail: "It starts as a copy of this conversation, works on the task on its own, and its result comes back here.", placeholder: "What should it do?", multiline: true }))?.trim();
    if (!task) return;
    const label = firstLine(task, 70);
    this.conv.add({ kind: "notice", text: `Subtask started: ${label}`, tone: "muted" }, "n");
    this.toast("Subtask started");
    this.#subtasks += 1;
    this.schedule();
    const result = await this.#claudeCli([...spawnArgs(this.#launch, { model: this.#modelValue || undefined, permissionMode: this.conv.permissionMode, resume: id, fork: true } as SpawnState), "-p", "--output-format", "json", task], 30 * 60_000);
    this.#subtasks -= 1;
    let text = "";
    let failed = !result.ok;
    try {
      const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
      text = String(parsed.result ?? "");
      failed ||= parsed.is_error === true;
    } catch {
      text = result.stdout.trim();
    }
    if (failed || !text) {
      this.conv.add({ kind: "notice", text: `Subtask failed: ${label}${text || result.stderr ? ` — ${firstLine(text || result.stderr, 300)}` : ""}`, tone: "warning" }, "n");
      this.toast("The subtask failed", "error");
    } else {
      // The result is given to Claude as the next message, as a subagent's report would be.
      this.toast("The subtask finished", "success");
      await this.#submit(`Result of the subtask "${label}":\n\n${text}`, "later");
    }
    this.schedule();
  }

  /** `/workflows`: the workflows of this session, running and finished. */
  #pickWorkflows(): void {
    const running = [...this.conv.background.values()].filter(task => /workflow/i.test(task.type));
    const finished = this.conv.items.filter(item => item.kind === "tool" && /^workflow$/i.test(String(item.name ?? "")));
    if (!running.length && !finished.length) {
      this.toast("No workflows have run in this session");
      return;
    }
    const items: PickerItem[] = [
      ...running.map(task => ({ id: `r:${task.id}`, label: firstLine(task.description, 100), detail: "running", dot: "pending", group: "Running" })),
      ...finished.map(item => ({ id: `f:${item.id}`, label: firstLine(String(item.args?.description ?? item.args?.name ?? item.args?.script ?? "workflow"), 100), detail: String(item.status ?? "done"), dot: item.status === "error" ? "error" : "success", group: "Finished" })),
    ];
    this.#openPicker({
      props: { title: "Workflows", subtitle: `${running.length} running · ${finished.length} finished`, icon: "list", noun: "workflows", size: "lg", layout: "rows", preview: "side" },
      items,
      grouped: true,
      searchable: true,
      actions: [
        { id: "open", label: "Details", keys: ["enter"], primary: true },
        { id: "stop", label: "Stop", keys: ["ctrl", "x"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => {
        const item = id?.startsWith("f:") ? finished.find(entry => entry.id === id.slice(2)) : undefined;
        const text = item ? JSON.stringify({ input: item.args, result: item.output ?? item.details }, null, 2).slice(0, 8000) : "";
        return text ? [h("code", { key: "json", lang: "json", wrap: true, text })] : [h("text", { key: "hint", spans: [s("Ctrl+X stops a running workflow; /tasks shows its output", "muted")] })];
      },
      choose: () => undefined,
      act: (act, id) => {
        if (act !== "stop" || !id?.startsWith("r:")) return;
        const task = running.find(entry => `r:${entry.id}` === id);
        this.#picker = null;
        void this.#stopTask(id.slice(2), firstLine(task?.description ?? "workflow", 60));
      },
    });
  }

  /** `/teleport`: the account's cloud sessions; one is opened in Claude Code's own window, which is where a cloud session is driven from. */
  async #teleport(args: string): Promise<void> {
    if (args.trim()) return this.#external(stockPath(), [...this.#launch.base, "--teleport", args.trim()]).then(() => this.schedule());
    const answer = await this.#load("list_cloud_sessions", 40_000);
    if (!answer) return;
    if (answer.status !== "ok") {
      this.toast(firstLine(String(answer.message ?? "Cloud sessions could not be read"), 220), "warning");
      return;
    }
    const sessions: any[] = Array.isArray(answer.sessions) ? answer.sessions : [];
    const choice = await this.#pickOne({ title: "Cloud sessions", subtitle: sessions.length ? "Choose one to resume here" : "None yet", icon: "history", size: "lg" }, [
      ...sessions.map(session => ({ id: `s:${String(session.id)}`, label: String(session.title || session.id), detail: [session.status ?? "idle", session.branch, session.updated_at ? new Date(session.updated_at).toLocaleString() : ""].filter(Boolean).join(" · ") })),
      { id: "send", label: "Send this session to the cloud…", detail: "Opens Claude Code's own window on this session to hand it over" },
    ]);
    if (!choice) return;
    if (choice === "send") await this.#tui("/teleport");
    else await this.#external(stockPath(), [...this.#launch.base, "--teleport", choice.slice(2)]);
    this.schedule();
  }

  /** `/rate-limit-options` (and `/pro-trial-expired`): what can be done about a usage limit. */
  async #limitOptions(): Promise<void> {
    const windows = [...this.conv.rateWindows.entries()].map(([name, window]) => `${name.replace(/_/g, " ")} ${Math.round(window.utilization * 100)}%`).join(" · ");
    const has = (name: string): boolean => this.#remote.some(command => command.name === name);
    const choice = await this.#pickOne({ title: "Usage limits", subtitle: windows || this.#accountLine() || "Your plan's limits", icon: "gauge" }, [
      { id: "usage", label: "See what is using the limits", detail: "/usage" },
      { id: "upgrade", label: "Upgrade your plan", detail: "/upgrade" },
      ...(has("extra-usage") ? [{ id: "extra", label: "Turn on extra usage", detail: "Keep working past the limit at API rates (/extra-usage)" }] : []),
      ...(has("usage-credits") ? [{ id: "credits", label: "Usage credits", detail: "/usage-credits" }] : []),
      { id: "model", label: "Switch to another model", detail: "/model" },
      { id: "wait", label: "Wait for the limit to reset" },
    ]);
    if (choice === "usage") await this.#showUsage_();
    else if (choice === "upgrade") this.#upgrade();
    else if (choice === "extra") this.#sendCommand("/extra-usage");
    else if (choice === "credits") this.#sendCommand("/usage-credits");
    else if (choice === "model") this.#pickModel();
  }

  /** `/setup-bedrock` and `/setup-vertex`: which cloud provider Claude Code calls, written to the user's settings. */
  async #setupProvider(kind: "bedrock" | "vertex"): Promise<void> {
    const path = settingsPath("userSettings", configDir(), this.#cwd);
    const now = readEnv(path);
    const name = kind === "bedrock" ? "Amazon Bedrock" : "Google Vertex AI";
    const flag = kind === "bedrock" ? "CLAUDE_CODE_USE_BEDROCK" : "CLAUDE_CODE_USE_VERTEX";
    const fields: { key: string; title: string; detail: string; placeholder: string; optional?: boolean }[] =
      kind === "bedrock"
        ? [
            { key: "AWS_REGION", title: "AWS region", detail: "The region your Bedrock models are enabled in.", placeholder: "us-east-1" },
            { key: "AWS_PROFILE", title: "AWS profile", detail: "A profile of your AWS credentials file. Leave empty to use the default credential chain (environment, SSO, instance role).", placeholder: "default", optional: true },
            { key: "ANTHROPIC_MODEL", title: "Model pin", detail: "A Bedrock model id or inference profile to use by default. Leave empty for Claude Code's default.", placeholder: "us.anthropic.claude-…", optional: true },
          ]
        : [
            { key: "ANTHROPIC_VERTEX_PROJECT_ID", title: "Google Cloud project", detail: "The project id Vertex AI is enabled in.", placeholder: "my-project" },
            { key: "CLOUD_ML_REGION", title: "Region", detail: "A Vertex region, or `global`.", placeholder: "global" },
            { key: "ANTHROPIC_MODEL", title: "Model pin", detail: "A Vertex model id to use by default. Leave empty for Claude Code's default.", placeholder: "claude-…", optional: true },
          ];
    const on = now[flag] === "1";
    const action = await this.#pickOne({ title: `${name}`, subtitle: on ? `In use · ${fields.map(field => now[field.key]).filter(Boolean).join(" · ")}` : "Not in use: Claude Code calls Anthropic directly", icon: "key" }, [
      { id: "set", label: on ? "Change the configuration" : `Use ${name}` },
      ...(on ? [{ id: "off", label: `Stop using ${name}`, detail: "Back to your Anthropic account" }] : []),
      { id: "cancel", label: "Cancel" },
    ]);
    if (action !== "set" && action !== "off") return;
    const env: Record<string, string | null> = {};
    if (action === "off") {
      env[flag] = null;
      for (const field of fields) if (field.key !== "ANTHROPIC_MODEL") env[field.key] = null;
    } else {
      for (const field of fields) {
        const value = await this.#askText({ title: `${name}: ${field.title}`, detail: field.detail, placeholder: field.placeholder, text: now[field.key] ?? "" });
        if (value === null) return;
        if (!value.trim() && !field.optional) {
          this.toast(`${field.title} is needed`, "warning");
          return;
        }
        env[field.key] = value.trim() || null;
      }
      env[flag] = "1";
      // One provider at a time.
      env[kind === "bedrock" ? "CLAUDE_CODE_USE_VERTEX" : "CLAUDE_CODE_USE_BEDROCK"] = null;
    }
    try {
      const changed = setEnv(path, env);
      if (!changed.length) {
        this.toast("Nothing changed");
        return;
      }
    } catch (error) {
      this.toast(`Could not write ${showPath(path, "")}: ${firstLine((error as Error).message, 160)}`, "error");
      return;
    }
    this.toast(action === "off" ? `${name} is off` : `${name} is set up`, "success");
    // The provider is read when Claude Code starts: the session starts again on it.
    const id = this.conv.sessionId;
    const stored = id && existsSync(sessionFile(this.#cwd, id));
    await this.#restart(stored ? { resume: id } : { sessionId: randomUUID() }, stored ? sessionFile(this.#cwd, id) : null);
  }

  /** `/upgrade`: the page where the plan is changed. */
  #upgrade(): void {
    const plan = this.#accountLine();
    this.#linkSheet("upgrade", "Upgrade your plan", `${plan ? `You are on ${plan}. ` : ""}Plans are changed on claude.ai; open the page below, then run /login here so the session uses the new plan.`, "https://claude.ai/upgrade/max?utm_source=claude_code&utm_medium=cli&utm_campaign=claude_tsp");
  }

  /** `/privacy-settings`: where the account's data settings are reviewed and changed. */
  #privacy(): void {
    this.#linkSheet("privacy", "Privacy settings", "Whether your chats and coding sessions may be used to train and improve Anthropic's models is a setting of your account. Review and change it on the page below.", "https://claude.ai/settings/data-privacy-controls");
  }

  /** `/release-notes`: Claude Code's changelog, the installed version's entry first in view. */
  #releaseNotes(): void {
    const page = "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";
    let text = "Fetching the release notes…";
    this.#sheet = {
      id: "release-notes",
      head: `Release notes${this.#claudeVersion ? `  ·  you have ${this.#claudeVersion}` : ""}`,
      size: "lg",
      body: () => [h("md", { key: "notes", text })],
      extra: () => [h("button", { key: "copy", text: "Copy link", size: "md", onClick: () => this.copy(page, "Link") })],
    };
    this.schedule();
    fetch("https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md", { signal: AbortSignal.timeout(20_000) })
      .then(async reply => {
        if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
        text = releaseNotes(await reply.text(), this.#claudeVersion);
      })
      .catch((error: Error) => {
        text = `The release notes could not be fetched (${firstLine(error.message, 120)}).\n\nThey are at <${page}>.`;
      })
      .finally(() => this.schedule());
  }

  /** `/stats`: what the stored sessions add up to. */
  #showStats(): void {
    let stats: Stats | null = null;
    let progress = "";
    const body = (): (Node | null)[] => {
      if (!stats) return [h("text", { key: "wait", spans: [s(`Counting your sessions…${progress ? `  ${progress}` : ""}`, "muted")] })];
      const models = [...stats.models.entries()].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
      const total = models.reduce((sum, [, model]) => sum + model.input + model.output, 0);
      const busiest = [...stats.days.entries()].sort((a, b) => b[1] - a[1])[0];
      const peak = stats.hours.indexOf(Math.max(...stats.hours));
      // The last four weeks, a bar per day.
      const recent: { label: string; value: number }[] = [];
      for (let back = 27; back >= 0; back -= 1) {
        const date = new Date();
        date.setDate(date.getDate() - back);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        recent.push({ label: key.slice(5), value: stats.days.get(key) ?? 0 });
      }
      const top = Math.max(1, ...recent.map(entry => entry.value));
      const bars = recent.map(entry => "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor((entry.value / top) * 7.999))] ?? "▁").join("");
      return [
        h("kv", {
          key: "facts",
          items: [
            this.#kv("Sessions", String(stats.sessions)),
            this.#kv("Prompts", `${stats.prompts}  ·  ${stats.replies} replies  ·  ${stats.toolCalls} tool calls`),
            this.#kv("Active days", `${stats.days.size}${stats.firstDay ? `  ·  since ${stats.firstDay}` : ""}`),
            this.#kv("Streak", `${stats.currentStreak} ${stats.currentStreak === 1 ? "day" : "days"} now  ·  ${stats.longestStreak} longest`),
            ...(busiest ? [this.#kv("Busiest day", `${busiest[0]}  ·  ${busiest[1]} messages`)] : []),
            ...(stats.replies ? [this.#kv("Peak hour", `${String(peak).padStart(2, "0")}:00`)] : []),
            ...(stats.longest.messages ? [this.#kv("Longest session", `${stats.longest.messages} messages${stats.longest.minutes ? `  ·  ${duration(stats.longest.minutes * 60_000)}` : ""}`)] : []),
            this.#kv("Tokens", `${tokens(total)} in and out`),
            this.#kv("Last 4 weeks", bars),
          ],
        }),
        models.length ? h("text", { key: "models-head", spans: [s("Models", "strong")] }) : null,
        ...models.slice(0, 8).map(([name, model], index) =>
          h("meter", { key: `model-${index}`, style: "bar", size: "md", value: total ? (model.input + model.output) / total : 0, label: modelLabel(name), total: `${tokens(model.input)} in · ${tokens(model.output)} out · ${tokens(model.cacheRead)} cached` }),
        ),
        stats.skipped ? h("text", { key: "skipped", spans: [s(`${stats.skipped} older session files were left out to keep this quick.`, "muted")] }) : null,
      ];
    };
    this.#sheet = { id: "stats", head: "Your Claude Code statistics", size: "md", body };
    this.schedule();
    void collectStats(configDir(), 20_000, (done, total) => {
      progress = `${done} of ${total}`;
      this.schedule();
    })
      .then(result => {
        stats = result;
      })
      .catch(() => {
        stats = emptyStats();
      })
      .finally(() => this.schedule());
  }

  /** `/sandbox`: how commands are confined, set through Claude Code's own settings editor. */
  async #sandbox(): Promise<void> {
    const state = await this.#load("get_sandbox_dialog");
    if (!state) return;
    if (!state.supported) {
      this.toast(state.unsupported_reason === "wsl1" ? "Sandboxing needs WSL2" : "Sandboxing is not available on this platform", "warning");
      return;
    }
    const missing: string[] = state.dependencies?.errors ?? [];
    const blocked = state.locked ? "Set by a higher-priority configuration" : missing.length ? `Needs ${missing.join("; ")}` : "";
    const mode = String(state.mode ?? "disabled");
    const excluded: string[] = state.excluded_commands ?? [];
    const restrictions = Object.entries<any>(state.restrictions ?? {}).filter(([, value]) => (Array.isArray(value) ? value.length : value === true));
    const mark = (id: string): Partial<PickerItem> => (mode === id ? { badges: [{ text: "current", tone: "accent" }] } : {});
    const items: PickerItem[] = [
      { id: "mode:auto-allow", label: "Sandbox commands, and run sandboxed ones without asking", group: "Mode", ...mark("auto-allow"), ...(blocked || !state.auto_allow_available ? { disabled: blocked || "Not available on this platform" } : {}) },
      { id: "mode:regular", label: "Sandbox commands, with the regular permission prompts", group: "Mode", ...mark("regular"), ...(blocked ? { disabled: blocked } : {}) },
      { id: "mode:disabled", label: "No sandbox", group: "Mode", ...mark("disabled"), ...(state.locked || state.no_sandbox_allowed === false ? { disabled: "Sandboxing is required here" } : {}) },
      {
        id: "fallback",
        label: state.unsandboxed_fallback ? "Unsandboxed fallback: allowed" : "Unsandboxed fallback: not allowed",
        detail: "Whether a command that cannot run in the sandbox may ask to run outside it",
        group: "Overrides",
        ...(state.overrides_locked ? { disabled: "Set by a higher-priority configuration" } : {}),
      },
      { id: "exclude", label: "Exclude a command from the sandbox…", detail: excluded.length ? `Excluded now: ${excluded.join(", ")}` : "None excluded", group: "Overrides", ...(state.locked ? { disabled: "Set by a higher-priority configuration" } : {}) },
      ...restrictions.map(([name, value], index) => ({ id: `r${index}`, label: name.replace(/_/g, " "), detail: Array.isArray(value) ? value.join(", ") : "yes", group: "Restrictions (from settings)", disabled: true as const })),
    ];
    this.#openPicker({
      props: { title: "Sandbox", subtitle: missing.length ? `The sandbox cannot run yet: ${missing.join("; ")}` : state.enabled ? "Commands run in the sandbox" : "Commands run without a sandbox", icon: "shield", noun: "settings", size: "md", layout: "rows", preview: "none" },
      items,
      selected: `mode:${mode}`,
      grouped: true,
      searchable: false,
      actions: this.#chooseActions("Set"),
      // Not awaited: a key handler that waits for a dialog's answer would hold up the keys that give it.
      choose: id => void (async () => {
        let edit: Record<string, unknown> | null = null;
        if (id.startsWith("mode:")) edit = { mode: id.slice(5) };
        else if (id === "fallback") edit = { allowUnsandboxedCommands: !state.unsandboxed_fallback };
        else if (id === "exclude") {
          this.#picker = null;
          const pattern = await this.#askText({ title: "Exclude a command from the sandbox", detail: "A command pattern, as in a permission rule: for example `docker:*` or `npm run build`. It is added to this project's local settings.", placeholder: "docker:*" });
          if (pattern?.trim()) edit = { excludeCommand: pattern.trim() };
        }
        if (!edit) return;
        this.#picker = null;
        const result = await this.#editSettings("edit-sandbox-settings", edit);
        if (result.ok) this.toast(id === "exclude" ? "Command excluded from the sandbox" : id === "fallback" ? `Unsandboxed fallback ${edit.allowUnsandboxedCommands ? "allowed" : "not allowed"}` : `Sandbox: ${String(edit.mode).replace("disabled", "off").replace("auto-allow", "on, sandboxed commands run without asking").replace("regular", "on, regular permissions")}`, "success");
        else this.toast(firstLine(result.error, 220), "error");
        if (result.ok && id !== "exclude") {
          // The edit lands in the project's local settings; a session started without them (--setting-sources) does not read it.
          const now = await this.#cc.request("get_sandbox_dialog", {}, 20_000).catch(() => null);
          const landed = now && (id === "fallback" ? now.unsandboxed_fallback === edit.allowUnsandboxedCommands : now.mode === edit.mode);
          if (now && !landed) this.toast("Saved to this project's local settings, which this session was started without: it applies to sessions that read project settings", "warning");
        }
        await this.#sandbox();
      })(),
    });
  }

  /** Applies one edit with a `claude edit-…-settings --json` command, the way Claude Code's editor extension writes settings. */
  #editSettings(command: string, edit: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    return new Promise(resolve => {
      const child = execFile(stockPath(), [command, "--json"], { cwd: this.#cwd, timeout: 30_000 }, (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true });
        resolve({ ok: false, error: (stderr || stdout || error.message).trim() || "The setting could not be changed" });
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(JSON.stringify(edit));
    });
  }

  /** `/remote-control`: makes this session reachable from claude.ai and the mobile app, or stops that. */
  async #remoteControl(args: string): Promise<void> {
    const show = (): void => {
      const remote = this.#remoteLink;
      if (!remote) return;
      this.#linkSheet("remote", "Remote control is on", "This session can be continued from claude.ai or the Claude mobile app while this window stays open. Open the page below on the other device.", remote.url, () => []);
      const sheet = this.#sheet!;
      const base = sheet.extra!;
      sheet.extra = () => [h("button", { key: "off", text: "Disconnect", size: "md", onClick: () => void this.#remoteOff() }), ...base()];
    };
    if (/^(off|stop|disconnect)$/i.test(args.trim())) return this.#remoteOff();
    if (this.#remoteLink) return show();
    this.toast("Connecting remote control…");
    try {
      const answer = await this.#cc.request("remote_control", { enabled: true, ...(args.trim() ? { name: args.trim() } : this.conv.sessionName ? { name: this.conv.sessionName } : {}) }, 60_000);
      const url = String(answer?.session_url ?? answer?.connect_url ?? "");
      if (!url) throw new Error("Claude Code did not return a link for the session");
      this.#remoteLink = { url };
      show();
    } catch (error) {
      // Claude Code turns this on per account and build; where it refuses a host, its own window may still offer it.
      const reason = firstLine((error as Error).message, 200);
      void this.#pickOne({ title: "Remote control could not be turned on", subtitle: `Claude Code said: ${reason}`, icon: "warning" }, [
        { id: "close", label: "Close" },
        { id: "tui", label: "Try in Claude Code's own window", detail: "Opens /remote-control there on this session; you come back here when you leave it" },
      ]).then(choice => (choice === "tui" ? this.#tui(`/remote-control${args.trim() ? ` ${args.trim()}` : ""}`) : undefined));
    }
    this.schedule();
  }

  async #remoteOff(): Promise<void> {
    if (this.#sheet?.id === "remote") this.#sheet = null;
    if (!this.#remoteLink) {
      this.toast("Remote control is not on");
      return;
    }
    this.#remoteLink = null;
    await this.#cc.request("remote_control", { enabled: false }, 30_000).catch(() => null);
    this.toast("Remote control disconnected");
    this.schedule();
  }

  /** `/feedback`: a report to Anthropic through Claude Code, or saved on this machine. */
  async #feedback(args: string): Promise<void> {
    const description = await this.#askText({ title: "Send feedback about Claude Code", detail: "Describe what happened or what you would like. Nothing is sent until you choose where it goes.", placeholder: "What went wrong, or what would be better?", multiline: true, text: args.trim() });
    if (!description?.trim()) return;
    const where = await this.#pickOne({ title: "Where should this report go?", subtitle: firstLine(description, 100), icon: "info" }, [
      { id: "send", label: "Send to Anthropic", detail: "With this session's transcript and a sanitized error log, as /feedback does in Claude Code" },
      { id: "save", label: "Save on this machine only", detail: "A redacted zip is written here; nothing is sent" },
      { id: "cancel", label: "Cancel" },
    ]);
    if (where !== "send" && where !== "save") return;
    this.toast(where === "send" ? "Sending the report…" : "Saving the report…");
    try {
      const answer = await this.#cc.request("submit_feedback", { description: description.trim(), surface: "sdk", ...(where === "save" ? { save_locally: true } : {}) }, 120_000);
      const reason = [answer?.unavailable_reason, answer?.failure_reason].filter(Boolean).join(" · ");
      if (answer?.bundle_path) {
        this.toast(`Report saved to ${showPath(String(answer.bundle_path), "")}`, "success");
        this.conv.add({ kind: "notice", text: `Feedback report saved to ${String(answer.bundle_path)}`, tone: "muted" }, "n");
      } else if (answer?.feedback_id) {
        this.toast("Thank you: the report was sent", "success");
        this.conv.add({ kind: "notice", text: `Feedback sent (id ${String(answer.feedback_id)})`, tone: "muted" }, "n");
      } else {
        this.toast(`The report was not sent: ${firstLine(reason || "Claude Code gave no reason", 240)}`, "warning");
        this.conv.add({ kind: "notice", text: `Feedback was not sent: ${firstLine(reason || "Claude Code gave no reason", 400)}`, tone: "warning" }, "n");
      }
    } catch (error) {
      this.toast(`The report was not sent: ${firstLine((error as Error).message, 200)}`, "error");
    }
    this.schedule();
  }

  /** `/install-github-app`: Claude GitHub Actions for a repository, set up with the GitHub CLI. */
  async #installGithubApp(): Promise<void> {
    this.toast("Checking the GitHub CLI…");
    const ready = await preflight(this.#cwd);
    if (ready.problem) {
      this.#linkSheet("github", "Set up Claude GitHub Actions", ready.problem, MANUAL_URL);
      return;
    }
    // 1. Which repository.
    let repo = ready.repo ?? "";
    if (repo) {
      const which = await this.#pickOne({ title: "Set up Claude GitHub Actions", subtitle: "Which repository?", icon: "plug" }, [
        { id: "here", label: `Use this folder's repository`, detail: repo, mono: false },
        { id: "other", label: "Enter a different repository…" },
      ]);
      if (!which) return;
      if (which === "other") repo = "";
    }
    while (!repo) {
      const typed = await this.#askText({ title: "Which repository?", detail: "As owner/repo, or a github.com link.", placeholder: "owner/repo" });
      if (typed === null) return;
      repo = parseRepo(typed) ?? "";
      if (!repo) this.toast("Enter a repository as owner/repo or a github.com link", "warning");
    }
    this.toast(`Looking at ${repo}…`);
    const found = await inspect(repo, this.#cwd);
    if (found.problem) {
      this.#linkSheet("github", "Set up Claude GitHub Actions", found.problem, MANUAL_URL);
      return;
    }
    const warnings = [...ready.warnings, ...found.warnings];
    if (warnings.length) {
      const go = await this.#pickOne({ title: "There may be a problem", subtitle: warnings.join("  ·  "), icon: "warning" }, [
        { id: "go", label: "Continue anyway" },
        { id: "stop", label: "Stop and fix it first" },
      ]);
      if (go !== "go") return;
    }
    // 2. The GitHub App.
    const installed = await this.#pickOne({ title: "Install the Claude GitHub App", subtitle: `Open ${APP_URL} and grant it access to ${repo}`, icon: "plug" }, [
      { id: "open", label: "Copy the link", detail: APP_URL },
      { id: "done", label: "It is installed: continue" },
    ]);
    if (!installed) return;
    if (installed === "open") {
      this.copy(APP_URL, "Link");
      const after = await this.#pickOne({ title: "Install the Claude GitHub App", subtitle: `Install it for ${repo} at ${APP_URL} (the link is on your clipboard), then continue`, icon: "plug" }, [{ id: "done", label: "It is installed: continue" }]);
      if (!after) return;
    }
    // 3. Which workflows.
    let workflows: WorkflowKind[] = [];
    let keep = false;
    if (found.hasWorkflow) {
      const action = await this.#pickOne({ title: "A Claude workflow already exists", subtitle: `${repo} has .github/workflows/claude.yml`, icon: "plug" }, [
        { id: "update", label: "Update the workflow files to the latest version" },
        { id: "skip", label: "Skip the workflow files and set up the secret only" },
        { id: "exit", label: "Stop without changing anything" },
      ]);
      if (!action || action === "exit") return;
      keep = action === "skip";
    }
    if (!keep) {
      const chosen = await this.#pickOne({ title: "Which workflows?", subtitle: "Added on a new branch, for a pull request you open", icon: "plug" }, [
        { id: "both", label: "@Claude Code and Claude Code Review", detail: "Answer @claude in issues and pull requests, and review every new pull request" },
        { id: "claude", label: "@Claude Code only", detail: "Answer @claude in issue and pull request comments" },
        { id: "claude-review", label: "Claude Code Review only", detail: "Review every new pull request" },
      ]);
      if (!chosen) return;
      workflows = chosen === "both" ? ["claude", "claude-review"] : [chosen as WorkflowKind];
    }
    // 4. The credential the workflows run with.
    let secret = API_KEY_SECRET;
    let value: string | undefined;
    const have = [API_KEY_SECRET, OAUTH_SECRET].filter(name => found.secrets.includes(name));
    const how = await this.#pickOne({ title: "How should the workflows sign in?", subtitle: have.length ? `${repo} already has ${have.join(" and ")}` : `Saved as an Actions secret of ${repo}`, icon: "key" }, [
      ...have.map(name => ({ id: `use:${name}`, label: `Use the existing ${name} secret` })),
      { id: "token", label: "Create a subscription token", detail: "Signs in with your Claude account for a long-lived token (claude setup-token)" },
      { id: "paste", label: "Paste an API key or a token", detail: "An Anthropic API key (sk-ant-api…) or a token from `claude setup-token` (sk-ant-oat…)" },
    ]);
    if (!how) return;
    if (how.startsWith("use:")) secret = how.slice(4);
    else {
      const pasted = how === "token" ? await this.#setupToken() : await this.#askText({ title: "Paste the API key or token", detail: `It is saved as an Actions secret of ${repo} and nowhere else.`, placeholder: "sk-ant-…" });
      if (!pasted?.trim()) return;
      value = pasted.trim();
      secret = secretFor(value);
      if (found.secrets.includes(secret)) {
        const replace = await this.#pickOne({ title: `${secret} already exists in ${repo}`, icon: "key" }, [
          { id: "replace", label: "Replace it with the new value" },
          { id: "keep", label: "Keep the existing secret" },
        ]);
        if (!replace) return;
        if (replace === "keep") value = undefined;
      }
    }
    // 5. Say exactly what will change, then do it.
    const plan = [...(workflows.length ? [`create a branch in ${repo}`, ...workflows.map(kind => `add ${workflowFile(kind).path}`)] : []), ...(value !== undefined ? [`save the ${secret} secret`] : [`use the existing ${secret} secret`])];
    const go = await this.#pickOne({ title: `Set up ${repo}?`, subtitle: `This will ${plan.join(", ")}.`, icon: "plug" }, [
      { id: "go", label: "Set it up" },
      { id: "cancel", label: "Cancel" },
    ]);
    if (go !== "go") return;
    let step = "Starting…";
    let outcome: { url: string | null; done: string[] } | null = null;
    let failure = "";
    let completed: string[] = [];
    this.#sheet = {
      id: "github",
      head: `Claude GitHub Actions for ${repo}`,
      size: "md",
      body: () =>
        outcome
          ? [
              h("text", { key: "ok", wrap: "word", spans: [s("Done: ", "success strong"), s(`${outcome.done.join(", ") || "nothing needed changing"}.`)] }),
              outcome.url ? h("text", { key: "next", wrap: "word", text: "Open the page below to create the pull request. The workflows start working once it is merged." }) : null,
              outcome.url ? h("text", { key: "link", wrap: "char", spans: [s(outcome.url.split("?")[0] ?? outcome.url, "accent mono", { href: outcome.url })] }) : null,
            ]
          : failure
            ? [
                h("text", { key: "bad", wrap: "word", spans: [s("Setup failed. ", "error strong"), s(failure)] }),
                completed.length ? h("text", { key: "done", wrap: "word", spans: [s(`Already done: ${completed.join(", ")}.`, "muted")] }) : null,
                h("text", { key: "manual", wrap: "char", spans: [s("Manual setup: ", "muted"), s(MANUAL_URL, "accent mono", { href: MANUAL_URL })] }),
              ]
            : [h("text", { key: "step", spans: [s(`${step}…`, "muted")] })],
      extra: () => (outcome?.url ? [h("button", { key: "copy", text: "Copy pull request link", size: "md", onClick: () => this.copy(outcome!.url!, "Link") })] : []),
    };
    this.schedule();
    try {
      outcome = await setup({ repo, workflows, secret, ...(value !== undefined ? { value } : {}), cwd: this.#cwd, step: text => ((step = text), this.schedule()) });
      if (outcome.url) process.stdout.write(`\x1b]52;c;${Buffer.from(outcome.url, "utf8").toString("base64")}\x07`);
    } catch (error) {
      failure = (error as Error).message;
      completed = (error as { done?: string[] }).done ?? [];
    }
    this.schedule();
  }

  /**
   * A long-lived subscription token from `claude setup-token`. That command
   * draws a terminal UI, so it runs in a pseudo-terminal of its own: the
   * sign-in link is read from what it draws, the code is typed into it, and
   * the token is read from its last screen.
   */
  #setupToken(): Promise<string | null> {
    return new Promise(resolve => {
      let child: ChildProcess;
      try {
        child = spawn("script", ["-qfec", `stty cols 500 rows 50 2>/dev/null; exec "${stockPath()}" setup-token`, "/dev/null"], { cwd: this.#cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, BROWSER: "true" } });
      } catch {
        resolve(null);
        return;
      }
      let output = "";
      let asked = false;
      let settled = false;
      const finish = (token: string | null): void => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        if (this.#field?.title === "Create a subscription token") this.#field = null;
        if (!token) this.toast("No token was created: paste one from `claude setup-token` instead", "warning");
        this.schedule();
        resolve(token);
      };
      child.stdin?.on("error", () => undefined);
      child.on("error", () => finish(null));
      child.on("exit", () => finish(tokenIn(output)));
      let submitted = 0;
      const take = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
        // For diagnosing a sign-in that goes wrong: what the command drew, with any token masked.
        if (process.env.CLAUDE_TSP_TOKEN_LOG) appendFileSync(process.env.CLAUDE_TSP_TOKEN_LOG, plainText(chunk.toString("utf8")).replace(/sk-ant-[\w-]+/g, "sk-ant-…"));
        const token = tokenIn(output);
        if (token) return finish(token);
        // Claude Code refused the code: say why, in its words.
        const refused = submitted ? plainText(output.slice(submitted)).match(/OAuth error:\s*([^\n]{0,300})/)?.[1] : undefined;
        if (refused) {
          this.toast(`Sign-in failed: ${firstLine(refused.replace(/\s*Press Enter to retry\.?/, ""), 240)}`, "error");
          return finish(null);
        }
        const url = output.match(/https:\/\/[^\s\x07\x1b\\]+oauth\/authorize[^\s\x07\x1b\\]*/)?.[0];
        if (!url || asked) return;
        asked = true;
        process.stdout.write(`\x1b]52;c;${Buffer.from(url, "utf8").toString("base64")}\x07`);
        this.#openField({
          title: "Create a subscription token",
          detail: "Open the page below (it is also on your clipboard), sign in, and paste the code it gives you here.",
          link: url,
          placeholder: "Paste the code",
          multiline: false,
          text: "",
          done: value => {
            if (settled) return;
            if (value === null || !value.trim()) return finish(null);
            submitted = output.length;
            // The code and Enter go separately: together they read as one paste, and a paste's line end is dropped.
            child.stdin?.write(value.trim());
            setTimeout(() => child.stdin?.write("\r"), 400);
            this.toast("Checking the code…");
            setTimeout(() => finish(tokenIn(output)), 90_000);
          },
        });
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      setTimeout(() => !asked && finish(null), 30_000);
    });
  }

  /** `/hooks`: the hooks in force, or the events a hook can be set on. */
  async #pickHooks(): Promise<void> {
    const listing = await this.#load("get_hooks_listing");
    if (!listing) return;
    const hooks: any[] = Array.isArray(listing.hooks) ? listing.hooks : [];
    const catalog: any[] = Array.isArray(listing.eventCatalog) ? listing.eventCatalog : [];
    const describe = (hook: any): string => String(hook.command ?? hook.prompt ?? hook.url ?? hook.name ?? hook.hook?.command ?? JSON.stringify(hook.hook ?? hook));
    const items: PickerItem[] = [
      ...hooks.map((hook, index) => ({
        id: `h${index}`,
        label: firstLine(describe(hook), 110),
        mono: true,
        detail: [hook.event ?? hook.hookEvent ?? hook.hook_event, hook.matcher ? `matcher ${hook.matcher}` : "", hook.source ?? hook.scope ?? ""].filter(Boolean).join(" · "),
        group: "hooks",
        search: JSON.stringify(hook).slice(0, 2000),
      })),
      ...catalog.map((event, index) => ({ id: `e${index}`, label: String(event.name), detail: String(event.summary ?? ""), group: "events", ...(hooks.some(hook => (hook.event ?? hook.hookEvent ?? hook.hook_event) === event.name) ? { badges: [{ text: "set", tone: "accent" }] } : {}) })),
    ];
    this.#openPicker({
      props: { title: "Hooks", subtitle: hooks.length ? `${hooks.length} configured` : "None configured", icon: "plug", noun: "hooks", size: "lg", layout: "rows", preview: "below", placeholder: "Search hooks…" },
      items,
      searchable: true,
      tabs: [
        { id: "hooks", label: "Configured", test: item => item.group === "hooks" },
        { id: "events", label: "Events", test: item => item.group === "events" },
      ],
      tab: hooks.length ? "hooks" : "events",
      actions: [
        { id: "copy", label: "Copy", keys: ["enter"], primary: true },
        { id: "edit", label: "Edit settings", keys: ["ctrl", "e"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No hooks are configured",
      preview: id => {
        const hook = id?.startsWith("h") ? hooks[Number(id.slice(1))] : undefined;
        return hook ? [h("code", { key: "json", lang: "json", wrap: true, text: JSON.stringify(hook, null, 2).slice(0, 8000) })] : [];
      },
      choose: id => this.copy(items.find(item => item.id === id)?.label ?? "", "Hook"),
      act: act => {
        if (act !== "edit") return;
        this.#picker = null;
        // Hooks live in the settings files: the one chosen opens in the editor, at its "hooks" block.
        void this.#pickOne({ title: "Edit hooks in which settings?", subtitle: 'Hooks are the "hooks" block of a settings file', icon: "plug" }, (Object.keys(SCOPES) as Scope[]).map(scope => ({ id: scope, label: SCOPES[scope], detail: showPath(settingsPath(scope, configDir(), this.#cwd), "") }))).then(async scope => {
          if (!scope) return;
          const path = settingsPath(scope as Scope, configDir(), this.#cwd);
          if (!existsSync(path)) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
          }
          if (await this.#editFile(path)) this.toast("Claude Code reads the hooks again when the file changes");
        });
      },
    });
  }

  /** `/memory`: the CLAUDE.md files Claude reads here; Enter opens one in `$EDITOR`. */
  async #pickMemory(): Promise<void> {
    const usage = await this.#load("get_context_usage");
    if (!usage) return;
    const loaded = new Map<string, number>((Array.isArray(usage.memoryFiles) ? usage.memoryFiles : []).map((file: any) => [String(file.path), Number(file.tokens) || 0]));
    const places: [string, string][] = [
      [join(this.#cwd, "CLAUDE.md"), "project memory, shared with the repository"],
      [join(this.#cwd, "CLAUDE.local.md"), "project memory, just you"],
      [join(configDir(), "CLAUDE.md"), "your memory, for every project"],
    ];
    for (const path of loaded.keys()) if (!places.some(([known]) => known === path)) places.push([path, "loaded"]);
    const items: PickerItem[] = places.map(([path, what]) => ({
      id: path,
      label: showPath(path, this.#cwd),
      mono: true,
      detail: [what, existsSync(path) ? "" : "not created yet"].filter(Boolean).join(" · "),
      icon: "file",
      facts: { tokens: loaded.has(path) ? tokens(loaded.get(path)!) : "" },
      ...(loaded.has(path) ? { badges: [{ text: "loaded", tone: "success" }] } : {}),
    }));
    this.#openPicker({
      props: { title: "Memory", subtitle: "Files Claude reads at the start of every conversation here", icon: "file", noun: "files", size: "lg", layout: "rows", preview: "below", columns: [{ id: "tokens", head: "Tokens", format: "num" }] },
      items,
      searchable: false,
      actions: [
        { id: "open", label: "Open in editor", keys: ["enter"], primary: true },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      preview: id => {
        if (!id || !existsSync(id)) return [h("text", { key: "none", spans: [s("Not created yet: opening it starts the file.", "muted")] })];
        try {
          return [h("md", { key: "text", text: readFileSync(id, "utf8").slice(0, 6000) })];
        } catch {
          return [];
        }
      },
      choose: async id => {
        this.#picker = null;
        if (await this.#editFile(id)) this.toast("Memory is read again from the next conversation (/clear)");
      },
    });
  }

  /** `/plugin`: what this session loaded and what is installed; details, and on or off. */
  #pickPlugins(): void {
    const bin = stockPath();
    const details = new Map<string, string>();
    let installed: any[] = [];
    let available: any[] = [];
    // Claude Code names the plugins it loaded with the first turn; before that, the ones given on the command line are read from disk.
    const given = (): { name: string; path?: string; version?: string }[] => {
      const out: { name: string; path?: string; version?: string }[] = [];
      const base = this.#launch.base;
      for (let index = 0; index < base.length - 1; index += 1) {
        if (base[index] !== "--plugin-dir") continue;
        const path = base[index + 1]!;
        try {
          const manifest = JSON.parse(readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8")) as { name?: string; version?: string };
          out.push({ name: String(manifest.name ?? path.split("/").at(-1)), path, ...(manifest.version ? { version: String(manifest.version) } : {}) });
        } catch {
          /* a folder of plugins, or not a plugin: Claude Code will say after the first turn */
        }
      }
      return out;
    };
    const items = (): PickerItem[] => {
      const loaded = this.#plugins.length ? this.#plugins : given();
      const session = loaded.map(plugin => ({
        id: `s:${plugin.name}`,
        label: plugin.name,
        detail: [plugin.version, plugin.path === "builtin" ? "built in" : plugin.path ? showPath(plugin.path, this.#cwd) : "", "loaded in this session"].filter(Boolean).join(" · "),
        dot: "success",
        group: "session",
      }));
      const names = new Set(loaded.map(plugin => plugin.name));
      const rest = installed
        .filter(plugin => !names.has(String(plugin.name ?? plugin.id ?? "").split("@")[0]!))
        .map(plugin => ({ id: `i:${String(plugin.id ?? plugin.name)}`, label: String(plugin.name ?? plugin.id), detail: [plugin.version, plugin.marketplace, plugin.enabled === false ? "disabled" : "enabled"].filter(Boolean).join(" · "), dot: plugin.enabled === false ? "muted" : "pending", group: "installed" }));
      const have = new Set(installed.map(plugin => String(plugin.id ?? plugin.name)));
      const market = available.map(plugin => ({
        id: `a:${String(plugin.pluginId ?? plugin.name)}`,
        label: String(plugin.name ?? plugin.pluginId),
        detail: [String(plugin.marketplaceName ?? String(plugin.pluginId ?? "").split("@")[1] ?? ""), firstLine(String(plugin.description ?? ""), 120)].filter(Boolean).join(" · "),
        group: "market",
        search: String(plugin.description ?? "").slice(0, 600),
        ...(have.has(String(plugin.pluginId)) ? { badges: [{ text: "installed", tone: "accent" }] } : {}),
      }));
      return [...session, ...rest.map(item => ({ ...item, group: "mine" })), ...market];
    };
    // Runs a `claude plugin …` command and says how it went; the lists are read again after it.
    const manage = (args: string[], doing: string, done: string): void => {
      this.toast(`${doing}…`);
      execFile(bin, ["plugin", ...args], { cwd: this.#cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) this.toast(firstLine((stderr || stdout || error.message).trim().split("\n").at(-1) ?? "", 220) || `${doing} failed`, "error");
        else this.toast(`${done}. /reload-plugins applies it to this session`, "success");
        load();
        this.schedule();
      });
    };
    const load = (): void => {
      execFile(bin, ["plugin", "list", "--available", "--json"], { cwd: this.#cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error || this.#picker !== opened) return;
        try {
          const parsed: any = JSON.parse(stdout);
          installed = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.installed) ? parsed.installed : [];
          available = Array.isArray(parsed?.available) ? parsed.available : [];
          opened.setItems(items());
          this.schedule();
        } catch {
          /* the session's own list stands */
        }
      });
    };
    const opened = this.#openPicker({
      props: { title: "Plugins", icon: "package", noun: "plugins", size: "lg", layout: "rows", preview: "side", placeholder: "Search plugins…" },
      items: items(),
      searchable: true,
      tabs: [
        { id: "mine", label: "Yours", test: item => item.group !== "market" },
        { id: "market", label: "Marketplace", test: item => item.group === "market" },
      ],
      tab: "mine",
      actions: [
        { id: "details", label: "Details", keys: ["enter"], primary: true },
        { id: "install", label: "Install", keys: ["ctrl", "o"] },
        { id: "remove", label: "Uninstall", keys: ["ctrl", "d"] },
        { id: "toggle", label: "Enable / disable", keys: ["ctrl", "t"] },
        { id: "source", label: "Add marketplace", keys: ["ctrl", "n"] },
        { id: "refresh", label: "Update marketplaces", keys: ["ctrl", "r"] },
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      empty: "No plugins",
      preview: id => {
        const text = id ? details.get(id) : undefined;
        return [text ? h("ansi", { key: "details", text }) : h("text", { key: "hint", spans: [s("Enter shows what the plugin adds and what it costs in tokens", "muted")] })];
      },
      choose: id => {
        const name = id.slice(2);
        if (id.startsWith("a:")) {
          const plugin = available.find(entry => String(entry.pluginId ?? entry.name) === name);
          details.set(id, [String(plugin?.name ?? name), "", String(plugin?.description ?? "No description"), "", plugin?.version ? `Version ${String(plugin.version)}` : "", `From ${String(plugin?.marketplaceName ?? name.split("@")[1] ?? "a marketplace")}`, "", "Ctrl+O installs it for you (user scope)."].filter((line, index, all) => line || all[index - 1]).join("\n"));
          this.schedule();
          return;
        }
        // A plugin given with --plugin-dir is only known to a process started with it.
        const path = (this.#plugins.length ? this.#plugins : given()).find(plugin => plugin.name === name)?.path;
        details.set(id, "Reading…");
        this.schedule();
        execFile(bin, [...(id.startsWith("s:") && path && path !== "builtin" ? ["--plugin-dir", path] : []), "plugin", "details", name], { cwd: this.#cwd, timeout: 30_000 }, (error, stdout, stderr) => {
          details.set(id, (stdout || stderr || error?.message || "No details").trim().slice(0, 20_000));
          this.schedule();
        });
      },
      act: (act, id) => {
        if (act === "install") {
          if (!id?.startsWith("a:")) this.toast("Pick a plugin on the Marketplace tab to install", "warning");
          else manage(["install", id.slice(2), "--scope", "user"], `Installing ${id.slice(2).split("@")[0]}`, `Installed ${id.slice(2).split("@")[0]}`);
        } else if (act === "remove") {
          const plugin = installed.find(entry => `i:${String(entry.id ?? entry.name)}` === id || `a:${String(entry.id ?? entry.name)}` === id);
          if (!plugin) this.toast("Only installed plugins can be uninstalled", "warning");
          else manage(["uninstall", String(plugin.id ?? plugin.name), ...(plugin.scope ? ["--scope", String(plugin.scope)] : [])], `Uninstalling ${String(plugin.name ?? plugin.id)}`, `Uninstalled ${String(plugin.name ?? plugin.id)}`);
        } else if (act === "refresh") manage(["marketplace", "update"], "Updating the marketplaces", "Marketplaces updated");
        else if (act === "source") {
          // The dialog takes the picker's place. Not awaited: it needs the keys this handler would hold up.
          this.#picker = null;
          void this.#askText({ title: "Add a marketplace", detail: "A GitHub repository (owner/repo), a git URL, or a folder.", placeholder: "owner/repo" }).then(source => {
            if (!source?.trim()) return;
            this.toast("Adding the marketplace…");
            execFile(bin, ["plugin", "marketplace", "add", source.trim()], { cwd: this.#cwd, timeout: 180_000 }, (error, stdout, stderr) => {
              if (error) this.toast(firstLine((stderr || stdout || error.message).trim().split("\n").at(-1) ?? "", 220), "error");
              else {
                this.toast("Marketplace added", "success");
                this.#pickPlugins();
              }
              this.schedule();
            });
          });
        } else if (act === "toggle" && id) {
          const plugin = installed.find(entry => `i:${String(entry.id ?? entry.name)}` === id);
          if (!plugin) {
            this.toast("A plugin given with --plugin-dir is on for the session; installed ones can be switched", "warning");
            return;
          }
          execFile(bin, ["plugin", plugin.enabled === false ? "enable" : "disable", String(plugin.id ?? plugin.name)], { cwd: this.#cwd, timeout: 30_000 }, (error, stdout, stderr) => {
            if (error) this.toast(firstLine(stderr || error.message, 160), "error");
            else {
              plugin.enabled = plugin.enabled === false;
              opened.setItems(items());
              this.toast(`${firstLine(stdout, 100) || "Done"}. /reload-plugins applies it to this session`);
            }
            this.schedule();
          });
        }
      },
    });
    load();
  }

  /** `/export`: the conversation as Markdown, in the project folder unless a path is given. */
  #export(args: string): void {
    const lines: string[] = [`# ${this.conv.sessionName || "Claude Code session"}`, "", `Session \`${this.conv.sessionId}\` · ${showPath(this.#cwd, "")} · ${new Date().toLocaleString()}`, ""];
    for (const item of this.conv.items) {
      switch (item.kind) {
        case "user":
          lines.push("## You", "", item.text, "");
          break;
        case "assistant":
          if (item.text.trim()) lines.push(item.text, "");
          break;
        case "tool": {
          const args_ = item.args ?? {};
          const what = String(args_.command ?? args_.file_path ?? args_.path ?? args_.pattern ?? args_.query ?? args_.url ?? "");
          lines.push(`> **${toolTitle(String(item.name))}** ${what ? `\`${firstLine(what, 200)}\`` : ""}${item.status === "error" ? " (failed)" : ""}`, "");
          if (item.name === "Bash" && item.output) lines.push("```", item.output.slice(0, 4000), "```", "");
          break;
        }
        case "agent":
          lines.push(`> **Subagent** ${firstLine(item.args?.description ?? item.agentType ?? "", 200)}`, "", ...(item.output ? [item.output, ""] : []));
          break;
        case "bash":
          lines.push(`> **!** \`${firstLine(item.text, 200)}\``, "", ...(item.output ? ["```", item.output.slice(0, 4000), "```", ""] : []));
          break;
        case "compaction":
          lines.push("---", "*Conversation compacted*", "", ...(item.text ? [item.text, ""] : []));
          break;
        case "error":
          lines.push(`> **Error** ${firstLine(item.text, 400)}`, "");
          break;
        default:
          break;
      }
    }
    const raw = args.trim().replace(/^['"]|['"]$/g, "") || `claude-session-${(this.conv.sessionId || "new").slice(0, 8)}.md`;
    const path = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(this.#cwd, raw);
    try {
      writeFileSync(path, lines.join("\n"));
      this.toast(`Exported to ${showPath(path, this.#cwd)}`, "info", { act: "copy", label: "Copy path", run: () => this.copy(path, "Path") });
    } catch (error) {
      this.toast(`Could not export: ${firstLine((error as Error).message, 160)}`, "error");
    }
  }

  // ───────────────────────────────────────────────────────────── settings

  #prefRows(): { id: string; title: string; page: string; rows: PrefsRow[] }[] {
    const conv = this.conv;
    const levels = this.#levels();
    const auto = this.#modelInfo()?.supportsAutoMode === true;
    const modes = ["default", "acceptEdits", "plan", ...(auto ? ["auto"] : []), "dontAsk", ...(this.#launch.allowBypass ? ["bypassPermissions"] : [])];
    return [
      {
        id: "model",
        title: "Model",
        page: "session",
        rows: [
          { id: "model", label: "Model", hint: "The model answering this session", control: { k: "action", label: this.#modelName() || "Choose…", act: "pick-model" } },
          ...(levels.length > 1 ? [{ id: "effort", label: "Effort", hint: "How hard the model thinks before it answers", control: { k: "choice", value: conv.effort, options: levels.map(level => ({ value: level, label: level, detail: EFFORT_DETAIL[level] })), style: "menu" } }] : []),
          { id: "thinking", label: "Extended thinking", hint: "Let the model reason before it answers; some models always think  Alt+T", changed: this.#thinkingOff, defaultLabel: "on", control: { k: "switch", on: !this.#thinkingOff } },
          ...(this.#outputStyles.length ? [{ id: "output-style", label: "Output style", hint: "How Claude writes its replies; saved for this project", control: { k: "choice", value: this.#outputStyle, options: this.#outputStyles.map(style => ({ value: style, label: style })), style: "menu" } }] : []),
        ],
      },
      {
        id: "permissions",
        title: "Permissions",
        page: "session",
        rows: [
          { id: "mode", label: "Mode", hint: "What Claude may do without asking  Shift+Tab", control: { k: "choice", value: conv.permissionMode === "manual" ? "default" : conv.permissionMode, options: modes.map(mode => ({ value: mode, label: MODES[mode]!.label, detail: MODES[mode]!.hint })), style: "menu" } },
          { id: "rules", label: "Rules", hint: "The allow, ask and deny rules in force", control: { k: "action", label: "Show…", act: "pick-permissions" } },
        ],
      },
      {
        id: "turns",
        title: "Turns",
        page: "session",
        rows: [
          { id: "auto-compaction", label: "Auto-compact", hint: "Summarize the conversation when the context window fills. Changing it starts Claude Code again on this session", changed: !this.#autoCompact, defaultLabel: "on", control: { k: "switch", on: this.#autoCompact } },
          { id: "auto-retry", label: "Auto-retry", hint: "Retry a failed request after a short wait. Changing it starts Claude Code again on this session", changed: !this.#autoRetry, defaultLabel: "on", control: { k: "switch", on: this.#autoRetry } },
          {
            id: "steering-mode",
            label: "Messages while Claude works",
            hint: "What Enter does during a turn. Alt+Enter always queues for after the turn",
            changed: this.#steer !== "next",
            defaultLabel: "next step",
            control: { k: "choice", value: this.#steer, options: [{ value: "next", label: "At the next step" }, { value: "later", label: "After the turn" }, { value: "now", label: "Stop and send" }], style: "segmented" },
          },
        ],
      },
      {
        id: "claude-code",
        title: "Claude Code",
        page: "session",
        rows: (() => {
          // Claude Code's own /config settings, read from and written to the user's settings file.
          const path = settingsPath("userSettings", configDir(), this.#cwd);
          const choices = CLAUDE_CHOICES.map(choice => {
            const stored = getNested(path, choice.path);
            const value = typeof stored === "string" ? stored : choice.default;
            return { id: `ccc:${choice.id}`, label: choice.label, hint: `${choice.hint}. Saved in Claude Code's settings`, changed: value !== choice.default, defaultLabel: choice.options.find(option => option.value === choice.default)?.label ?? choice.default, control: { k: "choice", value, options: choice.options, style: "menu" } } as PrefsRow;
          });
          return [...choices, ...CLAUDE_SETTINGS.map(setting => {
            const stored = getKey(path, setting.key);
            const on = typeof stored === "boolean" ? stored : setting.default;
            return { id: `cc:${setting.key}`, label: setting.label, hint: `${setting.hint}. Saved in Claude Code's settings`, changed: on !== setting.default, defaultLabel: setting.default ? "on" : "off", control: { k: "switch", on } } as PrefsRow;
          })];
        })(),
      },
      {
        id: "composer",
        title: "Composer",
        page: "session",
        rows: [
          { id: "suggestions", label: "Prompt suggestions", hint: "Offer a next prompt after each turn; Tab takes it. Applies from the next session", changed: !this.#suggestions, defaultLabel: "on", control: { k: "switch", on: this.#suggestions } },
          { id: "vim-keys", label: "Vim keys", hint: "Normal, Insert and Visual modes in the composer; Esc leaves Insert mode", changed: this.#vimKeys, defaultLabel: "off", control: { k: "switch", on: this.#vimKeys } },
        ],
      },
      {
        id: "look",
        title: "Look",
        page: "display",
        rows: [
          ...(this.#statusLineCommand ? [{ id: "status-line", label: "Claude Code status line", hint: "Run the status line command from Claude Code's settings and draw its line among the composer's facts", changed: this.#statusLine, defaultLabel: "off", control: { k: "switch", on: this.#statusLine } }] : []),
          { id: "clay", label: "Claude accent", hint: "Claude's clay as the accent color; off uses the Tern theme's own accent. Everything else always follows the theme", changed: !this.#clay, defaultLabel: "on", control: { k: "switch", on: this.#clay } },
        ],
      },
      {
        id: "transcript",
        title: "Transcript",
        page: "display",
        rows: [
          { id: "trace-calls", label: "Trace Bash calls", hint: "Record which lines of Claude's commands run, for step-by-step replay. A traced command starts with a tracing line, so rules that allow commands by their text no longer match and Claude Code asks more often", changed: this.#traceCalls, defaultLabel: "off", control: { k: "switch", on: this.#traceCalls } },
          { id: "expand-all", label: "Expand every block", hint: "Open tool cards and thinking by default  Ctrl+O", changed: this.#expandAll, defaultLabel: "off", control: { k: "switch", on: this.#expandAll } },
          { id: "hide-thinking", label: "Hide thinking", hint: "Leave the model's reasoning out of the transcript", changed: this.#hideThinking, defaultLabel: "off", control: { k: "switch", on: this.#hideThinking } },
          { id: "show-tasks", label: "Task list", hint: "Draw the task list above the composer while there is open work  Ctrl+T", changed: !this.#showTasks, defaultLabel: "on", control: { k: "switch", on: this.#showTasks } },
          { id: "show-usage", label: "Token usage per message", hint: "A line under each reply with its tokens, time to first token and speed", changed: this.#showUsage, defaultLabel: "off", control: { k: "switch", on: this.#showUsage } },
          { id: "compact-tools", label: "Compact tool calls", hint: "Draw each tool call as one line, and close runs of them up", changed: this.#compactTools, defaultLabel: "off", control: { k: "switch", on: this.#compactTools } },
          { id: "show-charts", label: "Chart tables of numbers", hint: "Follow a table of numbers in a reply with a bar chart of it", changed: !this.#showCharts, defaultLabel: "on", control: { k: "switch", on: this.#showCharts } },
          { id: "show-images", label: "Show images", hint: "Draw attached and tool-result images inline", changed: !this.#showImages, defaultLabel: "on", control: { k: "switch", on: this.#showImages } },
        ],
      },
    ];
  }

  #openPrefs(): void {
    this.#completion = null;
    // No row is focused until a key moves to one: Tern scrolls a focused row to the top of the page, under its sticky header.
    this.#prefs = { page: "session", focus: null };
  }

  #prefsView(): Node {
    const prefs = this.#prefs!;
    const sections = this.#prefRows().filter(section => section.page === prefs.page);
    return prefsNode(
      {
        title: `${PROFILE.name} settings`,
        pages: [
          { id: "session", label: "Session", icon: "model" },
          { id: "display", label: "Display", icon: "appearance" },
        ],
        page: prefs.page,
        lead: prefs.page === "session" ? "The model, permissions, turns, Claude Code's own switches, and the composer." : "How the transcript is drawn in this pane. Colors follow Tern's theme, light or dark.",
        sections: sections.map(({ id, title, rows }) => ({ id, title, rows })),
        focus: prefs.focus,
        ...(prefs.editing ? { editing: prefs.editing } : {}),
      },
      {
        change: (row, value) => {
          prefs.editing = null;
          void this.#prefsChange(row, value);
        },
        // A click on a row focuses it; in an open menu it arrives as `row=option` and moves the cursor there.
        select: item => {
          const at = item.indexOf("=");
          if (prefs.editing && at > 0 && item.slice(0, at) === prefs.editing.row) prefs.editing = { row: prefs.editing.row, option: item.slice(at + 1) };
          else {
            prefs.focus = item;
            if (prefs.editing && prefs.editing.row !== item) prefs.editing = null;
          }
          this.schedule();
        },
        // A click on a dropdown asks for its menu: Tern draws it while `editing` names the row.
        activate: item => {
          const row = this.#prefRows().flatMap(section => section.rows).find(entry => entry.id === item);
          const control = row?.control as { k: string; value?: string; options?: { value: string }[]; act?: string; on?: boolean } | undefined;
          if (!row || !control) return;
          prefs.focus = item;
          if (control.k === "choice" && control.options?.length) prefs.editing = prefs.editing?.row === item ? null : { row: item, option: control.value ?? control.options[0]!.value };
          else if (control.k === "action" && control.act) this.#prefsAction(control.act, undefined);
          this.schedule();
        },
      },
    );
  }

  #prefsAction(act: string, value: string | undefined): void {
    const prefs = this.#prefs;
    if (!prefs) return;
    // With a dropdown open, a click elsewhere or Esc closes the dropdown first, not the whole window.
    if ((act === "close" || act === "cancel") && prefs.editing) prefs.editing = null;
    else if (act === "close" || act === "cancel") this.#prefs = null;
    else if (act === "page" && value) {
      prefs.page = value;
      prefs.focus = null;
      prefs.editing = null;
    } else if (act === "pick-model") {
      this.#prefs = null;
      this.#pickModel();
    } else if (act === "pick-permissions") {
      this.#prefs = null;
      void this.#pickPermissions();
    }
  }

  async #prefsChange(row: string, value: unknown): Promise<void> {
    try {
      if (row.startsWith("ccc:")) {
        const choice = CLAUDE_CHOICES.find(entry => `ccc:${entry.id}` === row);
        if (!choice) return;
        const picked = typeof value === "string" && choice.options.some(option => option.value === value) ? value : choice.default;
        setNested(settingsPath("userSettings", configDir(), this.#cwd), choice.path, picked);
        this.toast(`${choice.label}: ${choice.options.find(option => option.value === picked)?.label ?? picked}`);
        this.schedule();
        return;
      }
      if (row.startsWith("cc:")) {
        const setting = CLAUDE_SETTINGS.find(entry => `cc:${entry.key}` === row);
        if (!setting) return;
        // Reset writes the default out rather than removing the key: Claude Code's own screen does the same.
        const on = value === null ? setting.default : Boolean(value);
        setKey(settingsPath("userSettings", configDir(), this.#cwd), setting.key, on);
        this.toast(`${setting.label} ${on ? "on" : "off"}`);
        this.schedule();
        return;
      }
      switch (row) {
        case "effort":
          if (typeof value === "string") await this.#setEffort(value);
          break;
        case "mode":
          if (typeof value === "string") await this.#setMode(value);
          break;
        case "thinking":
          await this.#setThinking(value === null ? true : Boolean(value));
          break;
        case "output-style":
          if (typeof value === "string") this.#pickOutputStyle(value);
          break;
        case "suggestions":
          this.#suggestions = value === null ? true : Boolean(value);
          break;
        case "status-line":
          this.#statusLine = Boolean(value);
          if (this.#statusLine && !this.#statusLineCommand) this.toast("Claude Code has no statusLine command in its settings", "warning");
          this.#statusLineAt = 0;
          this.#runStatusLine();
          break;
        case "auto-compaction":
          this.#autoCompact = value === null ? true : Boolean(value);
          this.#saveDisplay();
          await this.#respawn();
          this.toast(`Auto-compact ${this.#autoCompact ? "on" : "off"}`);
          break;
        case "auto-retry":
          this.#autoRetry = value === null ? true : Boolean(value);
          this.#saveDisplay();
          await this.#respawn();
          this.toast(`Auto-retry ${this.#autoRetry ? "on" : "off"}`);
          break;
        case "steering-mode":
          this.#steer = value === "later" || value === "now" ? value : "next";
          break;
        case "trace-calls":
          this.#traceCalls = Boolean(value);
          this.toast(this.#traceCalls ? "Tracing Claude's Bash calls: Claude Code may ask about commands it used to allow" : "Tracing off");
          break;
        case "clay":
          this.#clay = value === null ? true : Boolean(value);
          this.#applyStyles();
          break;
        case "expand-all":
          this.#expandAll = Boolean(value);
          this.#fold.clear();
          this.#foldRev += 1;
          break;
        case "hide-thinking":
          this.#hideThinking = Boolean(value);
          this.#foldRev += 1;
          break;
        case "show-tasks":
          this.#showTasks = value === null ? true : Boolean(value);
          break;
        case "show-images":
          this.#showImages = value === null ? true : Boolean(value);
          this.#foldRev += 1;
          break;
        case "vim-keys":
          this.#vimKeys = Boolean(value);
          this.#vim.reset();
          break;
        case "compact-tools":
          this.#compactTools = Boolean(value);
          this.#fold.clear();
          this.#foldRev += 1;
          break;
        case "show-charts":
          this.#showCharts = value === null ? true : Boolean(value);
          this.#foldRev += 1;
          break;
        case "show-usage":
          this.#showUsage = Boolean(value);
          this.#foldRev += 1;
          break;
        default:
          break;
      }
    } catch (error) {
      this.toast(firstLine((error as Error).message, 160), "error");
    }
    this.#saveDisplay();
    this.schedule();
  }

  /** Display choices are the surface's own and outlive the session. */
  #displayPath(): string {
    return join(stateDir(), "display.json");
  }

  #loadDisplay(): void {
    try {
      const stored = JSON.parse(readFileSync(this.#displayPath(), "utf8")) as Record<string, unknown>;
      this.#expandAll = stored.expandAll === true;
      this.#hideThinking = stored.hideThinking === true;
      this.#showImages = stored.showImages !== false;
      this.#showUsage = stored.showUsage === true;
      this.#vimKeys = stored.vimKeys === true;
      this.#showCharts = stored.showCharts !== false;
      this.#compactTools = stored.compactTools === true;
      this.#showTasks = stored.showTasks !== false;
      this.#clay = stored.clay !== false;
      this.#suggestions = stored.suggestions !== false;
      this.#statusLine = stored.statusLine === true;
      this.#traceCalls = stored.traceCalls === true;
      this.#autoCompact = stored.autoCompact !== false;
      this.#autoRetry = stored.autoRetry !== false;
      this.#steer = stored.steer === "later" || stored.steer === "now" ? stored.steer : "next";
    } catch {
      /* defaults */
    }
  }

  #saveDisplay(): void {
    try {
      writeFileSync(
        this.#displayPath(),
        JSON.stringify({ expandAll: this.#expandAll, hideThinking: this.#hideThinking, showImages: this.#showImages, showUsage: this.#showUsage, vimKeys: this.#vimKeys, showCharts: this.#showCharts, compactTools: this.#compactTools, showTasks: this.#showTasks, clay: this.#clay, suggestions: this.#suggestions, statusLine: this.#statusLine, traceCalls: this.#traceCalls, autoCompact: this.#autoCompact, autoRetry: this.#autoRetry, steer: this.#steer }),
        { mode: 0o600 },
      );
    } catch {
      /* a preference that is not saved still applies now */
    }
  }

  #prefsKey(key: Key): void {
    const prefs = this.#prefs!;
    const pages = ["session", "display"];
    const rows = this.#prefRows()
      .filter(section => section.page === prefs.page)
      .flatMap(section => section.rows);
    const at = rows.findIndex(row => row.id === prefs.focus);
    const row = rows[at];
    const step = (delta: number): void => {
      if (!row) return;
      const control = row.control as { k: string; on?: boolean; value?: string; options?: { value: string }[]; act?: string };
      if (control.k === "switch") void this.#prefsChange(row.id, !control.on);
      else if (control.k === "choice" && control.options?.length) {
        const index = control.options.findIndex(option => option.value === control.value);
        const next = control.options[(index + delta + control.options.length) % control.options.length];
        if (next) void this.#prefsChange(row.id, next.value);
      } else if (control.k === "action" && control.act) this.#prefsAction(control.act, undefined);
    };
    // An open menu owns the keys: arrows move in it, Enter picks, Esc closes it.
    if (prefs.editing) {
      const editing = prefs.editing;
      const options = ((rows.find(entry => entry.id === editing.row)?.control as { options?: { value: string }[] } | undefined)?.options ?? []).map(option => option.value);
      const index = options.indexOf(editing.option);
      if (key.name === "escape") prefs.editing = null;
      else if (key.name === "up") prefs.editing = { row: editing.row, option: options[Math.max(0, index - 1)] ?? editing.option };
      else if (key.name === "down") prefs.editing = { row: editing.row, option: options[Math.min(options.length - 1, index + 1)] ?? editing.option };
      else if (key.name === "enter" || key.name === "space") {
        prefs.editing = null;
        void this.#prefsChange(editing.row, editing.option);
      }
      return;
    }
    const menu = (): boolean => {
      const control = row?.control as { k: string; value?: string; options?: { value: string }[]; style?: string } | undefined;
      if (!row || control?.k !== "choice" || control.style === "segmented" || !control.options?.length) return false;
      prefs.editing = { row: row.id, option: control.value ?? control.options[0]!.value };
      return true;
    };
    switch (key.name) {
      case "escape":
        this.#prefs = null;
        return;
      case "up":
        prefs.focus = rows[Math.max(0, at - 1)]?.id ?? prefs.focus;
        return;
      case "down":
        prefs.focus = rows[Math.min(rows.length - 1, at + 1)]?.id ?? prefs.focus;
        return;
      case "tab": {
        const next = pages[(pages.indexOf(prefs.page) + (key.shift ? -1 : 1) + pages.length) % pages.length]!;
        this.#prefsAction("page", next);
        return;
      }
      case "left":
        step(-1);
        return;
      case "right":
        step(1);
        return;
      case "enter":
      case "space":
        if (!menu()) step(1);
        return;
      default:
        return;
    }
  }

  // ───────────────────────────────────────────────────────────── history file

  #historyPath(): string {
    return join(stateDir(), "history.json");
  }

  #loadHistory(): void {
    try {
      const stored = JSON.parse(readFileSync(this.#historyPath(), "utf8")) as unknown;
      if (Array.isArray(stored)) this.editor.history = stored.filter((entry): entry is string => typeof entry === "string").slice(-500);
    } catch {
      /* no history yet */
    }
  }

  #saveHistory(): void {
    try {
      writeFileSync(this.#historyPath(), JSON.stringify(this.editor.history.slice(-500)), { mode: 0o600 });
    } catch {
      /* history is a nicety */
    }
  }
}
