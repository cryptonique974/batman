#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Building TypeScript..."
npm run build

echo "Rebuilding agent container..."
./container/build.sh

echo "Clearing stale agent-runner sources..."
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && rm -rf "$dir" && echo "  Cleared: $dir"
done

echo "Restarting service..."
bash batman_restart.sh

echo "Done."
