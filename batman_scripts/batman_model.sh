#!/bin/bash
# List groups and their configured model (no args), or update a group's model.
#
# Usage:
#   ./batman_model.sh                              # list all groups + model
#   ./batman_model.sh <folder> claude              # set group to Claude
#   ./batman_model.sh <folder> ollama <model>      # set group to Ollama + model
#
# Examples:
#   ./batman_model.sh whatsapp_family-chat ollama llama3.2
#   ./batman_model.sh whatsapp_family-chat claude

DB="store/messages.db"

if [ -z "$1" ]; then
  # List all groups with their model config
  echo "Group                          Provider   Model"
  echo "-----                          --------   -----"
  sqlite3 "$DB" "
    SELECT folder, COALESCE(model_provider, 'claude'), COALESCE(ollama_model, '-')
    FROM registered_groups
    ORDER BY folder;
  " | while IFS='|' read -r folder provider model; do
    printf "%-30s %-10s %s\n" "$folder" "$provider" "$model"
  done
  exit 0
fi

# Update mode
FOLDER="$1"
PROVIDER="$2"

if [ -z "$PROVIDER" ]; then
  echo "Error: provider required (claude or ollama)"
  echo "Usage: $0 <folder> <claude|ollama> [ollama_model]"
  exit 1
fi

if [ "$PROVIDER" != "claude" ] && [ "$PROVIDER" != "ollama" ]; then
  echo "Error: provider must be 'claude' or 'ollama'"
  exit 1
fi

# Verify group exists
EXISTS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM registered_groups WHERE folder='$FOLDER';")
if [ "$EXISTS" -eq 0 ]; then
  echo "Error: group '$FOLDER' not found"
  echo ""
  echo "Available groups:"
  sqlite3 "$DB" "SELECT folder FROM registered_groups ORDER BY folder;" | sed 's/^/  /'
  exit 1
fi

if [ "$PROVIDER" = "claude" ]; then
  sqlite3 "$DB" "UPDATE registered_groups SET model_provider='claude', ollama_model=NULL WHERE folder='$FOLDER';"
  echo "  ✓ $FOLDER → claude"
else
  MODEL="$3"
  if [ -z "$MODEL" ]; then
    echo "Error: ollama model name required (e.g. llama3.2)"
    echo "Usage: $0 <folder> ollama <model>"
    exit 1
  fi
  sqlite3 "$DB" "UPDATE registered_groups SET model_provider='ollama', ollama_model='$MODEL' WHERE folder='$FOLDER';"
  echo "  ✓ $FOLDER → ollama ($MODEL)"
fi

# Restart so the new config is picked up immediately
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
echo "  ✓ Service restarted"
