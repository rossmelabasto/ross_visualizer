#!/usr/bin/env bash
# Install the desktop app for the current user (Linux): the binary in ~/.local/bin, an icon and
# a launcher entry. Builds the release binary first if it isn't there.
set -euo pipefail
cd "$(dirname "$0")/.."

bin=src-tauri/target/release/ross-visualizer
[[ -x $bin ]] || npx tauri build --no-bundle

for tool in pw-record playerctl; do
  command -v "$tool" >/dev/null || echo "warning: $tool not found (the app needs it)" >&2
done

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
echo "Try: ross-visualizer overlay toggle"
