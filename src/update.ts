/**
 * Updates of claude-tsp itself.
 *
 * The releases are the GitHub releases of the repository (one per version,
 * its notes the version's section of the changelog). This module knows which
 * are newer than what runs, what they change, how this copy was installed,
 * and the commands that bring it to a release. Nothing here draws anything.
 *
 * Versions follow semver, and the kind of an update says what to expect:
 * a patch (`1.0.x`) fixes things, a minor (`1.x.0`) adds features, a major
 * changes something you have to act on (flags, settings, what it needs).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "MadeBy561/claude-tsp";
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
/** How long a check's answer is kept before GitHub is asked again. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export interface Release {
  /** `1.2.0`, without the tag's `v`. */
  version: string;
  tag: string;
  /** The release's notes, Markdown. */
  notes: string;
  /** Its page on GitHub. */
  url: string;
  /** The installable tarball attached to it, when there is one. */
  tarball: string | null;
  publishedAt: string;
}

export type UpdateKind = "major" | "minor" | "patch";

/** `1.2.3` (a leading `v` allowed) as numbers; null for anything else, a pre-release included. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal or not comparable. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

/** What kind of update `to` is from `from`; null when it is not newer. */
export function updateKind(from: string, to: string): UpdateKind | null {
  const left = parseVersion(from);
  const right = parseVersion(to);
  if (!left || !right || compareVersions(to, from) <= 0) return null;
  return right[0] !== left[0] ? "major" : right[1] !== left[1] ? "minor" : "patch";
}

export const KIND_LABEL: Record<UpdateKind, string> = { patch: "fixes", minor: "new features", major: "a major update" };

