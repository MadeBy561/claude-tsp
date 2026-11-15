/**
 * claude-tsp's entry: inside Tern it opens a native surface over Claude
 * Code's stream-json session; anywhere else, and for every non-interactive
 * invocation, it is stock Claude Code with the original arguments.
 */
import { spawn } from "node:child_process";
import { connect, Session, type ConnectOptions } from "@stencil-hq/tern";
import { parseArgs } from "./args.js";
import { stockPath } from "./paths.js";

function runStock(args: string[]): Promise<number> {
  const bin = stockPath();
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", error => {
      process.stderr.write(`claude-tsp: could not run Claude Code (${bin}): ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else resolve(code ?? 0);
    });
  });
}

/** Whether the pane is Tern's own, so a surface can be opened before Tern has answered. */
function inTern(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "tern" && env.TERN_TSP !== "0" && !env.TMUX && !env.STY && !env.ZELLIJ;
}

export async function main(args: string[]): Promise<number> {
  const launch = parseArgs(args);
  if (!launch.native || !process.stdin.isTTY || !process.stdout.isTTY || process.env.CLAUDE_TSP_STOCK === "1") return runStock(args);
  const { VERSION, App } = await import("./app.js");
  const options: ConnectOptions = { app: "claude-tsp", version: VERSION, features: ["edit", "undo", "send"], ...(process.env.CLAUDE_TSP_RECORD ? { record: process.env.CLAUDE_TSP_RECORD } : {}) };
  const start = (session: Session): InstanceType<typeof App> => new App({ session, launch, cwd: process.cwd() });
  let app: InstanceType<typeof App>;
  if (inTern()) {
    // Tern's own pane: open the surface and draw at once, and let the `hello`
    // reply catch up, instead of holding the first frame for a round trip.
    const session = new Session(process.stdin, process.stdout, options);
    app = start(session);
    app.render();
    if (!(await session.handshake())) return runStock(args);
    app.render();
  } else {
    // Anywhere else nothing is drawn until Tern answers; a terminal that is
    // not Tern answers the DA1 sent with `hello` and the wait ends there.
    const session = await connect(options);
    if (!session) return runStock(args);
    app = start(session);
  }
  try {
    return await app.run();
  } finally {
    await app.quit();
  }
}
