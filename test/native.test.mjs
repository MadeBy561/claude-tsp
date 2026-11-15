import assert from "node:assert/strict";
import { test } from "node:test";
import { compareUrl, parseRepo, secretFor, tokenIn, workflowFile, workflowText, API_KEY_SECRET, OAUTH_SECRET } from "../dist/github.js";
import { releaseNotes } from "../dist/notes.js";
import { addSession, emptyStats, finish } from "../dist/stats.js";

test("a repository is read from owner/repo or a GitHub link", () => {
  assert.equal(parseRepo(" acme/widgets "), "acme/widgets");
  assert.equal(parseRepo("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseRepo("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(parseRepo("widgets"), null);
  assert.equal(parseRepo("https://example.com/acme/widgets"), null);
});

test("the workflow reads the secret that was set up", () => {
  const key = workflowText("claude", API_KEY_SECRET);
  assert.match(key, /^name: Claude Code\n/);
  assert.ok(key.includes("anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}"));
  assert.ok(!key.includes("\\$"), "no template escapes are left in");
  const oauth = workflowText("claude-review", OAUTH_SECRET);
  assert.ok(oauth.includes("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"));
  assert.ok(!oauth.includes("ANTHROPIC_API_KEY"));
  assert.ok(workflowText("claude", "MY_KEY").includes("anthropic_api_key: ${{ secrets.MY_KEY }}"));
  assert.equal(workflowFile("claude-review").path, ".github/workflows/claude-code-review.yml");
});

test("a pasted credential goes in the secret of its kind", () => {
  assert.equal(secretFor("sk-ant-api03-abc"), API_KEY_SECRET);
  assert.equal(secretFor(" sk-ant-oat01-abc"), OAUTH_SECRET);
  assert.match(compareUrl("acme/widgets", "main", "b1"), /^https:\/\/github\.com\/acme\/widgets\/compare\/main\.\.\.b1\?quick_pull=1&title=/);
});

test("a token is found in what the setup command drew", () => {
  assert.equal(tokenIn("\x1b[2mYour token:\x1b[0m \x1b]8;;x\x07sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWX_yz\x1b[0m\r\n"), "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWX_yz");
  assert.equal(tokenIn("Opening browser to sign in…"), null);
});

test("release notes keep the newest sections and mark the installed one", () => {
  const log = "# Changelog\n\n## 2.0.2\n\n- newest\n\n## 2.0.1\n\n- middle\n\n## 2.0.0\n\n- " + "x".repeat(400) + "\n";
  const text = releaseNotes(log, "2.0.1", 60);
  assert.ok(text.startsWith("## 2.0.2"));
  assert.ok(text.includes("## 2.0.1  (installed)"));
  assert.ok(!text.includes("## 2.0.0"), "what does not fit is left out");
});

test("statistics count prompts, replies once, tokens and streaks", () => {
  const stats = emptyStats();
  const at = (day, hour = 10) => new Date(2026, 0, day, hour).toISOString();
  const reply = (id, day, usage) => ({ type: "assistant", timestamp: at(day), message: { id, model: "claude-opus-5", usage, content: [{ type: "tool_use" }] } });
  addSession(stats, [
    { type: "user", timestamp: at(1), message: { content: "hello" } },
    reply("m1", 1, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
    reply("m1", 1, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
    { type: "user", timestamp: at(1), message: { content: [{ type: "tool_result" }] } },
    { type: "user", isSidechain: true, timestamp: at(1), message: { content: "subagent" } },
    { type: "user", timestamp: at(2), message: { content: [{ type: "text" }] } },
    reply("m2", 2, { input_tokens: 1, output_tokens: 2 }),
  ]);
  addSession(stats, [{ type: "user", timestamp: at(4), message: { content: "later" } }]);
  addSession(stats, []);
  finish(stats, new Date(2026, 0, 5));
  assert.equal(stats.sessions, 2);
  assert.equal(stats.prompts, 3);
  assert.equal(stats.replies, 2);
  assert.equal(stats.toolCalls, 3);
  assert.deepEqual(stats.models.get("claude-opus-5"), { input: 11, output: 7, cacheRead: 100, cacheWrite: 0 });
  assert.equal(stats.days.size, 3);
  assert.equal(stats.firstDay, "2026-01-01");
  assert.equal(stats.longestStreak, 2);
  assert.equal(stats.currentStreak, 1, "yesterday keeps the streak alive");
  assert.equal(stats.longest.messages, 4);
});

test("permission rules are added to and removed from a settings file, the rest kept", async () => {
  const { addRule, removeRule, settingsPath, validRule } = await import("../dist/settingsfile.js");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync("/tmp/ctsp-settings-");
  const path = settingsPath("localSettings", "/cfg", dir);
  assert.equal(path, join(dir, ".claude", "settings.local.json"));
  assert.equal(settingsPath("userSettings", "/cfg", dir), "/cfg/settings.json");
  assert.equal(addRule(path, "allow", "Bash(npm test:*)"), true);
  assert.equal(addRule(path, "allow", "Bash(npm test:*)"), false);
  const user = join(dir, "settings.json");
  writeFileSync(user, JSON.stringify({ model: "opus", permissions: { deny: ["Read(.env)"], defaultMode: "plan" } }));
  assert.equal(addRule(user, "deny", "WebFetch"), true);
  assert.equal(removeRule(user, "deny", "Read(.env)"), true);
  assert.equal(removeRule(user, "deny", "Read(.env)"), false);
  assert.deepEqual(JSON.parse(readFileSync(user, "utf8")), { model: "opus", permissions: { deny: ["WebFetch"], defaultMode: "plan" } });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { permissions: { allow: ["Bash(npm test:*)"] } });
  assert.ok(validRule("Bash(npm run test:*)") && validRule("mcp__server__tool") && validRule("Read"));
  assert.ok(!validRule("npm test") && !validRule("(x)"));
  rmSync(dir, { recursive: true, force: true });
});

test("provider settings are written to the env block and taken out again", async () => {
  const { setEnv, readEnv } = await import("../dist/settingsfile.js");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync("/tmp/ctsp-env-");
  const path = `${dir}/settings.json`;
  writeFileSync(path, JSON.stringify({ model: "opus", env: { KEEP: "1" } }));
  assert.deepEqual(setEnv(path, { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global", ABSENT: null }), ["CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION"]);
  assert.deepEqual(readEnv(path), { KEEP: "1", CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global" });
  assert.deepEqual(setEnv(path, { CLAUDE_CODE_USE_VERTEX: null, CLOUD_ML_REGION: "" }), ["CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION"]);
  assert.deepEqual(setEnv(path, { KEEP: "1" }), []);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { model: "opus", env: { KEEP: "1" } });
  assert.deepEqual(readEnv(`${dir}/none.json`), {});
  rmSync(dir, { recursive: true, force: true });
});

test("one settings key is set, read and taken out, the rest kept", async () => {
  const { setKey, getKey, CLAUDE_SETTINGS } = await import("../dist/settingsfile.js");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync("/tmp/ctsp-key-");
  const path = `${dir}/settings.json`;
  writeFileSync(path, JSON.stringify({ model: "opus" }));
  assert.equal(getKey(path, "idleCompaction"), undefined);
  assert.equal(setKey(path, "idleCompaction", false), true);
  assert.equal(setKey(path, "idleCompaction", false), false);
  assert.equal(getKey(path, "idleCompaction"), false);
  assert.equal(setKey(path, "idleCompaction", undefined), true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { model: "opus" });
  assert.ok(CLAUDE_SETTINGS.every(setting => /^[a-zA-Z]+$/.test(setting.key) && typeof setting.default === "boolean"));
  rmSync(dir, { recursive: true, force: true });
});

test("a nested settings key is set beside its siblings", async () => {
  const { setNested, getNested, CLAUDE_CHOICES } = await import("../dist/settingsfile.js");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync("/tmp/ctsp-nest-");
  const path = `${dir}/settings.json`;
  writeFileSync(path, JSON.stringify({ permissions: { allow: ["Read"] } }));
  assert.equal(getNested(path, ["permissions", "defaultMode"]), undefined);
  assert.equal(setNested(path, ["permissions", "defaultMode"], "plan"), true);
  assert.equal(setNested(path, ["permissions", "defaultMode"], "plan"), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { permissions: { allow: ["Read"], defaultMode: "plan" } });
  assert.equal(setNested(path, ["worktree", "baseRef"], "head"), true);
  assert.equal(getNested(path, ["worktree", "baseRef"]), "head");
  assert.ok(CLAUDE_CHOICES.every(choice => choice.options.some(option => option.value === choice.default)));
  rmSync(dir, { recursive: true, force: true });
});
