#!/usr/bin/env bash
# End-to-end verification in headless Tern: drives real sessions and checks the
# live document. Every section is a session of its own, with its own Tern, its
# own folders and its own state, so sections run side by side and any of them
# can be run alone.
#   tools/verify.sh                every section, four at a time
#   tools/verify.sh update stock   only these sections
#   tools/verify.sh -j 1           one at a time
#   tools/verify.sh --list         the sections and what each covers
# Prints each section's PASS/FAIL lines, in a fixed order, and a count at the
# end; progress goes to stderr. Exits 1 when a check failed or a section died.
# Needs: tern, claude-pi installed and signed in, the local model reachable.
set -u
cd "$(dirname "$0")/.."
D=tools; SELF="$PWD/tools/verify.sh"
# In report order.
SECTIONS="local edits stock signin retry widgets native hosted plugins update"
# In starting order: the longest first, so the run is as long as the longest section and no longer.
LONGEST_FIRST="local edits native plugins hosted stock signin update widgets retry"
about() { case "$1" in
  local) echo "claude-pi-tsp on the local model: approvals, background commands, a question, the agents pane, !commands, /btw, effort, the command dialogs, /compact" ;;
  edits) echo "claude-pi-tsp on the local model: edits and rewind, the tree, queued messages, /resume, /trace, stopping a turn, /tui, the themes" ;;
  stock) echo "claude-tsp, stock binary and prompt, Haiku: effort and Ultracode, plan mode, suggestions, an MCP form, a failing hook" ;;
  signin) echo "sign-in, /ide and the settings that restart Claude Code, in a scratch config" ;;
  retry) echo "an overloaded API: the retry countdown and the recovery" ;;
  widgets) echo "a plugin's band, pane and log line" ;;
  native) echo "commands that used to open Claude Code's own UI: sandbox, stats, GitHub Actions setup, /diff, /cd, the settings screen" ;;
  hosted) echo "stock Haiku with non-essential traffic on: permission rules, /subtask, /background, /feedback, /remote-control" ;;
  plugins) echo "plugins from a marketplace and the provider setups, in a scratch config" ;;
  update) echo "updates of claude-tsp, /doctor's check, the folded composer, --check-compat" ;;
  *) return 1 ;;
esac; }
pass=0; fail=0; nshot=0
ctl() { "$D/serve.sh" ctl $S "$@"; }
key() { for k in "$@"; do ctl key "$k" >/dev/null; done; }
# Moves the settings screen's focus down to the row whose label starts with NAME (the document is read a moment after each key).
to_row() { local n=0; while [ $n -lt 30 ]; do ctl key Down >/dev/null; sleep 0.7; case "$(ctl tree '.pf-row.focus .pf-lbl' 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("nodes") or [{}])[0].get("text",""))' 2>/dev/null)" in "$1"*) return 0 ;; esac; n=$((n+1)); done; return 1; }
# Text and the Enter after it travel separately, and on a busy machine Enter can come first and find nothing to
# send: wait until the composer shows the text. (Never press Enter a second time: a panel may have opened by then.)
typed() { local n=0; while [ $n -lt 12 ] && [ "$(count '.sf-editor.empty')" -gt 0 ]; do sleep 0.2; n=$((n+1)); done; }
say() { ctl key ctrl+u >/dev/null; ctl type "\"$1\"" >/dev/null; typed; ctl key Enter >/dev/null; sleep "${2:-6}"; }
# Presses choice N of the approval or question panel once it is there; a missing panel is a failure of its own.
approve() { if until_ "$APPROVAL" "${2:-45}"; then sleep 1; ctl key "$1" >/dev/null; else fail=$((fail+1)); nshot=$((nshot+1)); ctl shot "verify-$NAME-fail-$nshot" >/dev/null; echo "FAIL  (no approval panel appeared; shot verify-$NAME-fail-$nshot)"; tell "FAIL  no approval panel appeared"; fi; }
count() { ctl tree "$1" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("count",0))
except Exception: print(0)'; }
text() { ctl tree "$1" 2>/dev/null | python3 -c 'import json,sys
try: print(" | ".join(str(n.get("text","")) for n in json.load(sys.stdin).get("nodes",[])))
except Exception: print("")'; }
title() { ctl tree "$1" 2>/dev/null | python3 -c 'import json,sys
try: print(" | ".join(str(n.get("title","")) for n in json.load(sys.stdin).get("nodes",[])))
except Exception: print("")'; }
titled() { case "$(title "$2")" in *"$3"*) ok "$1" 1 ;; *) ok "$1" 0 "wanted '$3' in title: $(title "$2" | cut -c1-120)" ;; esac; }
color() { ctl dump "$1" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["elements"][0]["color"])
except Exception: print("")'; }
# Waits until a node matching SEL has TEXT in it, polling fast (a retry wait can be short).
until_text() { local n=0; while [ $n -lt "${3:-60}" ]; do case "$(text "$1")" in *"$2"*) return 0 ;; esac; sleep 0.3; n=$((n+1)); done; return 1; }
lacks() { case "$(text "$2")" in *"$3"*) ok "$1" 0 "found '$3'" ;; *) ok "$1" 1 ;; esac; }
ok() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); nshot=$((nshot+1)); ctl shot "verify-$NAME-fail-$nshot" >/dev/null; echo "FAIL  $1   ${3:-}  (shot verify-$NAME-fail-$nshot)"; tell "FAIL  $1"; fi; }
# Clicks the button whose text starts with LABEL.
press() { local at; at=$(ctl tree 'button' 2>/dev/null | python3 -c 'import json,sys
want=sys.argv[1]
for n in json.load(sys.stdin).get("nodes",[]):
    if str(n.get("text","")).startswith(want):
        r=n["rect"]; print(int(r[0]+r[2]/2), int(r[1]+r[3]/2)); break' "$1"); [ -n "$at" ] && ctl click $at >/dev/null; }
has() { [ "$(count "$2")" -gt 0 ] && ok "$1" 1 || ok "$1" 0 "nothing matches $2"; }
hasnt() { [ "$(count "$2")" -eq 0 ] && ok "$1" 1 || ok "$1" 0 "$2 still there"; }
says() { case "$(text "$2")" in *"$3"*) ok "$1" 1 ;; *) ok "$1" 0 "wanted '$3' in: …$(text "$2" | tail -c 200)" ;; esac; }
# Waits until SEL matches (or stops matching with `gone`), up to SECS.
until_() { local n=0 c; while [ $n -lt "${2:-40}" ]; do c=$(count "$1"); if [ "${3:-}" = gone ]; then [ "$c" -eq 0 ] && return 0; else [ "$c" -gt 0 ] && return 0; fi; sleep 1; n=$((n+1)); done; return 1; }
# Waits for the turn to end, approving anything it asks on the way (a subagent's command, say).
idle() { sleep 2; local n=0; while [ $n -lt "${1:-60}" ]; do
    [ "$(count '[data-role="omp.working"]')" -eq 0 ] && break
    [ "$(count '[data-role="omp.approval.title"]')" -gt 0 ] && ctl key ctrl+Enter >/dev/null
    sleep 1; n=$((n+1)); done; sleep 1; }
