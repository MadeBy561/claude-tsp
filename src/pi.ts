/**
 * What only the claude-pi toolkit knows about its routed models: the real
 * context window behind an alias id, and the local model's effort, which its
 * plugin keeps in its own store rather than in Claude Code's settings.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "./paths.js";

/** The alias id the local model is hosted on. */
export const LOCAL_ALIAS = "claude-haiku-4-5";
/** The alias ids the ChatGPT-subscription models are hosted on. */
const CHATGPT_ALIASES = new Set(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7"]);

function readJson(path: string): Record<string, any> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** The toolkit's own directory (account 2 keeps its config elsewhere, the toolkit stays here). */
function toolkit(): string {
  return process.env.CLAUDE_PI_ROOT || join(homedir(), ".claude-pi");
}

/** The context window of the model an alias really runs, or undefined for a real Claude model. */
export function realWindow(model: string): number | undefined {
  const id = model.replace(/\[1m\]$/, "");
  if (id === LOCAL_ALIAS) return Number(readJson(join(toolkit(), "local.json"))?.window) || 1_048_576;
  if (CHATGPT_ALIASES.has(id)) return 272_000;
  return undefined;
}

/** The efforts the local model's server takes. */
export const LOCAL_EFFORTS: readonly string[] = ["low", "high", "max"];

/** The effort the plugin has stored for the local model. */
export function localEffort(): string {
  const dir = join(configDir(), "plugins", "store");
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("pi-harness_") || !name.endsWith(".json")) continue;
      const store = readJson(join(dir, name));
      const effort = store?.deepseekEffort ?? store?.glmEffort;
      if (typeof effort === "string" && effort) return effort;
    }
  } catch {
    /* no store yet: the plugin's default applies */
  }
  return "max";
}
