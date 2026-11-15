/**
 * `/install-github-app`: Claude GitHub Actions for a repository, set up with
 * the GitHub CLI as Claude Code's own wizard does it. A branch gets the
 * workflow files, the repository gets the secret they read, and the pull
 * request page is opened for the user to create it.
 */
import { execFile } from "node:child_process";

export type WorkflowKind = "claude" | "claude-review";

/** The workflow files Claude Code installs, as it ships them. */
const TEMPLATES: Record<WorkflowKind, { path: string; message: string; text: string }> = {
  claude: { path: ".github/workflows/claude.yml", message: "Claude PR Assistant workflow", text: "name: Claude Code\n\non:\n  issue_comment:\n    types: [created]\n  pull_request_review_comment:\n    types: [created]\n  issues:\n    types: [opened, assigned]\n  pull_request_review:\n    types: [submitted]\n\njobs:\n  claude:\n    if: |\n      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||\n      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||\n      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@claude')) ||\n      (github.event_name == 'issues' && (contains(github.event.issue.body, '@claude') || contains(github.event.issue.title, '@claude')))\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      pull-requests: read\n      issues: read\n      id-token: write\n      actions: read # Required for Claude to read CI results on PRs\n    steps:\n      - name: Checkout repository\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 1\n\n      - name: Run Claude Code\n        id: claude\n        uses: anthropics/claude-code-action@v1\n        with:\n          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}\n\n          # This is an optional setting that allows Claude to read CI results on PRs\n          additional_permissions: |\n            actions: read\n\n          # Optional: Give a custom prompt to Claude. If this is not specified, Claude will perform the instructions specified in the comment that tagged it.\n          # prompt: 'Update the pull request description to include a summary of changes.'\n\n          # Optional: Add claude_args to customize behavior and configuration\n          # See https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md\n          # or https://code.claude.com/docs/en/cli-reference for available options\n          # claude_args: '--allowed-tools Bash(gh pr *)'\n\n" },
  "claude-review": { path: ".github/workflows/claude-code-review.yml", message: "Claude Code Review workflow", text: "name: Claude Code Review\n\non:\n  pull_request:\n    types: [opened, synchronize, ready_for_review, reopened]\n    # Optional: Only run on specific file changes\n    # paths:\n    #   - \"src/**/*.ts\"\n    #   - \"src/**/*.tsx\"\n    #   - \"src/**/*.js\"\n    #   - \"src/**/*.jsx\"\n\njobs:\n  claude-review:\n    # Optional: Filter by PR author\n    # if: |\n    #   github.event.pull_request.user.login == 'external-contributor' ||\n    #   github.event.pull_request.user.login == 'new-developer' ||\n    #   github.event.pull_request.author_association == 'FIRST_TIME_CONTRIBUTOR'\n\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      pull-requests: read\n      issues: read\n      id-token: write\n\n    steps:\n      - name: Checkout repository\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 1\n\n      - name: Run Claude Code Review\n        id: claude-review\n        uses: anthropics/claude-code-action@v1\n        with:\n          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}\n          plugin_marketplaces: 'https://github.com/anthropics/claude-code.git'\n          plugins: 'code-review@claude-code-plugins'\n          prompt: '/code-review:code-review --comment ${{ github.repository }}/pull/${{ github.event.pull_request.number }}'\n          claude_args: '--allowedTools \"mcp__github_inline_comment__create_inline_comment\"'\n          # See https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md\n          # or https://code.claude.com/docs/en/cli-reference for available options\n\n" },
};

export const PR_TITLE = "Add Claude Code GitHub Workflow";
export const PR_BODY = "## \ud83e\udd16 Installing Claude Code GitHub App\n\nThis PR adds a GitHub Actions workflow that enables Claude Code integration in our repository.\n\n### What is Claude Code?\n\n[Claude Code](https://claude.com/claude-code) is an AI coding agent that can help with:\n- Bug fixes and improvements  \n- Documentation updates\n- Implementing new features\n- Code reviews and suggestions\n- Writing tests\n- And more!\n\n### How it works\n\nOnce this PR is merged, we'll be able to interact with Claude by mentioning @claude in a pull request or issue comment.\nOnce the workflow is triggered, Claude will analyze the comment and surrounding context, and execute on the request in a GitHub action.\n\n### Important Notes\n\n- **This workflow won't take effect until this PR is merged**\n- **@claude mentions won't work until after the merge is complete**\n- The workflow runs automatically whenever Claude is mentioned in PR or issue comments\n- Claude gets access to the entire PR or issue context including files, diffs, and previous comments\n\n### Security\n\n- Our Anthropic API key is securely stored as a GitHub Actions secret\n- Only users with write access to the repository can trigger the workflow\n- All Claude runs are stored in the GitHub Actions run history\n- Claude's default tools are limited to reading/writing files and interacting with our repo by creating comments, branches, and commits.\n- We can add more allowed tools by adding them to the workflow file like:\n\n\\";
export const APP_URL = "https://github.com/apps/claude";
export const MANUAL_URL = "https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md";
export const API_KEY_SECRET = "ANTHROPIC_API_KEY";
export const OAUTH_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";