start() { "$D/serve.sh" stop $S; rm -f $TRACE; "$D/serve.sh" start $S $DEMO "TMPDIR=$W/tmp CLAUDE_TSP_HOME=$TSPHOME CLAUDE_TSP_TRACE=$TRACE $1"; until_ '[data-role="omp.composer.model"]' 30; sleep 3; }
seen() { local n=0; while [ $n -lt "${3:-20}" ]; do ctl tree 2>/dev/null | grep -qF "$2" && { ok "$1" 1; return; }; sleep 1; n=$((n+1)); done; ok "$1" 0 "never saw '$2'"; }
cmd() { ctl key ctrl+u >/dev/null; ctl type "\"$1\"" >/dev/null; typed; ctl key Enter >/dev/null; sleep "${2:-2}"; }
# The newest Claude Code process the surface runs with config directory DIR (other sessions are running too).
child() { local p; for p in $(pgrep -f 'input-format stream-json'); do tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qxF "CLAUDE_CONFIG_DIR=$1" && echo "$p"; done | tail -1; }
tell() { [ -n "${VERIFY_TELL:-}" ] && echo "[$NAME] $1" >&3; return 0; }
OPEN='.sf-region.sf-layer .sf-picker, .sf-region.sf-layer .sf-overlay, .sf-region.sf-layer .pf'
USER='[data-role="omp.user"]'; PICK='.sf-picker, [data-kind="picker"], .pk'; APPROVAL='[data-role="omp.editor.ask.approval"]'
# A session the user starts is not inside another Claude Code session; the settings editor refuses one that is.
OUTSIDE="env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_PID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_EXECPATH"

s_local() {
start "claude-pi-tsp --model claude-haiku-4-5 --permission-mode default"
has "starts: welcome, model chip, mode pill" '[data-role="omp.welcome"]'
says "the local model is named" '[data-role="omp.composer.model"]' "DeepSeek"
has "mode pill" '[data-role="claude.composer.mode"]'
hasnt "at rest, the tab does not show the session as working" '.tt.working'

say "Use Write to create notes.txt containing hello. Reply done." 3; until_ "$APPROVAL" 40
has "a write asks for approval" "$APPROVAL"
hasnt "waiting on an approval is not working either" '.tt.working'
says "the approval offers accept-all-edits" '[data-role="omp.approval.choices"]' "accept all edits"
key 2; idle 40
[ "$(cat $DEMO/notes.txt 2>/dev/null)" = hello ] && ok "the file was written after approval" 1 || ok "the file was written after approval" 0
says "the mode became Accept edits" '[data-role="claude.composer.mode"]' "Accept edits"
has "a Write card" '[data-role="omp.tool.write"]'

key shift+Tab; sleep 2; says "Shift+Tab steps the mode (Plan)" '[data-role="claude.composer.mode"]' "Plan"
key shift+Tab; sleep 2; says "Shift+Tab steps over auto, which this model lacks (Ask)" '[data-role="claude.composer.mode"]' "Ask"

say "Call the Bash tool once, foreground, with exactly: for i in \$(seq 1 40); do echo tock \$i; sleep 3; done" 3; approve 1; sleep 6
key ctrl+b; until_ '[data-role="omp.hud.jobs"]' 20
has "Ctrl+B backgrounds it: the pill shows" '[data-role="omp.hud.jobs"]'
idle 40; say "/tasks" 2
says "/tasks lists the background command" '.sf-region.sf-layer' "tock"
key ctrl+x; sleep 4; key Escape
hasnt "Stop ends the background command" '[data-role="omp.hud.jobs"]'
# The stop is told to the model as a turn of its own: let that end before the next prompt.
idle 40

say "Call AskUserQuestion with one question: Which color? header Color, options Red and Blue with short descriptions." 3; until_ '[data-role="omp.approval.choices"]' 40
says "a question panel" "$APPROVAL" "Which color?"
approve 2 5; idle 40
says "the answer is recorded on the card" '[data-role="omp.tool.askuserquestion"]' "Blue"

say "Launch one Agent (description: inspect calc) with prompt: Read $DEMO/calc.py and report what it would print. Reply done." 5
idle 90
say "Create two tasks with TaskCreate named alpha and beta, then mark alpha in_progress with TaskUpdate. Reply done." 5
idle 60
has "a subagent card" '[data-role="omp.task.agent"]'
has "the task list above the composer" '[data-role="omp.hud.todo"]'
says "the composer counts the session's subagents" '[data-role="claude.composer.agents"]' "1 agent"
key alt+a; sleep 2
has "Alt+A opens the agents pane" '[data-role="claude.agents"]'
has "one agent in the session opens on its conversation" '[data-role="claude.agents.nav"]'
says "the pane names what the agent was asked" '[data-role="claude.agents.agent"]' "inspect calc"
press "Full view"; sleep 2
has "Full view opens the conversation over the whole pane" '[data-role="omp.overlay.agent"]'
hasnt "the pane steps aside while Full view is open" '[data-role="claude.agents"]'
key Escape; sleep 1
press "Agents"; sleep 2
has "back from one agent is the overview, a tile for each" '[data-role="claude.agents.tile"]'
key alt+a; sleep 1
hasnt "Alt+A hides the pane" '[data-role="claude.agents"]'
say "/agents" 2; key Enter; sleep 3
has "an agent chosen in /agents opens in the pane" '[data-role="claude.agents.nav"]'
key alt+a; sleep 1

say "!echo shellword" 3
has "a !command row" '[data-role="omp.bash"]'
say "What single word did the shell command I just ran print? Reply with that word only." 2; idle 40
# The local model sometimes answers past the question: ask once more before judging.
case "$(text '[data-role="omp.assistant"]')" in *shellword*) ;; *) say "Look at the output of the echo command I ran with ! above and reply with the one word it printed." 2; idle 40 ;; esac
says "the shell output reached the model" '[data-role="omp.assistant"]' "shellword"
say "Remember the code word PAPAYA. Reply ok." 2; idle 40

