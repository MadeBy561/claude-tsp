import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyUpdate, CHECK_EVERY_MS, checkForUpdate, compareVersions, gitBlocker, installOf, loadUpdateState, manualUpdate, newerThan, notesOf, parseVersion, releasesOf, saveUpdateState, updateKind, updateSteps } from "../dist/update.js";

const payload = [
  { tag_name: "v1.2.0", body: "## [1.2.0] - 2026-12-01\n\n### Added\n- Agents pane", html_url: "https://example.test/v1.2.0", published_at: "2026-12-01T10:00:00Z", assets: [{ name: "claude-tsp-1.2.0.tgz", browser_download_url: "https://example.test/claude-tsp-1.2.0.tgz" }] },
  { tag_name: "v1.0.1", body: "## [1.0.1]\n\n### Fixed\n- Welcome on phones", html_url: "https://example.test/v1.0.1", published_at: "2026-11-20T10:00:00Z", assets: [] },
  { tag_name: "v1.3.0-beta.1", body: "beta", prerelease: true },
  { tag_name: "v9.9.9", body: "draft", draft: true },
  { tag_name: "nightly", body: "not a version" },
  { tag_name: "v1.0.0", body: "", html_url: "https://example.test/v1.0.0", published_at: "2026-11-15T10:00:00Z", assets: [] },
];
const reply = body => async () => ({ ok: true, status: 200, json: async () => body });
const temp = () => mkdtempSync(join(tmpdir(), "ctsp-update-"));

test("versions compare as numbers, and an update has a kind", () => {
  assert.deepEqual(parseVersion("v1.10.2"), [1, 10, 2]);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("1.2.3-beta.1"), null);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(updateKind("1.0.0", "1.0.1"), "patch");
  assert.equal(updateKind("1.0.3", "1.1.0"), "minor");
  assert.equal(updateKind("1.4.0", "2.0.0"), "major");
  assert.equal(updateKind("1.1.0", "1.0.9"), null);
  assert.equal(updateKind("1.1.0", "1.1.0"), null);
});

test("only published releases with a plain version count, newest first", () => {
  const releases = releasesOf(payload);
  assert.deepEqual(releases.map(release => release.version), ["1.2.0", "1.0.1", "1.0.0"]);
  assert.equal(releases[0].tarball, "https://example.test/claude-tsp-1.2.0.tgz");
  assert.equal(releases[1].tarball, null);
  assert.deepEqual(newerThan(releases, "1.0.0").map(release => release.version), ["1.2.0", "1.0.1"]);
  assert.deepEqual(newerThan(releases, "1.2.0"), []);
  assert.deepEqual(releasesOf({ message: "rate limited" }), []);
});

