#!/usr/bin/env bash
# Types a prompt into a served session and sends it. usage: say.sh NAME "text" [wait-seconds] [shot-name]
D="$(dirname "$0")"
"$D/serve.sh" ctl "$1" type "\"$2\"" >/dev/null
"$D/serve.sh" ctl "$1" key Enter >/dev/null
sleep "${3:-6}"
[ -n "${4:-}" ] && "$D/serve.sh" ctl "$1" shot "$4" >/dev/null
true