say "!for i in 1 2 3; do echo line \$i; done; echo end" 4
say "/inspect" 3; has "/inspect opens the command in the inspector" '[data-role="omp.overlay.shell"]'
lacks "a !command is traced, so its run can be replayed" '[data-role="omp.overlay.shell"]' "was not traced"
key space; sleep 1; key Escape; sleep 1
say "/btw What is the code word? One word." 2; until_ '[data-role="omp.overlay.btw"]' 40
says "/btw answers from the conversation" '[data-role="omp.overlay.btw"]' "PAPAYA"
key Escape
key alt+t; sleep 2; titled "Alt+T turns thinking off" '[data-role="omp.composer.model.effort"]' "Thinking is off"
key alt+t; sleep 2; titled "Alt+T turns it back on" '[data-role="omp.composer.model.effort"]' "Effort:"
say "/effort" 2
has "/effort opens the effort dialog" '[data-role="omp.overlay.effort"]'
says "a local model has its own three levels on the track" '[data-role="claude.effort.label"]' "low | high | max"
hasnt "and no Ultracode switch" '[data-role="claude.effort.ultracode"]'
key Escape; sleep 1
hasnt "Esc closes the dialog and changes nothing" '[data-role="omp.overlay.effort"]'

# The dialogs no other check opens (/agents, /tree, /resume, /settings, /doctor, /hooks, /plugin and /permissions are used further on).
for cmd in model mode context usage status mcp todos skills output-style fork copy outline help memory; do
  ctl key ctrl+u >/dev/null; ctl type "\"/$cmd\"" >/dev/null; key Enter; until_ "$OPEN" 12
  n=$(count "$OPEN")
  key Escape; sleep 1; m=$(count "$OPEN")
  [ "$n" -gt 0 ] && [ "$m" -eq 0 ] && ok "/$cmd opens and closes" 1 || ok "/$cmd opens and closes" 0 "open=$n closed=$m"
done

say "/statusline" 3; until_ '[data-role="claude.status.line"]' 20
says "Claude Code's own status line is drawn when switched on" '[data-role="claude.status.line"]' "DeepSeek"
say "/statusline" 3; hasnt "and leaves when switched off" '[data-role="claude.status.line"]'
say "/plugin" 3; says "/plugin lists the plugin given on the command line" '.sf-region.sf-layer .sf-picker' "pi-harness"; key Escape; sleep 1
say "/add-dir $OTHER" 3; until_ '[data-role="omp.composer.model"]' 30; sleep 3
say "/permissions" 5; says "/add-dir adds the folder" '.sf-region.sf-layer' "$NAME/other"; key Escape
say "/rename verify run" 3; says "/rename names the session" '[data-role="omp.status.session"]' "verify run"
say "/export $W/export.md" 2; [ -s $W/export.md ] && ok "/export writes the conversation" 1 || ok "/export writes the conversation" 0
say "/attach $PWD/../pi-tsp-public/docs/pi-tsp-settings.png" 2
has "an attached image chip" '[data-role="omp.composer.chip"]'
say "Which of these words can you read in this screenshot: Session, Banana, Display? Answer with the ones you see." 2; idle 60
says "the model read the image" '[data-role="omp.assistant"]' "Session"

say "/compact" 3; until_ '[data-role="omp.compaction"]' 60
has "/compact leaves a compaction row" '[data-role="omp.compaction"]'
idle 30; say "What was the code word? One word." 2; idle 40
says "the code word survives compaction" '[data-role="omp.assistant"]' "PAPAYA"
}

s_edits() {
start "claude-pi-tsp --model claude-haiku-4-5 --permission-mode default"
# A first conversation, for /clear to empty and /resume to come back to.
say "Reply with the single word ready." 2; idle 40
say "/clear" 5; hasnt "/clear empties the transcript" "$USER"
say "Use Write to create f1.txt containing the single word one. Reply ok." 3; approve 2 30; idle 40
say "Use Edit to change one to two in f1.txt. Reply ok." 3; idle 40
[ "$(cat $DEMO/f1.txt 2>/dev/null)" = two ] && ok "an edit changed the file" 1 || ok "an edit changed the file" 0 "$(cat $DEMO/f1.txt 2>&1)"
has "an Edit card with a diff" '[data-role="omp.tool.edit"]'
key Escape Escape; sleep 4; key Enter; until_ '[data-role="omp.composer.model"]' 30; sleep 4
[ "$(cat $DEMO/f1.txt 2>/dev/null)" = one ] && ok "rewind restores the file" 1 || ok "rewind restores the file" 0 "$(cat $DEMO/f1.txt 2>&1)"
[ "$(count "$USER")" = 1 ] && ok "rewind keeps only the earlier message" 1 || ok "rewind keeps only the earlier message" 0 "users=$(count "$USER")"
key Enter; idle 40
[ "$(cat $DEMO/f1.txt 2>/dev/null)" = two ] && ok "the returned message can be sent again" 1 || ok "the returned message can be sent again" 0
say "/tree" 3; says "/tree shows the abandoned branch" '.sf-region.sf-layer' "other branch"
key Up Up; sleep 1; key ctrl+s; until_ '[data-role="omp.branch"]' 120
has "a move in the tree can carry a summary of the branch left" '[data-role="omp.branch"]'
say "/settings" 3; to_row "Messages while"; key Right; sleep 1; key Escape; sleep 1
say "Call the Bash tool once, foreground, with exactly: for i in 1 2 3 4 5 6; do echo t \$i; sleep 3; done" 3; approve 1; sleep 4
ctl type '"and then say LATER"' >/dev/null; key Enter; sleep 2
titled "Settings: Enter during a turn can queue for after it" '[data-role="omp.queue.item"]' "Sent after this turn"
# The queued message starts a turn of its own a moment after the first ends: wait for its answer, not for a quiet moment.
idle 60; until_text '[data-role="omp.assistant"]' "LATER" 300; idle 60
says "the queued message is sent when the turn ends" '[data-role="omp.assistant"]' "LATER"
say "/resume" 3; key Down Enter; until_ '[data-role="omp.composer.model"]' 30; sleep 5
has "/resume redraws another session" '[data-role="omp.compaction"], [data-role="omp.user"]'
say "/trace" 3
say "Call the Bash tool once with exactly: echo alpha; echo beta" 3; approve 1; idle 40
say "/inspect" 3
lacks "with /trace on, Claude's Bash call is traced too" '[data-role="omp.overlay.shell"]' "was not traced"
key right right; sleep 1; key Escape; sleep 1
says "the traced call's output is untouched" '[data-role="omp.tool.bash"]' "alpha"
say "/trace" 3
say "Call the Bash tool once, foreground, with exactly: for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick \$i; sleep 3; done" 3; approve 1; sleep 6
has "a command is running" '[data-role="omp.working"]'
has "and the tab shows the session working" '.tt.working'
key Escape; sleep 5
hasnt "Esc stops the turn" '[data-role="omp.working"]'
hasnt "and the tab comes to rest" '.tt.working'
hasnt "a stopped turn leaves no error card" '[data-role="omp.error"]'

say "/tui" 8; ctl type '"/exit"' >/dev/null; key Enter; sleep 3; key Enter; until_ '[data-role="omp.composer.model"]' 40; sleep 3
has "the pane comes back from Claude Code's own UI" '[data-role="omp.composer.model"]'
say "/mode edits" 3
LIGHT="$(color '[data-role="claude.composer.mode"] .sf-text')"
[ "$LIGHT" = "rgb(194, 96, 63)" ] && ok "light theme: the accent is Claude's clay" 1 || ok "light theme: the accent is Claude's clay" 0 "got $LIGHT"
ctl appearance dark >/dev/null; sleep 2; ctl shot verify-dark >/dev/null
DARK="$(color '[data-role="claude.composer.mode"] .sf-text')"
[ "$DARK" = "rgb(224, 138, 107)" ] && ok "dark theme: the clay shifts for a dark page" 1 || ok "dark theme: the clay shifts for a dark page" 0 "got $DARK"
INK="$(color '[data-role="omp.assistant"]')"; case "$INK" in "rgb(2"*|"rgb(19"*|"rgb(18"*|"rgb(17"*) ok "dark theme: text is light on dark" 1 ;; *) ok "dark theme: text is light on dark" 0 "got $INK" ;; esac
say "/theme" 3
OWN="$(color '[data-role="claude.composer.mode"] .sf-text')"
[ -n "$OWN" ] && [ "$OWN" != "$DARK" ] && ok "/theme hands the accent back to the Tern theme" 1 || ok "/theme hands the accent back to the Tern theme" 0 "got $OWN"
say "/theme" 3; ctl appearance light >/dev/null; sleep 1
}

