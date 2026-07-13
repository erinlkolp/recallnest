#!/bin/bash
# RecallNest incremental update script — invoked by LaunchAgent
# Only processes new/modified files; already-processed files are skipped automatically
# Timeout guard: runs for at most 2 hours, then auto-kills

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load API key from .env (CLI also reads .env, this is for LaunchAgent)
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/ingest-$(date +%Y-%m-%d).log"

# Timeout (seconds): 2 hours = 7200 seconds
TIMEOUT=7200

echo "=== $(date '+%Y-%m-%d %H:%M:%S') Incremental update started ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR" || exit 1

# Use the timeout command to cap runtime (macOS needs gtimeout, or fall back to perl)
if command -v gtimeout &>/dev/null; then
  gtimeout "$TIMEOUT" bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
elif command -v timeout &>/dev/null; then
  timeout "$TIMEOUT" bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
else
  # macOS has no timeout command; implement it with a background process + kill
  bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1 &
  INGEST_PID=$!

  # Monitor the process
  ELAPSED=0
  while kill -0 "$INGEST_PID" 2>/dev/null; do
    sleep 60
    ELAPSED=$((ELAPSED + 60))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
      echo "⚠️  $(date '+%H:%M:%S') Timed out after ${TIMEOUT}s, force-killing process $INGEST_PID" >> "$LOG_FILE"
      kill "$INGEST_PID" 2>/dev/null
      sleep 5
      kill -9 "$INGEST_PID" 2>/dev/null
      EXIT_CODE=124
      break
    fi
  done

  if [ -z "$EXIT_CODE" ]; then
    wait "$INGEST_PID"
    EXIT_CODE=$?
  fi
fi

if [ "$EXIT_CODE" -eq 124 ]; then
  echo "⚠️  $(date '+%Y-%m-%d %H:%M:%S') Incremental update timed out (${TIMEOUT}s), auto-terminated" >> "$LOG_FILE"
elif [ "$EXIT_CODE" -ne 0 ]; then
  echo "❌  $(date '+%Y-%m-%d %H:%M:%S') Incremental update exited abnormally (exit code: $EXIT_CODE)" >> "$LOG_FILE"
else
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') Incremental update complete ===" >> "$LOG_FILE"
fi

echo "" >> "$LOG_FILE"

# Keep only the last 7 days of logs
find "$LOG_DIR" -name "ingest-*.log" -mtime +7 -delete 2>/dev/null
