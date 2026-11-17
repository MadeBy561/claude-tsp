/**
 * What the surface tells the terminal beside its own drawing, so the tab, the
 * sidebar and the inbox show the session as they show any agent's:
 *
 * - its run status, in the Program Status Protocol (OSC 7501): at rest,
 *   working, waiting on the user (with what for), finished, or failed. A
 *   program that reports nothing is shown as a command still running, so a
 *   tab would look busy for as long as the session is open;
 * - the session's name as the title (OSC 0), which names the tab;
 * - the folder the session works in (OSC 7), when it is not the one it was
 *   started in.
 *
 * Each is written only when it changes. The status record is removed when the
 * session ends, so nothing stale is left behind in the shell's terminal.
 */
import { hostname } from "node:os";

/** What a blocked session waits on. */
export type BlockedKind = "permission" | "question" | "auth";

/**
 * A run status, in OSC 7501 terms: `idle` at the prompt (also after an
 * interrupt), `working`, `blocked` on the user (`msg` says for what), `done`
 * with a result not yet looked at, `error` when the turn failed.
 */
export type RunStatus = { readonly state: "idle" | "working" | "done" } | { readonly state: "blocked"; readonly kind: BlockedKind; readonly msg?: string } | { readonly state: "error"; readonly msg?: string };

const OSC = "\x1b]";
const ST = "\x1b\\";
const BEL = "\x07";
/** Removes every record on the terminal. */
export const CLEAR_STATUS = `${OSC}7501;state=clear${ST}`;
/** Decoded `msg` may be 2048 bytes; a line this long is all a tab or a banner shows. */
const MSG_MAX = 240;
const TITLE_MAX = 80;

/** One line of printable text, cut to `max` characters: what a report or a title may carry. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : line;
}

/** The OSC 7501 report of `status` for the program `app`. A report replaces the record whole. */
export function statusReport(status: RunStatus, app: string): string {
  let body = `state=${status.state}`;
  if (status.state === "blocked") body += `:kind=${status.kind}`;
  const name = app.replace(/[^A-Za-z0-9_.+-]/g, "").slice(0, 32);
  if (name) body += `:app=${name}`;
  const msg = status.state === "blocked" || status.state === "error" ? oneLine(status.msg ?? "", MSG_MAX) : "";
  if (msg) body += `:msg=${Buffer.from(msg, "utf8").toString("base64")}`;
  return `${OSC}7501;${body}${ST}`;
}

/** The title sequence (OSC 0); an empty title gives the tab back its own name. */
export function titleReport(title: string): string {
  return `${OSC}0;${oneLine(title, TITLE_MAX)}${BEL}`;
}

/** The working folder as a shell reports it at each prompt (OSC 7). */
export function folderReport(path: string, host = hostname()): string {
  return `${OSC}7;file://${host}${path.split("/").map(encodeURIComponent).join("/")}${BEL}`;
}

/** Writes each signal when it changes, and takes the status record back at the end. */
export class Signals {
  readonly #write: (text: string) => void;
  readonly #app: string;
  /** The status and the name as last given: a frame that repeats them costs a comparison, nothing is formatted. */
  #status: string | undefined;
  #named = "";
  #title = "";
  #folder: string;
  #closed = false;

  /** `folder` is where the session was started: what the shell has already reported. */
  constructor(write: (text: string) => void, app: string, folder: string) {
    this.#write = write;
    this.#app = app;
    this.#folder = folder;
  }

  status(status: RunStatus): void {
    if (this.#closed) return;
    const given = `${status.state}:${status.state === "blocked" ? status.kind : ""}:${status.state === "blocked" || status.state === "error" ? (status.msg ?? "") : ""}`;
    if (given === this.#status) return;
    this.#status = given;
    this.#write(statusReport(status, this.#app));
  }

  title(title: string): void {
    if (this.#closed || title === this.#named) return;
    this.#named = title;
    const next = oneLine(title, TITLE_MAX);
    if (next === this.#title) return;
    this.#title = next;
    this.#write(titleReport(next));
  }

  folder(path: string): void {
    if (this.#closed || !path || path === this.#folder) return;
    this.#folder = path;
    this.#write(folderReport(path));
  }

  /**
   * Takes back what was told, while another program has the terminal (an
   * editor, Claude Code's own interface): it reports for itself, or is shown
   * as any running command is. The next `status` and `title` are written anew.
   */
  release(): void {
    if (this.#closed) return;
    if (this.#status !== undefined) this.#write(CLEAR_STATUS);
    if (this.#title) this.#write(titleReport(""));
    this.#status = undefined;
    this.#named = "";
    this.#title = "";
  }

  /**
   * The end of the session: the record goes (a `done` would otherwise outlive
   * the program and advertise a result nobody is left to show) and the tab
   * gets its own name back.
   */
  close(): void {
    this.release();
    this.#closed = true;
  }
}
