#!/usr/bin/env bash
# Turn the built packages into signed APT, DNF and pacman repositories.
#   repos.sh <packages-dir> <output-dir>
# Needs GNUPGHOME with the signing key, and SIGNING_FINGERPRINT. The pacman part runs inside an
# Arch container because repo-add only exists there; apt and rpm tools come from the host.
set -euo pipefail

packages=$(realpath "$1")
out=$(realpath -m "$2")
: "${SIGNING_FINGERPRINT:?}"
: "${GNUPGHOME:?}"
here=$(dirname "$(realpath "$0")")
repo_name=ross

rm -rf "$out"
mkdir -p "$out"
gpg --batch --yes --armor --export "$SIGNING_FINGERPRINT" > "$out/key.asc"

# --- APT
mkdir -p "$out/apt/pool/main" "$out/apt/dists/stable/main/binary-amd64"
cp "$packages"/*.deb "$out/apt/pool/main/"
(
  cd "$out/apt"
  dpkg-scanpackages --multiversion pool/main /dev/null > dists/stable/main/binary-amd64/Packages 2>/dev/null
  gzip -9fk dists/stable/main/binary-amd64/Packages
  cd dists/stable
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=ross \
    -o APT::FTPArchive::Release::Label=ross \
    -o APT::FTPArchive::Release::Suite=stable \
    -o APT::FTPArchive::Release::Codename=stable \
    -o APT::FTPArchive::Release::Architectures=amd64 \
    -o APT::FTPArchive::Release::Components=main \
    release . > Release
  gpg --batch --yes --default-key "$SIGNING_FINGERPRINT" --armor --detach-sign -o Release.gpg Release
  gpg --batch --yes --default-key "$SIGNING_FINGERPRINT" --clearsign -o InRelease Release
)

# --- DNF
mkdir -p "$out/rpm"
cp "$packages"/*.rpm "$out/rpm/"
for rpm in "$out"/rpm/*.rpm; do
  rpmsign --define "_gpg_name $SIGNING_FINGERPRINT" --define "_gpg_path $GNUPGHOME" --addsign "$rpm" >/dev/null
done
createrepo_c --quiet "$out/rpm"
gpg --batch --yes --default-key "$SIGNING_FINGERPRINT" --armor --detach-sign -o "$out/rpm/repodata/repomd.xml.asc" "$out/rpm/repodata/repomd.xml"
cat > "$out/rpm/ross.repo" <<EOF
[ross]
name=ross
baseurl=${REPO_URL:-https://repo.rossmel.com}/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=${REPO_URL:-https://repo.rossmel.com}/key.asc
EOF

# --- pacman
mkdir -p "$out/arch/x86_64"
cp "$packages"/*.pkg.tar.zst "$out/arch/x86_64/"
# The container starts its own agent on the shared directory; a running one would get in the way.
gpgconf --kill gpg-agent
docker run --rm \
  -v "$out/arch/x86_64:/repo" -v "$GNUPGHOME:/gnupg" -v "$here/repo-arch.sh:/repo-arch.sh:ro" \
  -e GNUPGHOME=/gnupg -e SIGNING_FINGERPRINT -e REPO_NAME="$repo_name" -e OWNER="$(id -u):$(id -g)" \
  archlinux:base-devel bash /repo-arch.sh

echo "Repositories ready in $out"