s_stock() {
cat > $W/mcp.mjs <<'EOF'
import { createInterface } from "node:readline";
const send = m => process.stdout.write(JSON.stringify(m) + "\n");
let pending = null;
createInterface({ input: process.stdin }).on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "asker", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ask_name", description: "Asks the user for their project name and returns it.", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") { pending = m.id; send({ jsonrpc: "2.0", id: "e1", method: "elicitation/create", params: { message: "What is the project called?", requestedSchema: { type: "object", properties: { project: { type: "string", title: "Project name" } }, required: ["project"] } } }); }
  else if (m.id === "e1") send({ jsonrpc: "2.0", id: pending, result: { content: [{ type: "text", text: `the project is ${m.result?.content?.project}` }] } });
  else if (m.id !== undefined && m.method) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
EOF
echo "{\"mcpServers\":{\"asker\":{\"command\":\"node\",\"args\":[\"$W/mcp.mjs\"]}}}" > $W/mcp.json
cat > $W/settings.json <<'EOF'
{"env":{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":""},"hooks":{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"echo style check failed >&2; exit 1"}]}]}}
EOF
start "CLAUDE_CONFIG_DIR=$HOME/.claude-pi claude-tsp --model haiku --permission-mode plan --mcp-config $W/mcp.json --settings $W/settings.json"
says "the stock profile is named Claude Code" '[data-role="omp.welcome"]' "Claude Code"
says "a Claude model is named" '[data-role="omp.composer.model"]' "Haiku"
say "/effort" 2
says "a Claude model has Claude Code's five levels" '[data-role="claude.effort.label"]' "low | medium | high | xhigh | max"
key Tab; sleep 1; key s; sleep 3
has "Tab turns Ultracode on in the dialog and S applies it to the session" '[data-role="claude.composer.ultracode"]'
say "/effort low" 3
has "Ultracode stays on when the level changes" '[data-role="claude.composer.ultracode"]'
say "/add-dir $OTHER" 3; until_ '[data-role="omp.composer.model"]' 30; sleep 5
has "Ultracode is put back when the surface restarts Claude Code's process" '[data-role="claude.composer.ultracode"]'
say "/effort ultracode off" 3
hasnt "/effort ultracode off turns it off" '[data-role="claude.composer.ultracode"]'
say "Plan a one-line change: add a comment at the top of calc.py. Keep the plan to three lines and present it with ExitPlanMode right away, without reading files." 3; until_ "$APPROVAL" 60
says "plan mode ends in a plan approval" "$APPROVAL" "plan"
says "the plan approval offers accept-edits" '[data-role="omp.approval.choices"]' "accept edits automatically"
approve 2 5; idle 60
says "approving the plan switches to Accept edits" '[data-role="claude.composer.mode"]' "Accept edits"
head -1 $DEMO/calc.py | grep -q '^#' && ok "the planned edit was made" 1 || ok "the planned edit was made" 0 "$(head -1 $DEMO/calc.py)"
# Claude Code offers a suggestion from the second turn on.
for q in "What does calc.py print when it is run? Answer in one line." "And what would it print if add returned a - b? One line." "Name one more function this file could use. One line." "Would you add type hints to add? One line." "Suggest a name for a subtract function. One line."; do
  say "$q" 3; idle 60
  until_text '.sf-editor' "Tab" 60 && break
done
says "a prompt suggestion is offered" '.sf-editor' "Tab"
key Tab; sleep 1; hasnt "Tab takes the suggestion into the draft" '.sf-editor.empty'
key ctrl+c; sleep 1
say "Call the ask_name tool of the asker MCP server and tell me what it returned." 3; approve 1; until_ '[data-role="omp.overlay.hook-input"]' 30
says "an MCP server's form opens" '[data-role="omp.overlay.hook-input"]' "Project name"
ctl type '"tern-demo"' >/dev/null; key Enter; idle 40
says "the form's answer reached the tool" '[data-role="omp.assistant"], [data-role="omp.tool.mcp"]' "tern-demo"
say "Use the Read tool on calc.py and tell me its first line." 3; idle 40
says "a failing hook leaves a warning line" '[data-role="omp.notice.warning"]' "hook"
}

s_signin() {
mkdir -p $W/auth
start "CLAUDE_CONFIG_DIR=$W/auth BROWSER=/bin/true claude-tsp"
say "hello" 3; until_ '[data-role="omp.error"]' 30
says "without a sign-in the error card offers one" '[data-role="omp.error"]' "Sign in"
say "/login" 2; until_ '[data-role="omp.overlay.hook-input"]' 20
says "/login opens the sign-in dialog with Claude's link" '[data-role="omp.overlay.hook-input"]' "oauth/authorize"
ctl type '"not-a-real-code"' >/dev/null; key Enter; until_ '[data-role="omp.overlay.hook-input"]' 30 gone
hasnt "a wrong code is refused and the dialog closes" '[data-role="omp.overlay.hook-input"]'
[ ! -e $W/auth/.credentials.json ] && ok "a wrong code writes no credentials" 1 || ok "a wrong code writes no credentials" 0
sleep 600 & IDE=$!; mkdir -p $W/auth/ide
echo "{\"pid\":$IDE,\"ideName\":\"Test IDE\",\"workspaceFolders\":[\"$DEMO\"]}" > $W/auth/ide/59999.lock
say "/ide" 3; says "/ide lists an IDE that announces the extension" '.sf-region.sf-layer .sf-picker' "Test IDE"; key Escape; sleep 1; kill $IDE 2>/dev/null
say "/settings" 3; to_row "Auto-compact"; key Enter; sleep 3; until_ '[data-role="omp.composer.model"]' 40; sleep 4; key Escape; sleep 1
CHILD="$(child $W/auth)"
tr '\0' '\n' < "/proc/$CHILD/environ" 2>/dev/null | grep -q '^DISABLE_AUTO_COMPACT=1$' && ok "Settings: auto-compact off restarts Claude Code without it" 1 || ok "Settings: auto-compact off restarts Claude Code without it" 0 "child $CHILD"
say "/settings" 3; to_row "Auto-retry"; key Enter; sleep 3; until_ '[data-role="omp.composer.model"]' 40; sleep 4; key Escape; sleep 1
CHILD="$(child $W/auth)"
tr '\0' '\n' < "/proc/$CHILD/environ" 2>/dev/null | grep -q '^CLAUDE_CODE_MAX_RETRIES=0$' && ok "Settings: auto-retry off restarts Claude Code without retries" 1 || ok "Settings: auto-retry off restarts Claude Code without retries" 0 "child $CHILD"
}

s_retry() {
node "$D/overload-proxy.mjs" 18531 3 & PROXY=$!
start "ANTHROPIC_BASE_URL=http://127.0.0.1:18531 claude-pi-tsp --model haiku"
ctl key ctrl+u >/dev/null; ctl type '"Reply with the single word RECOVERED."' >/dev/null; ctl key Enter >/dev/null
until_text '[data-role="omp.working.label"]' "Retrying" 80 && ok "an overloaded API shows the retry countdown" 1 || ok "an overloaded API shows the retry countdown" 0
idle 90
says "the turn recovers and says so" '[data-role="omp.assistant.abort"]' "Recovered after"
says "the answer arrives after the retries" '[data-role="omp.assistant"]' "RECOVERED"
}

s_widgets() {
start "claude-pi-tsp --model claude-haiku-4-5 --plugin-dir $PWD/test/fixtures/widget-plugin"
until_ '[data-role="claude.plugin.band"]' 30
says "a plugin's band is drawn above the composer" '[data-role="claude.plugin.band"]' "count 0"
ctl key ctrl+u >/dev/null; ctl type '"/widgets"' >/dev/null; ctl key Enter >/dev/null; sleep 2
ctl type '"Add one"' >/dev/null; ctl key Enter >/dev/null
until_text '[data-role="claude.plugin.band"]' "count 1" 40 && ok "pressing a plugin's button runs it and the band redraws" 1 || ok "pressing a plugin's button runs it and the band redraws" 0
ctl key ctrl+u >/dev/null; ctl type '"/widgets"' >/dev/null; ctl key Enter >/dev/null; sleep 2
ctl type '"Open pane"' >/dev/null; ctl key Enter >/dev/null
until_ '[data-role="omp.overlay.pane"]' 15
says "a pane a plugin opens comes up with what it drew" '[data-role="omp.overlay.pane"]' "The counter stands at 1."
ctl key Escape >/dev/null; sleep 1
says "the open pane keeps a tab by the band" '[data-role="claude.plugin.band"]' "Clock"
ctl key ctrl+u >/dev/null; ctl type '"/widgets"' >/dev/null; ctl key Enter >/dev/null; sleep 2
ctl type '"Notify"' >/dev/null; ctl key Enter >/dev/null; sleep 3
ctl tree 2>/dev/null | grep -q "tsp-widget: widget logged a line" && ok "a plugin's log line lands in the transcript" 1 || ok "a plugin's log line lands in the transcript" 0
}

s_native() {
GHD=$W/gh
start "GH_FAKE_DIR=$GHD CLAUDE_TSP_GH=$PWD/test/fixtures/fake-gh/gh $OUTSIDE claude-pi-tsp --model claude-haiku-4-5 --permission-mode default"
cmd /sandbox 3
seen "/sandbox draws Claude Code's sandbox state" "Unsandboxed fallback: allowed"
ctl key Down >/dev/null; ctl key Enter >/dev/null; sleep 4
grep -q '"allowUnsandboxedCommands": false' $DEMO/.claude/settings.local.json 2>/dev/null && ok "a sandbox choice is written by Claude Code's settings editor" 1 || ok "a sandbox choice is written by Claude Code's settings editor" 0
ctl key Escape >/dev/null; sleep 1
cmd /stats 2
seen "/stats counts the stored sessions" "Longest session" 40
ctl key Escape >/dev/null; sleep 1
cmd /release-notes 2
until_ '[data-role="omp.overlay.release-notes"]' 10
n=0; rn=0; while [ $n -lt 25 ]; do ctl tree 2>/dev/null | grep -qE '"text":"[0-9]+\.[0-9]+\.[0-9]+"' && { rn=1; break; }; sleep 1; n=$((n+1)); done
ok "/release-notes shows the changelog's versions" $rn
ctl key Escape >/dev/null; sleep 1
cmd /upgrade
seen "/upgrade gives the plan page" "claude.ai/upgrade"
ctl key Escape >/dev/null; sleep 1
cmd /privacy-settings
seen "/privacy-settings gives the privacy page" "claude.ai/settings/data-privacy-controls"
ctl key Escape >/dev/null; sleep 1
ctl key ctrl+u >/dev/null; ctl type '"/remote-c"' >/dev/null; sleep 2
ctl tree 2>/dev/null | grep -qF "remote-control" && ok "claude-pi, with non-essential traffic off, leaves out /remote-control" 0 || ok "claude-pi, with non-essential traffic off, leaves out /remote-control" 1
ctl key Escape >/dev/null; ctl key ctrl+u >/dev/null; sleep 1
cmd /install-github-app 4
seen "the GitHub Actions setup finds the folder's repository" "acme/widgets"
ctl key Enter >/dev/null; sleep 3; ctl key Down >/dev/null; ctl key Enter >/dev/null; sleep 2; ctl key Enter >/dev/null; sleep 2
seen "it asks how the workflows sign in" "Paste an API key or a token"
ctl key Down >/dev/null; ctl key Enter >/dev/null; sleep 2; ctl type '"sk-ant-api03-NOTAREALKEY"' >/dev/null; ctl key Enter >/dev/null; sleep 2
seen "it says what will change before changing it" "save the ANTHROPIC_API_KEY secret"
ctl key Enter >/dev/null
seen "the setup ends with the pull request page" "compare/main...add-claude-github-actions-" 30
grep -q "contents/.github/workflows/claude-code-review.yml -f message" $GHD/calls.log 2>/dev/null && grep -q "^secret set ANTHROPIC_API_KEY --repo acme/widgets" $GHD/calls.log && [ "$(cat $GHD/secret.txt 2>/dev/null)" = "sk-ant-api03-NOTAREALKEY" ] && ok "the workflow files and the secret went through the GitHub CLI, the key on stdin" 1 || ok "the workflow files and the secret went through the GitHub CLI, the key on stdin" 0
ctl key Escape >/dev/null; sleep 1
( cd $DEMO && { [ -d .git ] || git init -q . ; } && git add calc.py 2>/dev/null; git -c user.name=t -c user.email=t@t commit -qm init 2>/dev/null; echo "# changed for the diff check" >> calc.py )
cmd /diff 4
seen "/diff shows the uncommitted changes" "changed for the diff check"
ctl key Escape >/dev/null; sleep 1
( cd $DEMO && git checkout -q calc.py 2>/dev/null )
for pair in "mobile|claude.ai/mobile" "radio|clau.de/radio" "stickers|stickermule.com/claudecode" "install-slack-app|slack.com/marketplace"; do
  cmd "/${pair%%|*}"; seen "/${pair%%|*} gives its page" "${pair##*|}"; ctl key Escape >/dev/null; sleep 1
done
cmd /rate-limit-options 3
seen "/rate-limit-options lists what can be done about a limit" "See what is using the limits"
ctl key Escape >/dev/null; sleep 1
cmd "/cd $OTHER" 4
ctl tree 2>/dev/null | grep -qF "Do you trust this folder?" && { ctl key Down >/dev/null; ctl key Enter >/dev/null; sleep 4; }
seen "/cd moves the session to another folder" "Moved to $OTHER"
cmd "!touch cd-proof.txt" 5
[ -e $OTHER/cd-proof.txt ] && ok "commands then run in the new folder" 1 || ok "commands then run in the new folder" 0
rm -f $OTHER/cd-proof.txt
cmd "/cd $DEMO" 4
ctl tree 2>/dev/null | grep -qF "Do you trust this folder?" && { ctl key Down >/dev/null; ctl key Enter >/dev/null; sleep 4; }
ctl key alt+x >/dev/null
seen "the stop-all key answers when nothing is running" "Nothing is running in the background" 8
cmd /settings 3
seen "the settings screen lists Claude Code's own switches" "Idle compaction" 8
top=$(ctl tree 2>/dev/null | python3 -c 'import sys,re;d=sys.stdin.read();a=re.search(r"\"class\":\"pf-doc[^\"]*\"[^{}]*?\"rect\":\[[^,]*,([^,]*)",d);b=re.search(r"\"class\":\"pf-head[^\"]*\"[^{}]*?\"rect\":\[[^,]*,([^,]*)",d);print(1 if a and b and float(a.group(1))>=float(b.group(1))-1 else 0)')
ok "the settings screen opens at its top, nothing under the header" "${top:-0}"
to_row "ModeWhat"
ctl key Enter >/dev/null; sleep 1
seen "a settings dropdown opens its menu" "File edits are applied without asking" 6
ctl key Down >/dev/null; ctl key Enter >/dev/null; sleep 3
says "picking in the menu changes the setting" '[data-role="claude.composer.mode"]' "Accept edits"
ctl key Escape >/dev/null; sleep 1
cmd /plugin 6
ctl key Tab >/dev/null
seen "/plugin browses the marketplaces" "claude-plugins-official" 40
ctl key Escape >/dev/null; sleep 1
cmd /hooks 1; n=0; while [ $n -lt 20 ]; do ctl tree 2>/dev/null | grep -qF "Search hooks" && break; sleep 1; n=$((n+1)); done; sleep 1; ctl key ctrl+e >/dev/null
seen "hooks are edited in a settings file chosen here" "Edit hooks in which settings?"
ctl key Escape >/dev/null; sleep 1
}

s_hosted() {
# claude-pi's settings switch non-essential traffic off, which also switches off remote control and feedback: this session has it on.
echo '{"env":{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"","DISABLE_TELEMETRY":""}}' > $W/traffic.json
start "$OUTSIDE -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC CLAUDE_CONFIG_DIR=$HOME/.claude-pi claude-tsp --model haiku --permission-mode default --settings $W/traffic.json"
cmd /permissions 4; ctl key ctrl+n >/dev/null; sleep 2; ctl type '"Bash(ctsp-verify-rule:*)"' >/dev/null; ctl key Enter >/dev/null; sleep 2
seen "a new permission rule asks where to be saved" "Local settings (this project, only you)"
ctl key Enter >/dev/null; sleep 1
grep -q 'Bash(ctsp-verify-rule:\*)' $DEMO/.claude/settings.local.json 2>/dev/null && ok "the rule is written to the settings file" 1 || ok "the rule is written to the settings file" 0
seen "Claude Code lists the new rule" "Bash(ctsp-verify-rule:*)" 20
ctl type '"ctsp-verify-rule"' >/dev/null; sleep 1; ctl key ctrl+d >/dev/null; sleep 2
grep -q 'ctsp-verify-rule' $DEMO/.claude/settings.local.json 2>/dev/null && ok "Ctrl+D removes the rule from the file" 0 || ok "Ctrl+D removes the rule from the file" 1
sleep 3; ctl key Escape >/dev/null; sleep 1
cmd "The secret word is PELICAN. Reply with OK only." 3; idle 40
cmd "/subtask Reply with the secret word from this conversation, in capitals, and nothing else." 3
n=0; st=0; while [ $n -lt 90 ]; do ctl tree '[data-role="omp.user"]' 2>/dev/null | grep -q "Result of the subtask" && { st=1; break; }; sleep 1; n=$((n+1)); done
ok "/subtask forks the conversation and its result comes back" $st
idle 40
cmd /background 3; ctl key Enter >/dev/null
n=0; BGID=""; while [ $n -lt 60 ] && [ -z "$BGID" ]; do BGID=$(ctl tree 2>/dev/null | grep -o 'claude attach [a-z0-9]*' | head -1 | awk '{print $3}'); sleep 1; n=$((n+1)); done
[ -n "$BGID" ] && CLAUDE_CONFIG_DIR=$HOME/.claude-pi $OUTSIDE claude agents --json 2>/dev/null | grep -q "\"id\": \"$BGID\"" && ok "/background hands the session to Claude Code's background service and starts a new one" 1 || ok "/background hands the session to Claude Code's background service and starts a new one" 0
[ -n "$BGID" ] && { CLAUDE_CONFIG_DIR=$HOME/.claude-pi $OUTSIDE claude stop $BGID >/dev/null 2>&1; CLAUDE_CONFIG_DIR=$HOME/.claude-pi $OUTSIDE claude rm $BGID >/dev/null 2>&1; }
until_ '[data-role="omp.composer.model"]' 30; sleep 3
cmd "/feedback a claude-tsp verification report, saved on this machine only"
ctl key ctrl+Enter >/dev/null
seen "/feedback asks where the report goes before anything is sent" "Save on this machine only"
ctl key Down >/dev/null; ctl key Enter >/dev/null
seen "a report saved locally is written by Claude Code and nothing is sent" "Feedback report saved to" 40
for z in $(ctl tree 2>/dev/null | grep -oE '/[^" ]*feedback-bundles/[A-Za-z0-9._-]+\.zip' | sort -u); do rm -f "$z"; done
cmd /remote-control 1
seen "/remote-control turns it on and gives the session's link" "https://claude.ai/code/session_" 40
ctl tree 2>/dev/null | grep -qF "Remote control is on" && ok "the sheet says remote control is on, with Disconnect" 1 || ok "the sheet says remote control is on, with Disconnect" 0
ctl key Escape >/dev/null; sleep 1
cmd "/remote-control off" 5
ctl key ctrl+u >/dev/null; ctl type '"/remote-c"' >/dev/null; sleep 2
ctl tree 2>/dev/null | grep -qF '"text":"on"' && ok "/remote-control off disconnects" 0 || ok "/remote-control off disconnects" 1
ctl key Escape >/dev/null; ctl key ctrl+u >/dev/null; sleep 1
}

s_plugins() {
PLUG=$W/plug; MARKET=$W/market; mkdir -p $PLUG $MARKET/.claude-plugin; cp -r test/fixtures/widget-plugin $MARKET/widget-plugin
echo '{ "name": "ctsp-verify-market", "owner": { "name": "claude-tsp tests" }, "plugins": [ { "name": "tsp-widget", "source": "./widget-plugin", "description": "A band, a pane and a notification for testing a host" } ] }' > $MARKET/.claude-plugin/marketplace.json
installed() { CLAUDE_CONFIG_DIR=$PLUG $OUTSIDE claude plugin list --json 2>/dev/null | tr -d '\n '; }
start "$OUTSIDE CLAUDE_CONFIG_DIR=$PLUG claude-tsp"
cmd /plugin 4; ctl key ctrl+n >/dev/null; sleep 2; ctl type "\"$MARKET\"" >/dev/null; ctl key Enter >/dev/null
n=0; while [ $n -lt 30 ] && [ ! -e $PLUG/plugins/known_marketplaces.json ] ; do sleep 1; n=$((n+1)); done; sleep 8
grep -q "ctsp-verify-market" $PLUG/plugins/known_marketplaces.json 2>/dev/null && ok "Add marketplace adds one from the picker" 1 || ok "Add marketplace adds one from the picker" 0
ctl key Tab >/dev/null; sleep 1; ctl type '"tsp-widget"' >/dev/null; sleep 2; ctl key ctrl+o >/dev/null
n=0; while [ $n -lt 40 ]; do case "$(installed)" in *tsp-widget@ctsp-verify-market*) break ;; esac; sleep 1; n=$((n+1)); done
case "$(installed)" in *tsp-widget@ctsp-verify-market*) ok "Ctrl+O installs the chosen plugin" 1 ;; *) ok "Ctrl+O installs the chosen plugin" 0 "$(installed | cut -c1-120)" ;; esac
ctl key Escape >/dev/null; ctl key Escape >/dev/null; sleep 1
cmd /plugin 6; ctl type '"tsp-widget"' >/dev/null; sleep 2
seen "the installed plugin is listed under Yours" "@ctsp-verify-market"
ctl key ctrl+d >/dev/null
n=0; while [ $n -lt 40 ]; do case "$(installed)" in *tsp-widget*) sleep 1; n=$((n+1)) ;; *) break ;; esac; done
case "$(installed)" in *tsp-widget*) ok "Ctrl+D uninstalls it" 0 ;; *) ok "Ctrl+D uninstalls it" 1 ;; esac
ctl key Escape >/dev/null; ctl key Escape >/dev/null; sleep 2
cmd /setup-vertex 3; ctl key Enter >/dev/null; sleep 2; ctl type '"my-project"' >/dev/null; ctl key Enter >/dev/null; sleep 2; ctl type '"global"' >/dev/null; ctl key Enter >/dev/null; sleep 2; ctl key Enter >/dev/null; sleep 8
grep -q '"CLAUDE_CODE_USE_VERTEX": "1"' $PLUG/settings.json 2>/dev/null && grep -q '"ANTHROPIC_VERTEX_PROJECT_ID": "my-project"' $PLUG/settings.json && ok "/setup-vertex writes the provider to the user's settings" 1 || ok "/setup-vertex writes the provider to the user's settings" 0
until_ '[data-role="omp.composer.model"]' 30; sleep 2
cmd /setup-bedrock 3; ctl key Enter >/dev/null; sleep 2; ctl type '"us-west-2"' >/dev/null; ctl key Enter >/dev/null; sleep 2; ctl key Enter >/dev/null; sleep 2; ctl key Enter >/dev/null; sleep 8
grep -q '"CLAUDE_CODE_USE_BEDROCK": "1"' $PLUG/settings.json 2>/dev/null && ! grep -q "USE_VERTEX" $PLUG/settings.json && ok "/setup-bedrock replaces it: one provider at a time" 1 || ok "/setup-bedrock replaces it: one provider at a time" 0
}

