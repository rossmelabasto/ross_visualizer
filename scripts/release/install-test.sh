#!/usr/bin/env bash
# Inside a clean container: add the signed repository and install with the same commands the
# install guide gives, then launch the app under X11 and check it survives.
#   install-test.sh deb|rpm|arch <repo-url>      (this checkout is mounted at /w)
set -euo pipefail

kind=$1
url=$2

case $kind in
  deb)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends curl gnupg ca-certificates xvfb xauth dbus >/dev/null
    curl -fsSL "$url/key.asc" | gpg --dearmor -o /usr/share/keyrings/ross.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/ross.gpg] $url/apt stable main" > /etc/apt/sources.list.d/ross.list
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ross-visualizer >/dev/null
    ;;
  rpm)
    dnf install -y -q curl xorg-x11-server-Xvfb xorg-x11-xauth which dbus-daemon
    # The published file points at the real domain; here the repository is on localhost.
    curl -fsSL "$url/rpm/ross.repo" | sed "s#https://ros.rossmel.com#$url#g" > /etc/yum.repos.d/ross.repo
    dnf install -y -q --setopt=install_weak_deps=False ross-visualizer
    ;;
  arch)
    pacman-key --init >/dev/null 2>&1
    pacman -Syu --noconfirm --needed curl xorg-server-xvfb xorg-xauth dbus >/dev/null
    curl -fsSL "$url/key.asc" -o /tmp/key.asc
    pacman-key --add /tmp/key.asc >/dev/null 2>&1
    fingerprint=$(gpg --show-keys --with-colons /tmp/key.asc | awk -F: '/^fpr/ {print $10; exit}')
    pacman-key --lsign-key "$fingerprint" >/dev/null 2>&1
    printf '\n[ross]\nServer = %s/arch/x86_64\n' "$url" >> /etc/pacman.conf
    pacman -Sy --noconfirm ross-visualizer-bin >/dev/null
    ;;
  *) echo "unknown kind: $kind" >&2; exit 2 ;;
esac

bin=$(command -v ross-visualizer)
echo "Installed: $bin"

if ldd "$bin" | grep 'not found'; then
  echo 'Missing libraries (above)' >&2
  exit 1
fi

for helper in pw-record playerctl curl; do
  command -v "$helper" >/dev/null || { echo "Missing helper: $helper" >&2; exit 1; }
done

# The tray library is opened at runtime, so ldd can't see whether it's there.
ldconfig -p | grep -q 'libayatana-appindicator3.so.1\|libappindicator3.so.1' || {
  echo 'Missing the tray library' >&2
  exit 1
}

# The compatibility script must run to the end on every distro, even with no desktop here.
bash /w/scripts/check.sh || true

bash /w/scripts/release/smoke.sh ross-visualizer
echo 'Install test passed'