/** The releases in GitHub's answer: published ones with a plain version, newest first. */
export function releasesOf(payload: unknown): Release[] {
  if (!Array.isArray(payload)) return [];
  const out: Release[] = [];
  for (const entry of payload as Record<string, any>[]) {
    if (!entry || entry.draft || entry.prerelease) continue;
    const tag = String(entry.tag_name ?? "");
    if (!parseVersion(tag)) continue;
    const asset = (Array.isArray(entry.assets) ? entry.assets : []).find((file: any) => /\.tgz$/.test(String(file?.name ?? "")));
    out.push({ version: tag.replace(/^v/, ""), tag, notes: String(entry.body ?? "").trim(), url: String(entry.html_url ?? `https://github.com/${REPO}/releases/tag/${tag}`), tarball: asset?.browser_download_url ? String(asset.browser_download_url) : null, publishedAt: String(entry.published_at ?? "") });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** The releases newer than `installed`, newest first. */
export function newerThan(releases: readonly Release[], installed: string): Release[] {
  return releases.filter(release => compareVersions(release.version, installed) > 0);
}

/**
 * The notes of every release between what runs and the newest, newest first:
 * skipping a version does not skip what it changed.
 */
export function notesOf(releases: readonly Release[], limit = 60_000): string {
  let text = "";
  for (const release of releases) {
    // A release's notes open with the changelog's own heading for it.
    const body = release.notes.replace(/^##\s*\[?v?[\d.]+\]?[^\n]*\n+/, "").trim() || "No notes were written for this release.";
    const date = release.publishedAt ? `  ·  ${release.publishedAt.slice(0, 10)}` : "";
    const section = `## ${release.version}${date}\n\n${body}\n\n`;
    if (text && text.length + section.length > limit) {
      text += `…and ${releases.length - releases.indexOf(release)} earlier ${releases.length - releases.indexOf(release) === 1 ? "release" : "releases"}: <https://github.com/${REPO}/releases>\n`;
      break;
    }
    text += section;
  }
  return text.trimEnd();
}

// ───────────────────────────────────────────────────────────── what is remembered between runs

export interface UpdateState {
  /** When GitHub was last asked. */
  checkedAt: number;
  /** What it answered then. */
  releases: Release[];
  /** A version the user chose not to hear about again. */
  skipped?: string;
  /** The version last run, so the first run after an update can say what changed. */
  ran?: string;
}

const statePath = (dir: string): string => join(dir, "update.json");

export function loadUpdateState(dir: string): UpdateState {
  try {
    const stored = JSON.parse(readFileSync(statePath(dir), "utf8")) as Partial<UpdateState>;
    return { checkedAt: Number(stored.checkedAt) || 0, releases: Array.isArray(stored.releases) ? stored.releases.filter(release => release && parseVersion(release.version)) : [], ...(stored.skipped ? { skipped: String(stored.skipped) } : {}), ...(stored.ran ? { ran: String(stored.ran) } : {}) };
  } catch {
    return { checkedAt: 0, releases: [] };
  }
}

export function saveUpdateState(dir: string, state: UpdateState): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(dir), JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* a check that is not remembered is made again */
  }
}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Asks GitHub for the releases. Throws when it cannot be reached or refuses. */
export async function fetchReleases(installed: string, fetcher: Fetcher = fetch as unknown as Fetcher, timeoutMs = 8000): Promise<Release[]> {
  const reply = await fetcher(process.env.CLAUDE_TSP_RELEASES_URL || RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": `claude-tsp/${installed}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!reply.ok) throw new Error(reply.status === 403 || reply.status === 429 ? "GitHub is limiting requests from this address; try again later" : `GitHub answered HTTP ${reply.status}`);
  return releasesOf(await reply.json());
}

export interface CheckResult {
  /** The releases newer than what runs, newest first. */
  newer: Release[];
  /** Whether GitHub was asked now (false: the remembered answer). */
  fresh: boolean;
  /** Why the check failed, when it did; `newer` is then what was last known. */
  error?: string;
}

/**
 * The releases newer than `installed`. GitHub is asked at most once a day
 * unless `force`; between checks the remembered answer serves.
 */
export async function checkForUpdate(dir: string, installed: string, options: { force?: boolean; now?: number; fetcher?: Fetcher } = {}): Promise<CheckResult> {
  const now = options.now ?? Date.now();
  const state = loadUpdateState(dir);
  if (!options.force && state.checkedAt && now - state.checkedAt < CHECK_EVERY_MS) return { newer: newerThan(state.releases, installed), fresh: false };
  try {
    const releases = await fetchReleases(installed, options.fetcher);
    saveUpdateState(dir, { ...state, checkedAt: now, releases });
    return { newer: newerThan(releases, installed), fresh: true };
  } catch (error) {
    // A failed check is not retried at every start: the next one is in an hour.
    if (!options.force) saveUpdateState(dir, { ...state, checkedAt: now - CHECK_EVERY_MS + 60 * 60 * 1000 });
    return { newer: newerThan(state.releases, installed), fresh: false, error: (error as Error).message };
  }
}

// ───────────────────────────────────────────────────────────── installing one

/** How this copy got here, which decides how it is updated. */
export type Install =
  /** A clone of the repository: `git` moves it to the release, `npm` rebuilds it. */
  | { kind: "git"; root: string }
  /** Installed by `npm install -g`: npm installs the release's tarball over it. */
  | { kind: "npm"; root: string }
  /** Anything else (an unpacked archive, a copy): it is updated by hand. */
  | { kind: "copy"; root: string };

/** The package's own folder: the one holding `package.json`, above `dist`. */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function installOf(root: string = packageRoot()): Install {
  if (existsSync(join(root, ".git"))) return { kind: "git", root };
  if (root.split(sep).includes("node_modules")) return { kind: "npm", root };
  return { kind: "copy", root };
}

export interface Step {
  /** What the step does, for the progress line. */
  label: string;
  cmd: string;
  args: string[];
}

/** The commands that bring an install to `release`; null when it has to be done by hand. */
export function updateSteps(install: Install, release: Release): Step[] | null {
  if (install.kind === "git") {
    return [
      { label: "Fetching the release", cmd: "git", args: ["fetch", "--tags", "--quiet", "origin"] },
      // Fast-forward only: a checkout with commits of its own is never rewritten.
      { label: `Moving to ${release.tag}`, cmd: "git", args: ["merge", "--ff-only", "--quiet", release.tag] },
      { label: "Installing and building", cmd: "npm", args: ["ci", "--no-audit", "--no-fund"] },
    ];
  }
  if (install.kind === "npm" && release.tarball) return [{ label: `Installing ${release.version}`, cmd: "npm", args: ["install", "--global", "--no-audit", "--no-fund", release.tarball] }];
  return null;
}

/** What to tell someone whose copy is updated by hand. */
export function manualUpdate(install: Install, release: Release): string {
  if (install.kind === "git") return `cd ${install.root} && git pull --ff-only && npm ci`;
  if (release.tarball) return `npm install --global ${release.tarball}`;
  return `Download ${release.url} and replace ${install.root}`;
}

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; out: string }>;

const run: Runner = (cmd, args, cwd) =>
  new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((error as unknown as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() || (error ? error.message : "") });
    });
  });

