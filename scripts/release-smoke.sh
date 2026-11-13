#!/usr/bin/env bash
# Release smoke: pack the package, then prove the TARBALL (not the checkout)
# runs: the bin prints its version; the listener bundle, copied alone into a
# bare directory as the service runs it, stays resident with no config and no
# identity; an npm-installed copy, run through the node_modules/.bin shim the
# way npx does, answers the previous CLI's `install`, reports status, and
# installs and removes a listener service against a sandbox HOME with the
# service manager in dry run. Nothing touches a real service or account.
#
# Run by publish.yml (its `tgz` output is what gets published) and by ci.yml
# on every PR, so it cannot go stale between releases.
set -euo pipefail
# Background jobs get their own process group, and whatever this script
# started is killed on any exit — no listener survives a failed step.
set -m
started_pids=()
cleanup() {
  for pid in "${started_pids[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
workspace="$PWD"
root="${SMOKE_ROOT:-${RUNNER_TEMP:-/tmp}/smoke}"
rm -rf "$root"
mkdir -p "$root/verify" "$root/npxlike" "$root/locks"
# Every listener here takes its agent lock (one agent, one listener) in a
# folder of this smoke's own, never the user's.
export AGENTCHAT_LOCK_DIR="$root/locks"

tgz="$(npm pack --ignore-scripts --pack-destination "$root/verify" | tail -1)"
echo "packed: $tgz"
tar xzf "$root/verify/$tgz" -C "$root/verify"
echo "--- tarball contents ---"
(cd "$root/verify/package" && find . -type f | sed 's|^\./|  |' | sort)
for file in dist/cli.js dist/listener-daemon.js; do
  test -f "$root/verify/package/$file" || { echo "::error::the tarball is missing $file"; exit 1; }
done

expected="$(node -p "require('./package.json').version")"
bare="$root/bare"; mkdir -p "$bare"
cp "$root/verify/package/dist/cli.js" "$root/verify/package/dist/listener-daemon.js" "$bare/"
cli_out="$(cd "$bare" && node cli.js --version 2>&1 || true)"
echo "--- cli --version (bare directory): $cli_out"
case "$cli_out" in
  *"Cannot find module"*|*"ERR_MODULE_NOT_FOUND"*|*"Dynamic require"*) echo "::error::the CLI is not self-contained"; exit 1 ;;
esac
[ "$cli_out" = "$expected" ] || { echo "::error::--version printed '$cli_out', expected '$expected'"; exit 1; }

# The listener, alone, as the service runs it: resident, waiting for listener.json.
lhome="$(mktemp -d)"; llog="$root/listener.log"
# node itself is the job (no subshell between), so its pid is the group's.
node "$bare/listener-daemon.js" --home "$lhome" >"$llog" 2>&1 &
lpid=$!
started_pids+=("$lpid")
sleep 6
alive=0; kill -0 "$lpid" 2>/dev/null && alive=1
kill -TERM -- "-$lpid" 2>/dev/null || kill -TERM "$lpid" 2>/dev/null || true
wait "$lpid" 2>/dev/null || true
if kill -0 "$lpid" 2>/dev/null; then echo "::error::the listener outlived its SIGTERM"; exit 1; fi
echo "--- listener ---"; cat "$llog"
[ "$alive" = "1" ] || { echo "::error::the listener exited instead of waiting"; exit 1; }
grep -q "listener resident" "$llog" || { echo "::error::the listener did not come up"; exit 1; }
if grep -qE "Dynamic require|Cannot find module|ERR_MODULE_NOT_FOUND" "$llog"; then echo "::error::the listener is not self-contained"; exit 1; fi

# Installed for real and run through the bin shim npx uses, against a sandbox HOME.
cd "$root/npxlike"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "$root/verify/$tgz" >/dev/null 2>&1
mkdir -p home work
run_cli() {
  env -u AGENTCHAT_API_KEY -u AGENTCHAT_API_BASE -u AGENTCHAT_HOME \
    HOME="$root/npxlike/home" USERPROFILE="$root/npxlike/home" \
    AGENTCHAT_SERVICE_DRY_RUN=1 \
    "$root/npxlike/node_modules/.bin/agentchat" "$@"
}
[ "$(run_cli --version)" = "$expected" ] || { echo "::error::the bin shim does not run the CLI"; exit 1; }

moved="$(run_cli install)"
echo "--- install (the previous CLI's command) ---"; echo "$moved"
echo "$moved" | grep -q "npx -y @agentchatme/claude-code" || { echo "::error::install does not point to the Claude Code integration"; exit 1; }
echo "$moved" | grep -q "npx -y @agentchatme/codex" || { echo "::error::install does not point to the Codex integration"; exit 1; }
[ "$(echo "$moved" | wc -l | tr -d ' ')" = "1" ] || { echo "::error::install must print one line"; exit 1; }

status_out="$(run_cli status 2>&1 || true)"
echo "--- status ---"; echo "$status_out"
echo "$status_out" | grep -q "No AgentChat identity" || { echo "::error::status did not run"; exit 1; }

installed="$(cd work && run_cli listen --run "my-agent --once" --install 2>&1)"
echo "--- listen --install ---"; echo "$installed"
echo "$installed" | grep -q "Listener installed" || { echo "::error::listen --install failed"; exit 1; }
durable="$root/npxlike/home/.agentchat/bin/agentchat-listener.mjs"
test -f "$durable" || { echo "::error::listen --install did not place the durable listener"; exit 1; }
grep -q '"command": "my-agent --once"' "$root/npxlike/home/.agentchat/listener.json" || { echo "::error::listener.json does not carry the command"; exit 1; }

removed="$(run_cli listen --uninstall 2>&1)"
echo "--- listen --uninstall ---"; echo "$removed"
echo "$removed" | grep -q "removed" || { echo "::error::listen --uninstall failed"; exit 1; }
test ! -e "$durable" || { echo "::error::uninstall left the durable listener"; exit 1; }

cd "$workspace"
echo "tgz=$root/verify/$tgz" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "smoke: ok"
