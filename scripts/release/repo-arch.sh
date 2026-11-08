#!/usr/bin/env bash
# Inside an Arch container: sign the packages and build the signed pacman database in /repo.
set -euo pipefail
cd /repo

for pkg in *.pkg.tar.zst; do
  gpg --batch --yes --default-key "$SIGNING_FINGERPRINT" --detach-sign -o "$pkg.sig" "$pkg"
done

repo-add --sign --key "$SIGNING_FINGERPRINT" "$REPO_NAME.db.tar.gz" ./*.pkg.tar.zst

# repo-add leaves symlinks; a static host needs the real files under the names pacman asks for.
for link in "$REPO_NAME.db" "$REPO_NAME.db.sig" "$REPO_NAME.files" "$REPO_NAME.files.sig"; do
  target=$(readlink "$link")
  rm "$link"
  cp "$target" "$link"
done
rm -f ./*.old ./*.old.sig
chown -R "$OWNER" /repo