test("the notes cover every release in between, without the changelog's own heading", () => {
  const notes = notesOf(newerThan(releasesOf(payload), "1.0.0"));
  assert.match(notes, /^## 1\.2\.0 {2}· {2}2026-12-01\n\n### Added\n- Agents pane/);
  assert.match(notes, /## 1\.0\.1 {2}· {2}2026-11-20\n\n### Fixed\n- Welcome on phones$/);
  assert.doesNotMatch(notes, /\[1\.2\.0\]/);
  assert.match(notesOf([{ version: "1.0.0", tag: "v1.0.0", notes: "", url: "", tarball: null, publishedAt: "" }]), /No notes were written/);
});

test("GitHub is asked once a day, and a failed check keeps what was known", async () => {
  const dir = temp();
  try {
    let asked = 0;
    const fetcher = async (url, init) => {
      asked += 1;
      assert.match(init.headers["user-agent"], /^claude-tsp\/1\.0\.0$/);
      return reply(payload)();
    };
    const first = await checkForUpdate(dir, "1.0.0", { now: 1000, fetcher });
    assert.deepEqual([first.fresh, first.newer.map(release => release.version)], [true, ["1.2.0", "1.0.1"]]);
    // Within the day: the remembered answer, no request.
    const second = await checkForUpdate(dir, "1.0.0", { now: 1000 + CHECK_EVERY_MS - 1, fetcher });
    assert.deepEqual([second.fresh, second.newer.length, asked], [false, 2, 1]);
    // Once updated, the same answer offers nothing.
    assert.deepEqual((await checkForUpdate(dir, "1.2.0", { now: 2000, fetcher })).newer, []);
    // Asked for by hand: a request, whatever the time.
    await checkForUpdate(dir, "1.0.0", { now: 3000, fetcher, force: true });
    assert.equal(asked, 2);
    // GitHub down a day later: the error is reported, the known releases stay, and the next try is in an hour.
    const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const later = 3000 + CHECK_EVERY_MS + 1;
    const failed = await checkForUpdate(dir, "1.0.0", { now: later, fetcher: down });
    assert.match(failed.error, /HTTP 503/);
    assert.equal(failed.newer.length, 2);
    let again = 0;
    const counting = async () => ((again += 1), reply(payload)());
    await checkForUpdate(dir, "1.0.0", { now: later + 30 * 60 * 1000, fetcher: counting });
    assert.equal(again, 0);
    await checkForUpdate(dir, "1.0.0", { now: later + 61 * 60 * 1000, fetcher: counting });
    assert.equal(again, 1);
    // What the user set aside survives the checks.
    saveUpdateState(dir, { ...loadUpdateState(dir), skipped: "1.2.0", ran: "1.0.0" });
    await checkForUpdate(dir, "1.0.0", { force: true, fetcher: counting });
    assert.deepEqual([loadUpdateState(dir).skipped, loadUpdateState(dir).ran], ["1.2.0", "1.0.0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("how a copy is updated follows how it was installed", () => {
  const release = releasesOf(payload)[0];
  assert.equal(installOf("/opt/lib/node_modules/claude-tsp").kind, "npm");
  assert.equal(installOf("/opt/claude-tsp-unpacked").kind, "copy");
  const git = updateSteps({ kind: "git", root: "/src/claude-tsp" }, release);
  assert.deepEqual(git.map(step => [step.cmd, ...step.args]), [
    ["git", "fetch", "--tags", "--quiet", "origin"],
    ["git", "merge", "--ff-only", "--quiet", "v1.2.0"],
    ["npm", "ci", "--no-audit", "--no-fund"],
  ]);
  assert.deepEqual(updateSteps({ kind: "npm", root: "/x/node_modules/claude-tsp" }, release)[0].args.at(-1), "https://example.test/claude-tsp-1.2.0.tgz");
  // No tarball to hand to npm, or a plain copy: by hand.
  assert.equal(updateSteps({ kind: "npm", root: "/x" }, releasesOf(payload)[1]), null);
  assert.equal(updateSteps({ kind: "copy", root: "/x" }, release), null);
  assert.match(manualUpdate({ kind: "copy", root: "/x" }, release), /npm install --global https:\/\/example\.test\/claude-tsp-1\.2\.0\.tgz/);
});

/** A runner that answers from a table and records what was run. */
function fake(table) {
  const ran = [];
  const runner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    ran.push(line);
    for (const [pattern, result] of table) if (pattern.test(line)) return typeof result === "function" ? result() : result;
    return { code: 0, out: "" };
  };
  return { ran, runner };
}
const CLEAN = [
  [/remote get-url/, { code: 0, out: "https://github.com/MadeBy561/claude-tsp.git" }],
  [/rev-parse --abbrev-ref/, { code: 0, out: "main" }],
  [/status --porcelain/, { code: 0, out: "" }],
  [/rev-parse HEAD/, { code: 0, out: "a".repeat(40) }],
];

test("a clone is only moved when it is this repository, on main, with nothing uncommitted", async () => {
  assert.equal(await gitBlocker("/r", fake(CLEAN).runner), null);
  assert.equal(await gitBlocker("/r", fake([[/remote get-url/, { code: 0, out: "git@github.com:madeby561/claude-tsp" }], ...CLEAN.slice(1)]).runner), null);
  assert.match(await gitBlocker("/r", fake([[/remote get-url/, { code: 0, out: "https://github.com/someone/fork.git" }]]).runner), /origin is not/);
  assert.match(await gitBlocker("/r", fake([CLEAN[0], [/abbrev-ref/, { code: 0, out: "next" }]]).runner), /branch next, not main/);
  assert.match(await gitBlocker("/r", fake([CLEAN[0], CLEAN[1], [/status --porcelain/, { code: 0, out: " M src/app.ts" }]]).runner), /uncommitted changes/);
  // Refused before anything is fetched or moved.
  const dirty = fake([CLEAN[0], CLEAN[1], [/status --porcelain/, { code: 0, out: " M src/app.ts" }]]);
  const outcome = await applyUpdate({ kind: "git", root: "/r" }, releasesOf(payload)[0], () => undefined, dirty.runner);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /uncommitted changes/);
  assert.ok(!dirty.ran.some(line => /fetch|merge|npm/.test(line)));
});

test("an update runs its steps in order, and a failed build puts the old version back", async () => {
  const release = releasesOf(payload)[0];
  const good = fake(CLEAN);
  const labels = [];
  assert.deepEqual(await applyUpdate({ kind: "git", root: "/r" }, release, label => labels.push(label), good.runner), { ok: true });
  assert.deepEqual(good.ran.slice(-3), ["git fetch --tags --quiet origin", "git merge --ff-only --quiet v1.2.0", "npm ci --no-audit --no-fund"]);
  assert.deepEqual(labels, ["Fetching the release", "Moving to v1.2.0", "Installing and building"]);

  // The fetch fails: nothing has moved, nothing to put back.
  const offline = fake([...CLEAN, [/git fetch/, { code: 128, out: "fatal: unable to access" }]]);
  const first = await applyUpdate({ kind: "git", root: "/r" }, release, () => undefined, offline.runner);
  assert.deepEqual([first.ok, first.restored], [false, undefined]);
  assert.match(first.error, /Fetching the release failed/);
  assert.ok(!offline.ran.some(line => /reset/.test(line)));

  // The build fails after the move: back to the commit that was running, rebuilt.
  let builds = 0;
  const broken = fake([...CLEAN, [/npm ci/, () => ((builds += 1), builds === 1 ? { code: 1, out: "error TS2304: Cannot find name" } : { code: 0, out: "" })]]);
  const second = await applyUpdate({ kind: "git", root: "/r" }, release, () => undefined, broken.runner);
  assert.deepEqual([second.ok, second.restored], [false, true]);
  assert.match(second.error, /TS2304/);
  assert.deepEqual(broken.ran.slice(-2), [`git reset --hard --quiet ${"a".repeat(40)}`, "npm ci --no-audit --no-fund"]);

  // A copy nobody can update for you says how.
  const manual = await applyUpdate({ kind: "copy", root: "/x" }, release, () => undefined, fake([]).runner);
  assert.match(manual.error, /updated by hand/);
});