/** Where a workflow file goes and what its commit says. */
export const workflowFile = (kind: WorkflowKind): { path: string; message: string } => ({ path: TEMPLATES[kind].path, message: TEMPLATES[kind].message });

/** A workflow's text, reading the given secret: an API key under any name, or a subscription token. */
export function workflowText(kind: WorkflowKind, secret: string): string {
  const text = TEMPLATES[kind].text;
  const key = "anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}";
  if (secret === OAUTH_SECRET) return text.replace(key, "claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
  if (secret !== API_KEY_SECRET) return text.replace(key, `anthropic_api_key: \${{ secrets.${secret} }}`);
  return text;
}

/** `owner/repo` from what a user types: that form, or a GitHub URL. */
export function parseRepo(input: string): string | null {
  const text = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const url = text.match(/^(?:https?:\/\/|git@)(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+)$/);
  if (url) return `${url[1]}/${url[2]}`;
  return /^[\w.-]+\/[\w.-]+$/.test(text) ? text : null;
}

/** Which secret a pasted credential belongs in. */
export const secretFor = (value: string): string => (value.trim().startsWith("sk-ant-oat") ? OAUTH_SECRET : API_KEY_SECRET);

/** The page that opens a pull request from the branch. */
export function compareUrl(repo: string, base: string, branch: string): string {
  return `https://github.com/${repo}/compare/${base}...${branch}?quick_pull=1&title=${encodeURIComponent(PR_TITLE)}&body=${encodeURIComponent(PR_BODY)}`;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the GitHub CLI; `code` is -1 when it is not installed. */
export function gh(args: string[], cwd: string, input?: string): Promise<GhResult> {
  return new Promise(resolve => {
    const child = execFile(process.env.CLAUDE_TSP_GH || "gh", args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException).code === "ENOENT" ? -1 : typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

export interface Preflight {
  /** Why setup cannot go on, with what to do about it. */
  problem?: string;
  /** The repository of the folder, when it has a GitHub remote. */
  repo?: string;
  warnings: string[];
}

/** Whether the GitHub CLI is there and signed in with the scopes the setup needs. */
export async function preflight(cwd: string): Promise<Preflight> {
  const version = await gh(["--version"], cwd);
  if (version.code !== 0) return { problem: "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`.", warnings: [] };
  const auth = await gh(["auth", "status"], cwd);
  const status = `${auth.stdout}\n${auth.stderr}`;
  if (auth.code !== 0) return { problem: "The GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.", warnings: [] };
  const warnings: string[] = [];
  const scopes = status.match(/Token scopes:(.*)/)?.[1] ?? "";
  if (scopes && !/\brepo\b/.test(scopes)) warnings.push("The GitHub CLI token lacks the `repo` scope: run `gh auth refresh -h github.com -s repo,workflow`.");
  if (scopes && !/\bworkflow\b/.test(scopes)) warnings.push("The GitHub CLI token lacks the `workflow` scope, which writing workflow files needs: run `gh auth refresh -h github.com -s workflow`.");
  const view = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd);
  const repo = view.code === 0 ? parseRepo(view.stdout) : null;
  return { ...(repo ? { repo } : {}), warnings };
}

/** What the repository already has: admin rights, a Claude workflow, the secrets. */
export async function inspect(repo: string, cwd: string): Promise<{ problem?: string; warnings: string[]; hasWorkflow: boolean; secrets: string[] }> {
  const warnings: string[] = [];
  const info = await gh(["api", `repos/${repo}`, "--jq", ".permissions.admin"], cwd);
  if (info.code !== 0) return { problem: `Could not read ${repo}: ${info.stderr.trim().split("\n")[0] || "not found, or no access"}`, warnings, hasWorkflow: false, secrets: [] };
  if (info.stdout.trim() !== "true") warnings.push(`You are not an admin of ${repo}: installing the app and setting secrets need admin rights.`);
  const existing = await gh(["api", `repos/${repo}/contents/${TEMPLATES.claude.path}`, "--jq", ".sha"], cwd);
  const listed = await gh(["secret", "list", "--app", "actions", "--repo", repo], cwd);
  const secrets = listed.code === 0 ? listed.stdout.split("\n").map(line => line.split(/\s+/)[0] ?? "").filter(Boolean) : [];
  return { warnings, hasWorkflow: existing.code === 0, secrets };
}

export interface SetupOptions {
  repo: string;
  workflows: WorkflowKind[];
  secret: string;
  /** The credential to save, or undefined to use the secret the repository already has. */
  value?: string;
  cwd: string;
  /** Called as each step starts. */
  step(text: string): void;
  /** For tests: stands in for the clock in the branch name. */
  now?: number;
}

/** Runs the setup. Returns the pull request page, or throws with what failed and what was already done. */
export async function setup(options: SetupOptions): Promise<{ url: string | null; branch: string | null; done: string[] }> {
  const { repo, cwd } = options;
  const done: string[] = [];
  const fail = (what: string, result: GhResult, hint = ""): never => {
    throw Object.assign(new Error(`${what}: ${result.stderr.trim().split("\n")[0] || `gh exited with ${result.code}`}${hint}`), { done });
  };
  let branch: string | null = null;
  let base = "";
  if (options.workflows.length) {
    options.step("Getting repository information");
    const head = await gh(["api", `repos/${repo}`, "--jq", ".default_branch"], cwd);
    if (head.code !== 0) fail("Failed to get the default branch", head);
    base = head.stdout.trim();
    const sha = await gh(["api", `repos/${repo}/git/ref/heads/${base}`, "--jq", ".object.sha"], cwd);
    if (sha.code !== 0) fail("Failed to get the branch's commit", sha);
    options.step("Creating branch");
    branch = `add-claude-github-actions-${options.now ?? Date.now()}`;
    const created = await gh(["api", "--method", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha.stdout.trim()}`], cwd);
    if (created.code !== 0) fail("Failed to create the branch", created);
    done.push(`created branch ${branch}`);
    for (const kind of options.workflows) {
      const file = TEMPLATES[kind];
      options.step(`Creating ${file.path}`);
      const existing = await gh(["api", `repos/${repo}/contents/${file.path}?ref=${branch}`, "--jq", ".sha"], cwd);
      const args = ["api", "--method", "PUT", `repos/${repo}/contents/${file.path}`, "-f", `message=${file.message}`, "-f", `content=${Buffer.from(workflowText(kind, options.secret), "utf8").toString("base64")}`, "-f", `branch=${branch}`];
      if (existing.code === 0 && existing.stdout.trim()) args.push("-f", `sha=${existing.stdout.trim()}`);
      const written = await gh(args, cwd);
      if (written.code !== 0) fail(`Failed to write ${file.path}`, written, /workflow/.test(written.stderr) ? "\nRun: gh auth refresh -h github.com -s workflow" : "");
      done.push(`wrote ${file.path} to it`);
    }
  }
  if (options.value !== undefined) {
    options.step(`Setting up the ${options.secret} secret`);
    // The value goes in on stdin, so it never shows in a process list.
    const saved = await gh(["secret", "set", options.secret, "--repo", repo], cwd, options.value);
    if (saved.code !== 0) fail("Failed to set the secret", saved, "\n· Permission denied → run: gh auth refresh -h github.com -s repo\n· Not authorized → you need admin access to the repository");
    done.push(`saved the ${options.secret} secret`);
  }
  return { url: branch ? compareUrl(repo, base, branch) : null, branch, done };
}

/** What a terminal program drew, without its escape sequences. */
export function plainText(output: string): string {
  // eslint-disable-next-line no-control-regex
  return output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");
}

/** A subscription token in what `claude setup-token` drew, once its escape sequences are out. */
export function tokenIn(output: string): string | null {
  return plainText(output).match(/sk-ant-oat[\w-]{20,}/)?.[0] ?? null;
}
