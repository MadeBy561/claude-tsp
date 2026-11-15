#!/usr/bin/env bash
# Headless Tern for one program. usage: serve.sh start NAME CWD "COMMAND" | serve.sh ctl NAME ARGS... | serve.sh stop NAME
set -u
export PATH="$HOME/.local/bin:$PATH"
D="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p $D/shots
cmd=$1; name=$2; shift 2
S=/tmp/ctsp-$name.sock
case $cmd in
  start)
    pkill -f "tern serve --control $S" 2>/dev/null; sleep 0.5
    nohup tern serve --control $S --out $D/shots >/tmp/ctsp-$name.log 2>&1 &
    sleep 3
    timeout 10 tern ctl --control $S size ${SIZE:-1400 900} >/dev/null
    # An isolated state directory, so scripted runs leave no history or settings in the user's own.
    timeout 10 tern ctl --control $S run "\"cd $1 && CLAUDE_TSP_HOME=\${CLAUDE_TSP_HOME:-/tmp/ctsp-home} CLAUDE_TSP_META_AS_CTRL=1 $2\"" >/dev/null ;;
  ctl) timeout ${T:-20} tern ctl --control $S "$@" ;;
  stop) timeout 10 tern ctl --control $S quit >/dev/null 2>&1 ;;
esac
