#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <group_folder>"
  exit 1
fi

GROUP="$1"

echo "Clearing session for group: $GROUP"

sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='$GROUP';"
echo "  ✓ DB session deleted"

rm -rf "data/sessions/$GROUP/.claude/projects/" \
       "data/sessions/$GROUP/.claude/backups/" \
       "data/sessions/$GROUP/.claude/plans/"
echo "  ✓ Session files deleted"

CONTAINERS=$(docker ps --filter "name=nanoclaw-$GROUP" -q)
if [ -n "$CONTAINERS" ]; then
  echo "$CONTAINERS" | xargs docker stop
  echo "  ✓ Container(s) stopped: $CONTAINERS"
else
  echo "  ✓ No active container"
fi

launchctl kickstart -k gui/$(id -u)/com.nanoclaw
echo "  ✓ Service restarted"

echo "Done. Next message will start a fresh session."

./batman_restart.sh
