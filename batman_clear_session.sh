#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <group_folder>"
  exit 1
fi

GROUP="$1"

echo "Clearing session for group: $GROUP"

launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 
sleep 1 

sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='$GROUP';"
echo "  ✓ DB session deleted"

# Delete session .jsonl files but preserve memory/
find "data/sessions/$GROUP/.claude/projects/" -name "*.jsonl" -delete 2>/dev/null || true
rm -rf "data/sessions/$GROUP/.claude/backups/" \
       "data/sessions/$GROUP/.claude/plans/"
echo "  ✓ Session files deleted (memory preserved)"

CONTAINERS=$(docker ps --filter "name=nanoclaw-$GROUP" -q)
if [ -n "$CONTAINERS" ]; then
  echo "$CONTAINERS" | xargs docker stop
  echo "  ✓ Container(s) stopped: $CONTAINERS"
else
  echo "  ✓ No active container"
fi

launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
echo "  ✓ Service restarted"

echo "Done. Next message will start a fresh session."



