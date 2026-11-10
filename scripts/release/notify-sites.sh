#!/usr/bin/env bash
# Tell the websites that a version was published so they deploy it: push the version to
# sources/ross-visualizer in each site's repo, with that repo's deploy key.
#   repo.rossmel.com  (ross_packages) serves the package repositories and this app's page.
#   ros.rossmel.com   (ross_ros_web)  keeps the old repository paths alive for a while.
#   HUB_DEPLOY_KEY=… ROS_WEB_DEPLOY_KEY=… notify-sites.sh <version>
set -euo pipefail
version=${1:?version}

push() {
  local repo=$1 key=$2 dir keyfile
  if [ -z "$key" ]; then
    echo "::warning::No deploy key for $repo: its site won't update until its daily run"
    return 0
  fi
  dir=$(mktemp -d)
  keyfile=$(mktemp)
  printf '%s\n' "$key" > "$keyfile"
  chmod 600 "$keyfile"
  GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    git clone -q --depth 1 "git@github.com:$repo.git" "$dir"
  mkdir -p "$dir/sources"
  echo "$version" > "$dir/sources/ross-visualizer"
  git -C "$dir" add sources
  # A re-run of the same version still has to trigger a deploy.
  git -C "$dir" -c user.name='ross_visualizer release' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -q --allow-empty -m "ross_visualizer $version"
  GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    git -C "$dir" push -q origin HEAD:main
  rm -rf "$dir" "$keyfile"
  echo "Told $repo about $version"
}

push rossmelabasto/ross_packages "${HUB_DEPLOY_KEY:-}"
push rossmelabasto/ross_ros_web "${ROS_WEB_DEPLOY_KEY:-}"
