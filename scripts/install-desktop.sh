#!/usr/bin/env bash
# Install the desktop app for the current user (Linux): the binary in ~/.local/bin, an icon and
# a launcher entry. Builds the release binary first if it isn't there. A running copy is
# restarted afterwards (with its overlay, if it was on): otherwise the old version keeps
# running, since launching the app again only talks to the instance that's already open.
set -euo pipefail
cd "$(dirname "$0")/.."

bin=src-tauri/target/release/ross-visualizer
[[ -x $bin ]] || npx tauri build --no-bundle

for tool in pw-record playerctl; do
  command -v "$tool" >/dev/null || echo "warning: $tool not found (the app needs it)" >&2
done

running=0
if pgrep -x ross-visualizer >/dev/null; then
  running=1
  "$HOME/.local/bin/ross-visualizer" quit || true
  for _ in $(seq 1 25); do pgrep -x ross-visualizer >/dev/null || break; sleep 0.2; done
fi

install -Dm755 "$bin" "$HOME/.local/bin/ross-visualizer"
install -Dm644 public/icon-512.png "$HOME/.local/share/icons/hicolor/512x512/apps/ross-visualizer.png"
install -Dm644 /dev/stdin "$HOME/.local/share/applications/ross-visualizer.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ross_visualizer
Comment=Music visualizer with a desktop overlay
Exec=$HOME/.local/bin/ross-visualizer
Icon=ross-visualizer
Categories=AudioVideo;Audio;
StartupWMClass=ross-visualizer
EOF

echo "Installed: ~/.local/bin/ross-visualizer"
if ((running)); then
  setsid -f "$HOME/.local/bin/ross-visualizer" restore >/dev/null 2>&1
  echo "Restarted the running app"
fi
echo "Try: ross-visualizer overlay toggle"