s_update() {
# A release feed of its own, so the check never depends on what GitHub has.
FEED=$W/feed; mkdir -p $FEED
printf '[{"tag_name":"v99.0.0","html_url":"https://example.invalid/v99.0.0","published_at":"2030-01-01T00:00:00Z","body":"## [99.0.0]\\n\\n### Added\\n- A verify-only release.","assets":[]}]' > $FEED/releases.json
( cd $FEED && exec python3 -m http.server 18532 --bind 127.0.0.1 >/dev/null 2>&1 ) & FEEDPID=$!
start "CLAUDE_TSP_NO_UPDATE_CHECK=0 CLAUDE_TSP_RELEASES_URL=http://127.0.0.1:18532/releases.json $OUTSIDE claude-pi-tsp --model claude-haiku-4-5 --permission-mode default"
until_ '[data-role="claude.status.update"]' 20
says "a newer release shows among the composer's facts" '[data-role="claude.status.update"]' "99.0.0"
cmd /update 4
seen "/update shows what the release changes" "A verify-only release"
seen "/update says it is the surface it updates, not Claude Code" "not Claude Code"
press "Skip this version"; sleep 2
hasnt "a skipped version is not offered again" '[data-role="claude.status.update"]'
cmd /doctor 6
press "Check the surface"
seen "/doctor's check of the surface passes on this Claude Code" "checks passed." 90
ctl key Escape >/dev/null; sleep 1
ctl split right >/dev/null; sleep 2
[ "$(ctl dump '[data-role="omp.composer.effort"]' 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["elements"][0]["opacity"])
except Exception: print("")')" = "0" ] && ok "an unfocused pane folds the composer and Claude's chips fade with it" 1 || ok "an unfocused pane folds the composer and Claude's chips fade with it" 0
kill $FEEDPID 2>/dev/null
$OUTSIDE node bin/claude-tsp --check-compat > $W/compat.txt 2>&1 && ok "claude-tsp --check-compat passes from a shell" 1 || ok "claude-tsp --check-compat passes from a shell" 0 "$(tail -3 $W/compat.txt | tr '\n' ' ')"
rm -f $W/compat.txt
}

# One section, in this process: its own Tern (v-NAME), folders under /tmp/ctsp-verify/NAME, and state.
# The sessions' temporary files go there too, so nothing is left in /tmp when Tern is told to quit.
one() {
  NAME=$1; S=v-$NAME; W=/tmp/ctsp-verify/$NAME; DEMO=$W/demo; OTHER=$W/other; TSPHOME=$W/home; TRACE=$W/trace
  rm -rf "$W"; mkdir -p $DEMO $OTHER $TSPHOME $W/tmp; printf 'def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n' > $DEMO/calc.py
  trap 'exit 130' INT TERM; trap finish EXIT
  echo "== $NAME: $(about $NAME)"
  "s_$NAME"
  [ -s $TRACE ] && ok "no TSP errors ($NAME)" 0 "$(head -c 300 $TRACE)" || ok "no TSP errors ($NAME)" 1
  echo "$pass passed, $fail failed, ${SECONDS}s"
  tell "$pass passed, $fail failed, ${SECONDS}s"
}
finish() {
  "$D/serve.sh" stop $S; kill $(jobs -p) 2>/dev/null; rm -f /tmp/ctsp-$S.log /tmp/ctsp-$S.sock
  rm -rf "$W" "$HOME/.claude/projects/-tmp-ctsp-verify-$NAME-demo" "$HOME/.claude/projects/-tmp-ctsp-verify-$NAME-other"
  rmdir /tmp/ctsp-verify 2>/dev/null; return 0
}

JOBS=4; names=""
while [ $# -gt 0 ]; do case "$1" in
  --list) for n in $SECTIONS; do printf '%-8s %s\n' "$n" "$(about $n)"; done; exit 0 ;;
  --one) about "$2" >/dev/null || { echo "no section named $2" >&2; exit 2; }; one "$2"; exit 0 ;;
  -j) JOBS=$2; shift 2 ;;
  -j*) JOBS=${1#-j}; shift ;;
  *) about "$1" >/dev/null || { echo "no section named $1 (tools/verify.sh --list)" >&2; exit 2; }; names="$names $1"; shift ;;
