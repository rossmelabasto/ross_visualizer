#!/usr/bin/env bash
# Fill packaging/arch/PKGBUILD for a release.
#   pkgbuild.sh <version> <tarball> <output-dir>
set -euo pipefail

version=$1
tarball=$2
out=$3
root=$(dirname "$(realpath "$0")")/../..

sha=$(sha256sum "$tarball" | cut -d' ' -f1)
mkdir -p "$out"
sed -e "s/@VERSION@/$version/" -e "s/@SHA256@/$sha/" "$root/packaging/arch/PKGBUILD" > "$out/PKGBUILD"