/**
 * Why a clone cannot be updated in place, or null when it can: it must be a
 * clone of this repository, on `main`, with nothing uncommitted. Anything
 * else is someone's work in progress, and theirs to move.
 */
export async function gitBlocker(root: string, runner: Runner = run): Promise<string | null> {
  const remote = await runner("git", ["remote", "get-url", "origin"], root);
  if (remote.code !== 0 || !remote.out.toLowerCase().replace(/\.git$/, "").endsWith(REPO.toLowerCase())) return "this checkout's origin is not the claude-tsp repository";
  const branch = await runner("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (branch.code !== 0 || branch.out.trim() !== "main") return `this checkout is on ${branch.out.trim() === "HEAD" ? "a detached commit" : `branch ${branch.out.trim() || "unknown"}`}, not main`;
  const dirty = await runner("git", ["status", "--porcelain", "--untracked-files=no"], root);
  if (dirty.code !== 0 || dirty.out.trim()) return "this checkout has uncommitted changes";
  return null;
}

export interface UpdateOutcome {
  ok: boolean;
  /** What stopped it, with the failing command's output. */
  error?: string;
  /** The install was put back as it was after a failure. */
  restored?: boolean;
}

/**
 * Brings the install to `release`, a step at a time. A clone that fails after
 * it has moved is put back on the commit it was on and rebuilt, so a failed
 * update leaves what ran before.
 */
export async function applyUpdate(install: Install, release: Release, progress: (label: string) => void = () => undefined, runner: Runner = run): Promise<UpdateOutcome> {
  const steps = updateSteps(install, release);
  if (!steps) return { ok: false, error: "This copy is updated by hand." };
  let before = "";
  if (install.kind === "git") {
    const blocker = await gitBlocker(install.root, runner);
    if (blocker) return { ok: false, error: `Nothing was changed: ${blocker}.` };
    before = (await runner("git", ["rev-parse", "HEAD"], install.root)).out.trim();
  }
  for (const [index, step] of steps.entries()) {
    progress(step.label);
    const result = await runner(step.cmd, step.args, install.root);
    if (result.code === 0) continue;
    const error = `${step.label} failed (${step.cmd} ${step.args.join(" ")}): ${result.out.split("\n").slice(-6).join("\n") || `exit ${result.code}`}`;
    // Moved but not built: back to the commit that was running, and its build.
    if (install.kind === "git" && index >= 2 && /^[0-9a-f]{40}$/.test(before)) {
      progress("Putting the previous version back");
      const back = await runner("git", ["reset", "--hard", "--quiet", before], install.root);
      const rebuilt = back.code === 0 ? await runner("npm", ["ci", "--no-audit", "--no-fund"], install.root) : back;
      return { ok: false, error, restored: rebuilt.code === 0 };
    }
    return { ok: false, error };
  }
  return { ok: true };
}