esac; done
[ -n "$names" ] || names=$SECTIONS
LOGS=$D/out/verify; rm -rf $LOGS; mkdir -p $LOGS
trap 'kill $(jobs -p) 2>/dev/null; wait; exit 130' INT TERM
for n in $LONGEST_FIRST; do
  case " $names " in *" $n "*) ;; *) continue ;; esac
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
  VERIFY_TELL=1 "$SELF" --one $n 3>&2 > $LOGS/$n.log 2>&1 &
done
wait
pass=0; fail=0; dead=""
for n in $SECTIONS; do
  case " $names " in *" $n "*) ;; *) continue ;; esac
  sum="$(grep -E '^[0-9]+ passed, [0-9]+ failed, [0-9]+s$' $LOGS/$n.log | tail -1)"
  grep -vE '^[0-9]+ passed, [0-9]+ failed, [0-9]+s$' $LOGS/$n.log
  # A section that ended without its count did not finish: that is a failure, not a shorter run.
  if [ -z "$sum" ]; then dead="$dead $n"; echo "FAIL  the $n section stopped before its end"; continue; fi
  set -- $sum; pass=$((pass+$1)); fail=$((fail+$3))
done
echo; echo "$pass passed, $fail failed${dead:+, did not finish:$dead}"
[ "$fail" -eq 0 ] && [ -z "$dead" ]
