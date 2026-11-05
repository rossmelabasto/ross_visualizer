#!/usr/bin/env bash
# Run an end-to-end script in a separate test build of the desktop app. It has its own
# identifier, so it neither talks to an installed copy that is running nor touches its
# settings. Screenshots are taken (with grim) whenever the script logs "test: shot <name>".
#   scripts/e2e/run.sh [script.js] [output dir]
set -euo pipefail
cd "$(dirname "$0")/../.."
script=${1:-scripts/e2e/overlay-options.js}
out=${2:-/tmp/rv-e2e}
mkdir -p "$out"
id=com.rossmel.visualizer.test
bin=src-tauri/target/debug/ross-visualizer

npx tauri build --debug --no-bundle --config "{\"identifier\":\"$id\"}" >"$out/build.log" 2>&1
rm -rf "$HOME/.config/$id"
RV_DEBUG=1 RV_TEST_SCRIPT=$script "$bin" >"$out/app.log" 2>&1 &

shot=0
for _ in $(seq 1 600); do
  sleep 0.1
  n=$(grep -c "test: shot " "$out/app.log" || true)
  while (( shot < n )); do
    shot=$((shot + 1))
    name=$(grep "test: shot " "$out/app.log" | sed -n "${shot}p" | sed 's/.*test: shot //')
    grim "$out/$name.png"
  done
  grep -q "test: done" "$out/app.log" && break
done
"$bin" quit || true
sleep 1
grep -E "test: |drawing " "$out/app.log" | sed 's/^ross-visualizer: //'
